import {Args, Command, Flags} from '@oclif/core'
import {lstat, readFile, readlink, unlink} from 'node:fs/promises'
import path from 'node:path'
import {createInterface} from 'node:readline'

import {createMdmdRuntime, resolveCollectionRoot} from '../lib/config'
import {parseFrontmatter} from '../lib/frontmatter'
import {deleteIndexNoteByPath, openIndexDb, toCollectionRelativePath} from '../lib/index-db'
import {NOTES_DIR_NAME} from '../lib/sync-state'

type ValidatedRemoval = {
  pathInCollection: string
  symlinkPath: string
  targetPath: string
}

export default class Remove extends Command {
  static override args = {
    symlink: Args.file({
      description: `Symlink path in ${NOTES_DIR_NAME}/ to remove from the collection`,
      exists: true,
      required: true,
    }),
  }
  static override description = 'Remove note(s) from the collection by symlink path'
  static override examples = [
    '<%= config.bin %> <%= command.id %> mdmd_notes/note.md',
    '<%= config.bin %> <%= command.id %> mdmd_notes/note.md mdmd_notes/other.md',
    '<%= config.bin %> <%= command.id %> --dry-run mdmd_notes/note.md',
  ]
  static override flags = {
    collection: Flags.directory({
      char: 'c',
      description: 'Collection root path (highest priority over env/config defaults)',
      exists: true,
    }),
    'dry-run': Flags.boolean({
      description: 'Show what would be deleted without deleting anything',
    }),
    interactive: Flags.boolean({
      char: 'i',
      description: 'Prompt for confirmation before each deletion',
    }),
  }
  static override strict = false

  async run(): Promise<void> {
    const {argv, flags} = await this.parse(Remove)
    const runtime = createMdmdRuntime(this.config.configDir)
    const cwd = path.resolve(process.cwd())
    const collectionRoot = await resolveCollectionRoot(flags.collection, runtime)
    await assertExistingDirectory(collectionRoot, `Collection path does not exist: ${collectionRoot}`)

    const symlinkArgs = argv.map(String)

    const validatedRemovals = await Promise.all(
      symlinkArgs.map(async (symlinkArg) => this.validateRemovalInput(cwd, collectionRoot, symlinkArg)),
    )

    if (flags['dry-run']) {
      for (const entry of validatedRemovals) {
        this.log(`Would delete: ${entry.targetPath}`)
        this.log(`Would remove from index: path_in_collection='${entry.pathInCollection}'`)
        this.log(`Would remove symlink: ${path.relative(cwd, entry.symlinkPath)}`)
      }

      return
    }

    const db = openIndexDb()
    const prompt = flags.interactive ? createInterface({input: process.stdin, output: process.stdout}) : null

    try {
      await processRemovalEntries(validatedRemovals, 0, {
        cwd,
        db,
        log: (line) => this.log(line),
        prompt,
      })
    } finally {
      prompt?.close()
      db.close()
    }
  }

  private async validateRemovalInput(
    cwd: string,
    collectionRoot: string,
    symlinkArg: string,
  ): Promise<ValidatedRemoval> {
    const workingNotesDir = path.join(cwd, NOTES_DIR_NAME)
    const symlinkPath = path.resolve(cwd, symlinkArg)
    assertPathInDirectory(workingNotesDir, symlinkPath, `Symlink must be in ${NOTES_DIR_NAME}/: ${symlinkArg}`)

    const symlinkStat = await getLstatOrThrow(symlinkPath, `Symlink does not exist: ${symlinkArg}`)
    if (!symlinkStat.isSymbolicLink()) {
      throw new Error(`Expected symlink but found non-symlink: ${symlinkArg}`)
    }

    const linkTarget = await readlink(symlinkPath)
    const targetPath = path.resolve(path.dirname(symlinkPath), linkTarget)
    const targetStat = await getLstatOrThrow(targetPath, `Symlink target not found: ${targetPath}`)
    if (!targetStat.isFile()) {
      throw new Error(`Symlink target is not a file: ${targetPath}`)
    }

    assertPathInDirectory(collectionRoot, targetPath, `Target is outside collection: ${targetPath}`)
    const pathInCollection = toCollectionRelativePath(collectionRoot, targetPath)

    const targetContents = await readFile(targetPath, 'utf8')
    const {frontmatter} = parseFrontmatter(targetContents)
    const notePath = frontmatter.path
    if (typeof notePath !== 'string' || notePath.trim().length === 0) {
      throw new Error(`Note has no path property in frontmatter: ${targetPath}`)
    }

    if (notePath !== cwd) {
      throw new Error(`metadata mismatch: note claims to belong to ${notePath} but symlink is in ${cwd}`)
    }

    if (!frontmatter.mdmd_id) {
      this.warn(`Note has no mdmd_id and is not managed, continuing: ${targetPath}`)
    }

    return {
      pathInCollection,
      symlinkPath,
      targetPath,
    }
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

function assertPathInDirectory(directoryPath: string, candidatePath: string, errorMessage: string): void {
  const relativePath = path.relative(directoryPath, candidatePath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(errorMessage)
  }
}

async function getLstatOrThrow(targetPath: string, errorMessage: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstat(targetPath)
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException
    if (maybeError.code === 'ENOENT') {
      throw new Error(errorMessage)
    }

    throw error
  }
}

type RemovalContext = {
  cwd: string
  db: ReturnType<typeof openIndexDb>
  log: (line: string) => void
  prompt: null | ReturnType<typeof createInterface>
}

async function processRemovalEntries(entries: ValidatedRemoval[], index: number, context: RemovalContext): Promise<void> {
  const entry = entries[index]
  if (!entry) {
    return
  }

  if (context.prompt) {
    const response = (await question(context.prompt, `Delete ${entry.targetPath}? [y/N]: `)).trim().toLowerCase()
    if (response !== 'y' && response !== 'yes') {
      context.log(`Skipped: ${entry.targetPath}`)
      await processRemovalEntries(entries, index + 1, context)
      return
    }
  }

  await unlink(entry.targetPath)
  deleteIndexNoteByPath(context.db, entry.pathInCollection)
  await unlink(entry.symlinkPath)

  context.log(`Deleted: ${entry.targetPath}`)
  context.log(`Removed from index: ${entry.pathInCollection}`)
  context.log(`Removed symlink: ${path.relative(context.cwd, entry.symlinkPath)}`)

  await processRemovalEntries(entries, index + 1, context)
}

async function question(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer)
    })
  })
}
