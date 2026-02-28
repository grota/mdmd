import {Args, Command, Flags} from '@oclif/core'
import {lstat, readFile, readlink, unlink} from 'node:fs/promises'
import path from 'node:path'
import {createInterface} from 'node:readline'

import {createMdmdRuntime, readMdmdConfig, resolveCollectionRoot, resolveSymlinkDir} from '../lib/config'
import {parseFrontmatter} from '../lib/frontmatter'
import {deleteIndexNoteByPath, openIndexDb, resolveCollectionId, toCollectionRelativePath} from '../lib/index-db'
import {refreshIndex} from '../lib/refresh-index'

type ValidatedRemoval = {
  otherPaths: string[]
  pathInCollection: string
  symlinkPath: string
  targetPath: string
}

export default class Remove extends Command {
  static override args = {
    symlink: Args.file({
      description: 'Symlink path in the symlink directory to remove from the collection',
      exists: true,
      required: true,
    }),
  }
  static override description = 'Remove note(s) from the collection by symlink path'
  static override examples = [
    '<%= config.bin %> <%= command.id %> mdmd_notes/note.md',
    '<%= config.bin %> <%= command.id %> mdmd_notes/note.md mdmd_notes/other.md',
    '<%= config.bin %> <%= command.id %> --dry-run mdmd_notes/note.md',
    '<%= config.bin %> <%= command.id %> --force mdmd_notes/shared.md',
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
    force: Flags.boolean({
      description: 'Delete even if the note is still linked from other directories',
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

    const mdmdConfig = await readMdmdConfig(runtime)
    const symlinkDir = resolveSymlinkDir(mdmdConfig)

    await refreshIndex(collectionRoot)

    const symlinkArgs = argv.map(String)

    const validatedRemovals = await Promise.all(
      symlinkArgs.map(async (symlinkArg) => this.validateRemovalInput(cwd, collectionRoot, symlinkArg, symlinkDir, flags.force ?? false)),
    )

    if (flags['dry-run']) {
      for (const entry of validatedRemovals) {
        this.log(`Would delete: ${entry.targetPath}`)
        this.log(`Would remove from index: path_in_collection='${entry.pathInCollection}'`)
        this.log(`Would remove symlink: ${path.relative(cwd, entry.symlinkPath)}`)
        if (entry.otherPaths.length > 0) {
          this.log(`  Note: also linked from: ${entry.otherPaths.join(', ')}`)
        }
      }

      return
    }

    const db = openIndexDb(collectionRoot)
    const collectionId = resolveCollectionId(db, collectionRoot)
    const prompt = flags.interactive ? createInterface({input: process.stdin, output: process.stdout}) : null

    try {
      await processRemovalEntries(validatedRemovals, 0, {
        collectionId,
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
    symlinkDir: string,
    force: boolean,
  ): Promise<ValidatedRemoval> {
    const workingNotesDir = path.join(cwd, symlinkDir)
    const symlinkPath = path.resolve(cwd, symlinkArg)
    assertPathInDirectory(workingNotesDir, symlinkPath, `Symlink must be in ${symlinkDir}/: ${symlinkArg}`)

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

    // Support both legacy scalar 'path' and new 'paths' array
    let notePaths: string[] = []
    if (Array.isArray(frontmatter.paths)) {
      notePaths = frontmatter.paths as string[]
    } else if (typeof frontmatter.path === 'string' && frontmatter.path.trim().length > 0) {
      notePaths = [frontmatter.path]
    }

    if (notePaths.length === 0) {
      throw new Error(`Note has no paths property in frontmatter: ${targetPath}`)
    }

    if (!notePaths.includes(cwd)) {
      throw new Error(`metadata mismatch: note is not associated with ${cwd} (paths: ${notePaths.join(', ')})`)
    }

    const otherPaths = notePaths.filter((p) => p !== cwd)
    if (otherPaths.length > 0 && !force) {
      const basename = path.basename(targetPath)
      throw new Error(
        `${basename} is also linked from: ${otherPaths.join(', ')}. Use --force to delete anyway.`,
      )
    }

    if (!frontmatter.mdmd_id) {
      this.warn(`Note has no mdmd_id and is not managed, continuing: ${targetPath}`)
    }

    return {
      otherPaths,
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
  collectionId: number
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
  deleteIndexNoteByPath(context.db, context.collectionId, entry.pathInCollection)
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
