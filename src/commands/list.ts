import {Command, Flags} from '@oclif/core'
import path from 'node:path'

import {createMdmdRuntime, readMdmdConfig, resolveCollectionRoot} from '../lib/config'
import {openIndexDb, resolveCollectionId} from '../lib/index-db'
import {refreshIndex} from '../lib/refresh-index'

type ListRow = {
  frontmatterJson: null | string
  mdmdId: null | string
  pathInCollection: string
}

export default class List extends Command {
  static override description = 'List notes associated with the current directory (or the entire collection)'
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --collection-wide',
    '<%= config.bin %> <%= command.id %> --json',
  ]
  static override flags = {
    'all-fields': Flags.boolean({
      description: 'Include full frontmatter in output',
    }),
    collection: Flags.directory({
      char: 'c',
      description: 'Collection root path (highest priority over env/config defaults)',
      exists: true,
    }),
    'collection-wide': Flags.boolean({
      description: 'List all managed notes in the collection, not just those for current directory',
    }),
    json: Flags.boolean({
      description: 'Emit machine-readable JSON',
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(List)
    const runtime = createMdmdRuntime(this.config.configDir)
    const cwd = path.resolve(process.cwd())
    const collectionRoot = await resolveCollectionRoot(flags.collection, runtime)

    await readMdmdConfig(runtime) // ensure config is accessible
    await refreshIndex(collectionRoot)

    const db = openIndexDb(collectionRoot)
    let rows: ListRow[]

    try {
      const collectionId = resolveCollectionId(db, collectionRoot)

      rows = flags['collection-wide']
        ? (db.query(`
          SELECT path_in_collection AS pathInCollection,
                 mdmd_id AS mdmdId,
                 frontmatter AS frontmatterJson
          FROM index_notes
          WHERE collection_id = ?1
            AND mdmd_id IS NOT NULL
          ORDER BY path_in_collection ASC
        `).all(collectionId) as ListRow[])
        : (db.query(`
          SELECT n.path_in_collection AS pathInCollection,
                 n.mdmd_id AS mdmdId,
                 n.frontmatter AS frontmatterJson
          FROM index_notes n
          WHERE n.collection_id = ?1
            AND n.mdmd_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM json_each(json_extract(n.frontmatter, '$.paths'))
              WHERE value = ?2
            )
          ORDER BY n.path_in_collection ASC
        `).all(collectionId, cwd) as ListRow[])
    } finally {
      db.close()
    }

    if (flags.json) {
      const output = rows.map((row) => {
        const fm = row.frontmatterJson ? (JSON.parse(row.frontmatterJson) as Record<string, unknown>) : {}
        return {
          // eslint-disable-next-line camelcase
          mdmd_id: row.mdmdId,
          // eslint-disable-next-line camelcase
          path_in_collection: row.pathInCollection,
          ...fm,
        }
      })
      this.log(JSON.stringify(output, null, 2))
      return
    }

    if (rows.length === 0) {
      this.log(flags['collection-wide'] ? 'No managed notes in collection.' : 'No notes linked to this directory.')
      return
    }

    for (const row of rows) {
      const fm = row.frontmatterJson ? (JSON.parse(row.frontmatterJson) as Record<string, unknown>) : {}
      const allPaths = Array.isArray(fm.paths) ? (fm.paths as string[]) : []
      const otherPaths = allPaths.filter((p) => p !== cwd)
      const basename = path.posix.basename(row.pathInCollection)

      let line = basename
      if (flags['all-fields']) {
        line = `${row.pathInCollection}  ${JSON.stringify(fm)}`
      } else if (otherPaths.length > 0) {
        line = `${basename}  (also linked from: ${otherPaths.join(', ')})`
      }

      this.log(line)
    }
  }
}
