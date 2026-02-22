import {Command, Flags} from '@oclif/core'
import {lstat, mkdir, readdir, unlink} from 'node:fs/promises'
import path from 'node:path'

import {resolveCollectionRoot} from '../lib/config'
import {ensureGitExcludeEntry} from '../lib/git'
import {refreshIndex} from '../lib/refresh-index'
import {ensureSymlinkTarget} from '../lib/symlink'
import {buildDesiredSymlinks, listManagedPathsForCwd, NOTES_DIR_NAME} from '../lib/sync-state'

export default class Sync extends Command {
  static override description = 'Sync working-directory symlinks from collection metadata'
static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --collection "/path/to/vault"',
  ]
static override flags = {
    collection: Flags.directory({
      char: 'c',
      description: 'Collection root path (highest priority over env/config defaults)',
      exists: true,
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Sync)
    const cwd = path.resolve(process.cwd())
    const collectionRoot = await resolveCollectionRoot(flags.collection)
    await assertExistingDirectory(collectionRoot, `Collection path does not exist: ${collectionRoot}`)

    const refreshResult = await refreshIndex(collectionRoot)
    const managedPaths = listManagedPathsForCwd(cwd)
    const desiredSymlinks = buildDesiredSymlinks(collectionRoot, managedPaths)
    const desiredByName = new Map(desiredSymlinks.map((entry) => [entry.symlinkName, entry.targetPath]))

    const workingNotesDir = path.join(cwd, NOTES_DIR_NAME)
    await mkdir(workingNotesDir, {recursive: true})

    const existingEntries = await readdir(workingNotesDir)
    const existingSymlinks = await Promise.all(
      existingEntries.map(async (entryName) => {
        const symlinkPath = path.join(workingNotesDir, entryName)
        const symlinkStat = await lstat(symlinkPath)
        if (!symlinkStat.isSymbolicLink()) {
          throw new Error(`Expected symlink in ${NOTES_DIR_NAME}/ but found non-symlink: ${entryName}`)
        }

        return {entryName, symlinkPath}
      }),
    )

    const staleSymlinks = existingSymlinks.filter((entry) => !desiredByName.has(entry.entryName))
    await Promise.all(staleSymlinks.map(async (entry) => unlink(entry.symlinkPath)))

    await Promise.all(
      desiredSymlinks.map(async (entry) => {
        await ensureSymlinkTarget(path.join(workingNotesDir, entry.symlinkName), entry.targetPath)
      }),
    )

    await ensureGitExcludeEntry(cwd, `${NOTES_DIR_NAME}/`)

    this.log(
      `Synced ${desiredSymlinks.length} note(s) to ${NOTES_DIR_NAME}/ ` +
        `(removed ${staleSymlinks.length}, refreshed ${refreshResult.refreshed}, deleted ${refreshResult.deleted})`,
    )
  }
}

async function assertExistingDirectory(dirPath: string, errorMessage: string): Promise<void> {
  try {
    const directoryStat = await lstat(dirPath)
    if (!directoryStat.isDirectory()) {
      throw new Error(errorMessage)
    }
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException
    if (maybeError.code === 'ENOENT') {
      throw new Error(errorMessage)
    }

    throw error
  }
}
