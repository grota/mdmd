import {readdir, readFile} from 'node:fs/promises'
import path from 'node:path'

import type {ManagedFilter, NoteRow, Scope} from '../types.js'

import {parseFrontmatter} from '../../lib/frontmatter.js'
import {openIndexDb, resolveCollectionId} from '../../lib/index-db.js'
import {refreshIndex} from '../../lib/refresh-index.js'

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  async function walk(current: string): Promise<string[]> {
    let entries
    try {
      entries = await readdir(current, {withFileTypes: true})
    } catch {
      return []
    }

    const results = await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) return walk(full)
        if (entry.isFile() && entry.name.endsWith('.md')) return [full]
        return []
      }),
    )
    return results.flat()
  }

  return walk(dir)
}

async function scanDirectory(
  scanRoot: string,
  collectionRoot: string,
): Promise<NoteRow[]> {
  const db = openIndexDb(collectionRoot)
  const collectionId = resolveCollectionId(db, collectionRoot)
  // Build a map of absolutePath -> index row for cross-referencing
  const indexed = new Map<string, {frontmatterJson: null | string; mdmdId: null | string; pathInCollection: string}>()
  try {
    const rows = db
      .query(
        `SELECT path_in_collection AS pathInCollection, mdmd_id AS mdmdId, frontmatter AS frontmatterJson
         FROM index_notes WHERE collection_id = ?1`,
      )
      .all(collectionId) as Array<{frontmatterJson: null | string; mdmdId: null | string; pathInCollection: string}>
    for (const row of rows) {
      const abs = path.join(collectionRoot, ...row.pathInCollection.split('/'))
      indexed.set(abs, row)
    }
  } finally {
    db.close()
  }

  const files = await collectMarkdownFiles(scanRoot)
  return Promise.all(
    files.map(async (absPath) => {
      const indexedRow = indexed.get(absPath)
      if (indexedRow) {
        return {
          absolutePath: absPath,
          frontmatter: indexedRow.frontmatterJson ? (JSON.parse(indexedRow.frontmatterJson) as Record<string, unknown>) : {},
          frontmatterJson: indexedRow.frontmatterJson,
          managed: true,
          mdmdId: indexedRow.mdmdId,
          pathInCollection: indexedRow.pathInCollection,
        } satisfies NoteRow
      }

      let frontmatter: Record<string, unknown> = {}
      try {
        const contents = await readFile(absPath, 'utf8')
        frontmatter = parseFrontmatter(contents).frontmatter as Record<string, unknown>
      } catch {
        // skip unreadable
      }

      return {
        absolutePath: absPath,
        frontmatter,
        frontmatterJson: null,
        managed: false,
        mdmdId: null,
        pathInCollection: null,
      } satisfies NoteRow
    }),
  )
}

export async function loadNotes(
  collectionRoot: string,
  cwd: string,
  scope: Scope,
  managedFilter: ManagedFilter,
): Promise<NoteRow[]> {
  await refreshIndex(collectionRoot)

  if (managedFilter === 'all') {
    const scanRoot = scope === 'collection' ? collectionRoot : cwd
    const all = await scanDirectory(scanRoot, collectionRoot)
    return all
  }

  // managed only
  const db = openIndexDb(collectionRoot)
  try {
    const collectionId = resolveCollectionId(db, collectionRoot)
    let sql: string
    let params: (number | string)[]
    if (scope === 'collection') {
      sql = `
        SELECT path_in_collection AS pathInCollection,
               mdmd_id AS mdmdId,
               frontmatter AS frontmatterJson
        FROM index_notes
        WHERE collection_id = ?1
          AND mdmd_id IS NOT NULL
        ORDER BY path_in_collection ASC`
      params = [collectionId]
    } else {
      sql = `
        SELECT path_in_collection AS pathInCollection,
               mdmd_id AS mdmdId,
               frontmatter AS frontmatterJson
        FROM index_notes
        WHERE collection_id = ?1
          AND mdmd_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM json_each(json_extract(frontmatter, '$.paths'))
            WHERE value = ?2
          )
        ORDER BY path_in_collection ASC`
      params = [collectionId, cwd]
    }

    const rows = db.query(sql).all(...params) as Array<{
      frontmatterJson: null | string
      mdmdId: null | string
      pathInCollection: string
    }>
    return rows.map((r) => ({
      absolutePath: path.join(collectionRoot, ...r.pathInCollection.split('/')),
      frontmatter: r.frontmatterJson ? (JSON.parse(r.frontmatterJson) as Record<string, unknown>) : {},
      frontmatterJson: r.frontmatterJson,
      managed: true,
      mdmdId: r.mdmdId,
      pathInCollection: r.pathInCollection,
    }))
  } finally {
    db.close()
  }
}
