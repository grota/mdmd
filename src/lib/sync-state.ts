import path from 'node:path'

import {openIndexDb, resolveCollectionId} from './index-db'

export const NOTES_DIR_NAME = 'mdmd_notes'

export type DesiredSymlink = {
  pathInCollection: string
  symlinkName: string
  targetPath: string
}

export function listManagedPathsForCwd(cwd: string, collectionRoot: string): string[] {
  const db = openIndexDb(collectionRoot)

  try {
    const collectionId = resolveCollectionId(db, collectionRoot)
    const rows = db.query(`
        SELECT path_in_collection AS pathInCollection
        FROM index_notes
        WHERE collection_id = ?1
          AND mdmd_id IS NOT NULL
          AND json_extract(frontmatter, '$.path') = ?2
        ORDER BY path_in_collection ASC
      `).all(collectionId, cwd) as Array<{pathInCollection: string}>

    return rows.map((row) => row.pathInCollection)
  } finally {
    db.close()
  }
}

export function buildDesiredSymlinks(collectionRoot: string, pathInCollections: string[]): DesiredSymlink[] {
  const usedSymlinkNames = new Set<string>()
  return pathInCollections.map((pathInCollection) => {
    const symlinkName = resolveSymlinkName(pathInCollection, usedSymlinkNames)
    usedSymlinkNames.add(symlinkName)

    return {
      pathInCollection,
      symlinkName,
      targetPath: toAbsoluteCollectionPath(collectionRoot, pathInCollection),
    }
  })
}

function resolveSymlinkName(pathInCollection: string, usedSymlinkNames: Set<string>): string {
  const pathParts = pathInCollection.split('/')
  const basename = pathParts.at(-1)
  if (!basename) {
    throw new Error(`Invalid path_in_collection: ${pathInCollection}`)
  }

  if (!usedSymlinkNames.has(basename)) {
    return basename
  }

  const parsedName = path.posix.parse(pathInCollection)
  const parentName = path.posix.basename(path.posix.dirname(pathInCollection))
  if (!parentName || parentName === '.' || parentName === '/') {
    throw new Error(`Cannot disambiguate colliding symlink name for ${pathInCollection}`)
  }

  const disambiguatedName = `${parsedName.name}__${parentName}${parsedName.ext}`
  if (usedSymlinkNames.has(disambiguatedName)) {
    throw new Error(`Symlink collision cannot be resolved for ${pathInCollection}`)
  }

  return disambiguatedName
}

function toAbsoluteCollectionPath(collectionRoot: string, pathInCollection: string): string {
  return path.join(collectionRoot, ...pathInCollection.split('/'))
}
