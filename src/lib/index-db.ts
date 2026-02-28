import {Database} from 'bun:sqlite'
import {mkdirSync} from 'node:fs'
import {homedir} from 'node:os'
import path from 'node:path'

export const INDEX_DB_PATH_ENV_VAR = 'MDMD_INDEX_DB_PATH'
export const XDG_DATA_HOME_ENV_VAR = 'XDG_DATA_HOME'
const LEGACY_COLLECTION_ROOT = '/__mdmd_legacy_collection__'

export type IndexNote = {
  frontmatter: Record<string, unknown>
  mdmdId: null | string
  mtime: number
  pathInCollection: string
  size: number
}

export type IndexedFileStat = {
  mtime: number
  pathInCollection: string
  size: number
}

export function openIndexDb(collectionRootForMigration?: string): Database {
  const indexDbPath = getIndexDbPath()
  mkdirSync(path.dirname(indexDbPath), {recursive: true})
  const db = new Database(indexDbPath)
  ensureIndexSchema(db, collectionRootForMigration)
  return db
}

export function getIndexDbPath(): string {
  const override = process.env[INDEX_DB_PATH_ENV_VAR]
  if (override && override.trim().length > 0) {
    return path.resolve(override)
  }

  const xdgDataHome = process.env[XDG_DATA_HOME_ENV_VAR]
  const dataHome = xdgDataHome && xdgDataHome.trim().length > 0 ? path.resolve(xdgDataHome) : path.join(homedir(), '.local', 'share')
  return path.join(dataHome, 'mdmd', 'index.db')
}

function ensureIndexSchema(db: Database, collectionRootForMigration?: string): void {
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS collections (
      collection_id INTEGER PRIMARY KEY,
      root TEXT NOT NULL UNIQUE
    );
  `)

  const columns = db.query('PRAGMA table_info(index_notes)').all() as Array<{name: string}>
  if (columns.length === 0) {
    createIndexNotesTable(db)
  } else if (!columns.some((column) => column.name === 'collection_id')) {
    migrateLegacyIndexNotesSchema(db, collectionRootForMigration)
  }

  db.exec('DROP INDEX IF EXISTS idx_notes_mdmd_id;')
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_collection_mdmd_id
    ON index_notes(collection_id, mdmd_id)
    WHERE mdmd_id IS NOT NULL;
  `)
}

function createIndexNotesTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_notes (
      collection_id INTEGER NOT NULL,
      path_in_collection TEXT NOT NULL,
      mdmd_id TEXT,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      frontmatter TEXT,
      PRIMARY KEY (collection_id, path_in_collection),
      FOREIGN KEY (collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE
    );
  `)
}

function migrateLegacyIndexNotesSchema(db: Database, collectionRootForMigration?: string): void {
  const collectionId = resolveCollectionId(db, collectionRootForMigration ?? LEGACY_COLLECTION_ROOT)
  const transaction = db.transaction((resolvedCollectionId: number) => {
    db.exec(`
      CREATE TABLE index_notes_next (
        collection_id INTEGER NOT NULL,
        path_in_collection TEXT NOT NULL,
        mdmd_id TEXT,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        frontmatter TEXT,
        PRIMARY KEY (collection_id, path_in_collection),
        FOREIGN KEY (collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE
      );
    `)

    db.query(`
      INSERT INTO index_notes_next (
        collection_id,
        path_in_collection,
        mdmd_id,
        mtime,
        size,
        frontmatter
      )
      SELECT
        ?1,
        path_in_collection,
        mdmd_id,
        mtime,
        size,
        frontmatter
      FROM index_notes;
    `).run(resolvedCollectionId)

    db.exec('DROP TABLE index_notes;')
    db.exec('ALTER TABLE index_notes_next RENAME TO index_notes;')
  })

  transaction(collectionId)
}

export function resolveCollectionId(db: Database, collectionRoot: string): number {
  const resolvedRoot = path.resolve(collectionRoot)
  db.query(`
    INSERT INTO collections (root)
    VALUES (?1)
    ON CONFLICT(root) DO NOTHING;
  `).run(resolvedRoot)

  const row = db.query(`
      SELECT collection_id AS collectionId
      FROM collections
      WHERE root = ?1
    `).get(resolvedRoot) as null | {collectionId: number}

  if (!row) {
    throw new Error(`Could not resolve collection id for root: ${resolvedRoot}`)
  }

  return row.collectionId
}

export function findPathByMdmdId(db: Database, collectionId: number, mdmdId: string): null | string {
  const row = db
    .query('SELECT path_in_collection FROM index_notes WHERE collection_id = ?1 AND mdmd_id = ?2')
    .get(collectionId, mdmdId) as null | {path_in_collection: string}

  return row?.path_in_collection ?? null
}

export function upsertIndexNote(db: Database, collectionId: number, note: IndexNote): void {
  db.query(`
      INSERT INTO index_notes (
        collection_id,
        path_in_collection,
        mdmd_id,
        mtime,
        size,
        frontmatter
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(collection_id, path_in_collection) DO UPDATE SET
        mdmd_id = excluded.mdmd_id,
        mtime = excluded.mtime,
        size = excluded.size,
        frontmatter = excluded.frontmatter
    `).run(
    collectionId,
    note.pathInCollection,
    note.mdmdId,
    note.mtime,
    note.size,
    JSON.stringify(note.frontmatter),
  )
}

export function listIndexedFileStats(db: Database, collectionId: number): IndexedFileStat[] {
  const rows = db.query(`
      SELECT path_in_collection, mtime, size
      FROM index_notes
      WHERE collection_id = ?1
    `).all(collectionId) as Array<{mtime: number; path_in_collection: string; size: number}>

  return rows.map((row) => ({
    mtime: row.mtime,
    pathInCollection: row.path_in_collection,
    size: row.size,
  }))
}

export function deleteIndexNoteByPath(db: Database, collectionId: number, pathInCollection: string): void {
  db.query('DELETE FROM index_notes WHERE collection_id = ?1 AND path_in_collection = ?2').run(collectionId, pathInCollection)
}

export function toCollectionRelativePath(collectionRoot: string, absolutePath: string): string {
  const relativePath = path.relative(collectionRoot, absolutePath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Cannot index path outside collection: ${absolutePath}`)
  }

  return relativePath.split(path.sep).join('/')
}
