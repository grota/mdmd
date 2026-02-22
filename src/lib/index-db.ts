import {Database} from 'bun:sqlite'
import {mkdirSync} from 'node:fs'
import {homedir} from 'node:os'
import path from 'node:path'

export const INDEX_DB_PATH_ENV_VAR = 'MDMD_INDEX_DB_PATH'
export const XDG_DATA_HOME_ENV_VAR = 'XDG_DATA_HOME'

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

export function openIndexDb(): Database {
  const indexDbPath = getIndexDbPath()
  mkdirSync(path.dirname(indexDbPath), {recursive: true})
  const db = new Database(indexDbPath)
  ensureIndexSchema(db)
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

function ensureIndexSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_notes (
      path_in_collection TEXT NOT NULL PRIMARY KEY,
      mdmd_id TEXT,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      frontmatter TEXT
    );
  `)

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_mdmd_id
    ON index_notes(mdmd_id)
    WHERE mdmd_id IS NOT NULL;
  `)
}

export function findPathByMdmdId(db: Database, mdmdId: string): null | string {
  const row = db
    .query('SELECT path_in_collection FROM index_notes WHERE mdmd_id = ?1')
    .get(mdmdId) as null | {path_in_collection: string}

  return row?.path_in_collection ?? null
}

export function upsertIndexNote(db: Database, note: IndexNote): void {
  db.query(`
      INSERT INTO index_notes (
        path_in_collection,
        mdmd_id,
        mtime,
        size,
        frontmatter
      ) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(path_in_collection) DO UPDATE SET
        mdmd_id = excluded.mdmd_id,
        mtime = excluded.mtime,
        size = excluded.size,
        frontmatter = excluded.frontmatter
    `).run(
    note.pathInCollection,
    note.mdmdId,
    note.mtime,
    note.size,
    JSON.stringify(note.frontmatter),
  )
}

export function listIndexedFileStats(db: Database): IndexedFileStat[] {
  const rows = db.query(`
      SELECT path_in_collection, mtime, size
      FROM index_notes
    `).all() as Array<{mtime: number; path_in_collection: string; size: number}>

  return rows.map((row) => ({
    mtime: row.mtime,
    pathInCollection: row.path_in_collection,
    size: row.size,
  }))
}

export function deleteIndexNoteByPath(db: Database, pathInCollection: string): void {
  db.query('DELETE FROM index_notes WHERE path_in_collection = ?1').run(pathInCollection)
}

export function toCollectionRelativePath(collectionRoot: string, absolutePath: string): string {
  const relativePath = path.relative(collectionRoot, absolutePath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Cannot index path outside collection: ${absolutePath}`)
  }

  return relativePath.split(path.sep).join('/')
}
