import {lstat, readdir, readFile, stat} from 'node:fs/promises'
import path from 'node:path'

import {parseFrontmatter} from './frontmatter'
import {
  deleteIndexNoteByPath,
  type IndexedFileStat,
  type IndexNote,
  listIndexedFileStats,
  openIndexDb,
  toCollectionRelativePath,
  upsertIndexNote,
} from './index-db'

export type CollectionFileSnapshot = {
  absolutePath: string
  mtime: number
  pathInCollection: string
  size: number
}

export type RefreshIndexResult = {
  deleted: number
  refreshed: number
  scanned: number
  unchanged: number
}

export async function refreshIndex(collectionRoot: string): Promise<RefreshIndexResult> {
  const resolvedCollectionRoot = path.resolve(collectionRoot)
  await assertExistingDirectory(resolvedCollectionRoot)

  const collectionFiles = await scanCollectionMarkdownFiles(resolvedCollectionRoot)
  const collectionFilesByPath = new Map(collectionFiles.map((file) => [file.pathInCollection, file]))

  const db = openIndexDb()
  try {
    const indexedFiles = listIndexedFileStats(db)
    const indexedFilesByPath = new Map(indexedFiles.map((file) => [file.pathInCollection, file]))

    const pathsToDelete = indexedFiles
      .filter((indexedFile) => !collectionFilesByPath.has(indexedFile.pathInCollection))
      .map((indexedFile) => indexedFile.pathInCollection)

    const filesToRefresh = collectionFiles.filter((collectionFile) =>
      shouldRefreshFile(indexedFilesByPath.get(collectionFile.pathInCollection), collectionFile),
    )

    const notesToUpsert = await Promise.all(filesToRefresh.map(async (file) => toIndexNote(file)))

    const transaction = db.transaction((paths: string[], notes: IndexNote[]) => {
      for (const pathInCollection of paths) {
        deleteIndexNoteByPath(db, pathInCollection)
      }

      for (const note of notes) {
        upsertIndexNote(db, note)
      }
    })

    transaction(pathsToDelete, notesToUpsert)

    return {
      deleted: pathsToDelete.length,
      refreshed: notesToUpsert.length,
      scanned: collectionFiles.length,
      unchanged: collectionFiles.length - notesToUpsert.length,
    }
  } finally {
    db.close()
  }
}

function shouldRefreshFile(existingFile: IndexedFileStat | undefined, nextFile: CollectionFileSnapshot): boolean {
  if (!existingFile) {
    return true
  }

  return existingFile.mtime !== nextFile.mtime || existingFile.size !== nextFile.size
}

async function toIndexNote(file: CollectionFileSnapshot): Promise<IndexNote> {
  const contents = await readFile(file.absolutePath, 'utf8')
  const {frontmatter} = parseFrontmatter(contents)

  const rawMdmdId = frontmatter.mdmd_id
  const mdmdId = typeof rawMdmdId === 'string' && rawMdmdId.trim().length > 0 ? rawMdmdId : null

  return {
    frontmatter,
    mdmdId,
    mtime: file.mtime,
    pathInCollection: file.pathInCollection,
    size: file.size,
  }
}

export async function scanCollectionMarkdownFiles(collectionRoot: string): Promise<CollectionFileSnapshot[]> {
  const snapshots: CollectionFileSnapshot[] = []
  await collectMarkdownFiles(collectionRoot, collectionRoot, snapshots)

  snapshots.sort((a, b) => a.pathInCollection.localeCompare(b.pathInCollection))
  return snapshots
}

async function collectMarkdownFiles(
  collectionRoot: string,
  directoryPath: string,
  snapshots: CollectionFileSnapshot[],
): Promise<void> {
  const entries = await readdir(directoryPath, {withFileTypes: true})
  await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directoryPath, entry.name)

      if (entry.isDirectory()) {
        await collectMarkdownFiles(collectionRoot, absolutePath, snapshots)
        return
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
        return
      }

      const fileStat = await stat(absolutePath)
      snapshots.push({
        absolutePath,
        mtime: Math.floor(fileStat.mtimeMs / 1000),
        pathInCollection: toCollectionRelativePath(collectionRoot, absolutePath),
        size: fileStat.size,
      })
    }),
  )
}

async function assertExistingDirectory(directoryPath: string): Promise<void> {
  try {
    const directoryStat = await lstat(directoryPath)
    if (!directoryStat.isDirectory()) {
      throw new Error(`Collection path does not exist: ${directoryPath}`)
    }
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException
    if (maybeError.code === 'ENOENT') {
      throw new Error(`Collection path does not exist: ${directoryPath}`)
    }

    throw error
  }
}
