import {Args, Command, Flags} from '@oclif/core'
import {lstat, readFile, readlink, stat, unlink, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {createInterface} from 'node:readline'

import {createMdmdRuntime, readMdmdConfig, resolveCollectionRoot, resolveSymlinkDir} from '../lib/config'
import {parseFrontmatter, stringifyFrontmatter} from '../lib/frontmatter'
import {openIndexDb, resolveCollectionId, toCollectionRelativePath, upsertIndexNote} from '../lib/index-db'
import {refreshIndex} from '../lib/refresh-index'

export default class Unlink extends Command {
  static override args = {
    symlink: Args.file({
      description: 'Symlink path in the symlink directory to detach',
      exists: true,
      required: true,
    }),
  }
  static override description = 'Detach a note from the current directory without deleting it from the collection'
  static override examples = [
    '<%= config.bin %> <%= command.id %> mdmd_notes/architecture.md',
    '<%= config.bin %> <%= command.id %> -i mdmd_notes/architecture.md',
  ]
  static override flags = {
    collection: Flags.directory({
      char: 'c',
      description: 'Collection root path (highest priority over env/config defaults)',
      exists: true,
    }),
    interactive: Flags.boolean({
      char: 'i',
      description: 'Prompt for confirmation before each unlink',
    }),
  }
  static override strict = false

  async run(): Promise<void> {
    const {argv, flags} = await this.parse(Unlink)
    const runtime = createMdmdRuntime(this.config.configDir)
    const cwd = path.resolve(process.cwd())
    const collectionRoot = await resolveCollectionRoot(flags.collection, runtime)
    await assertExistingDirectory(collectionRoot, `Collection path does not exist: ${collectionRoot}`)

    const mdmdConfig = await readMdmdConfig(runtime)
    const symlinkDir = resolveSymlinkDir(mdmdConfig)

    await refreshIndex(collectionRoot)

    const symlinkArgs = argv.map(String)
    const prompt = flags.interactive ? createInterface({input: process.stdin, output: process.stdout}) : null

    try {
      for (const symlinkArg of symlinkArgs) {
        // eslint-disable-next-line no-await-in-loop
        await this.unlinkSingle(symlinkArg, cwd, collectionRoot, symlinkDir, prompt)
      }
    } finally {
      prompt?.close()
    }
  }

  private async unlinkSingle(
    symlinkArg: string,
    cwd: string,
    collectionRoot: string,
    symlinkDir: string,
    prompt: null | ReturnType<typeof createInterface>,
  ): Promise<void> {
    const workingNotesDir = path.join(cwd, symlinkDir)
    const symlinkPath = path.resolve(cwd, symlinkArg)

    const relativePath = path.relative(workingNotesDir, symlinkPath)
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      this.error(`Symlink must be in ${symlinkDir}/: ${symlinkArg}`, {exit: 1})
    }

    const symlinkStat = await getLstatOrNull(symlinkPath)
    if (!symlinkStat || !symlinkStat.isSymbolicLink()) {
      this.error(`Symlink does not exist: ${symlinkArg}`, {exit: 1})
    }

    const linkTarget = await readlink(symlinkPath)
    const targetPath = path.resolve(path.dirname(symlinkPath), linkTarget)

    const relToCollection = path.relative(collectionRoot, targetPath)
    if (relToCollection.startsWith('..') || path.isAbsolute(relToCollection)) {
      this.error(`Target is outside collection: ${targetPath}`, {exit: 1})
    }

    const targetContents = await readFile(targetPath, 'utf8')
    const {body, frontmatter} = parseFrontmatter(targetContents)

    if (!frontmatter.mdmd_id) {
      this.error(`Note is not managed (no mdmd_id): ${targetPath}`, {exit: 1})
    }

    if (prompt) {
      const response = (await question(prompt, `Unlink ${targetPath} from ${cwd}? [y/N]: `)).trim().toLowerCase()
      if (response !== 'y' && response !== 'yes') {
        this.log(`Skipped: ${targetPath}`)
        return
      }
    }

    const existingPaths = Array.isArray(frontmatter.paths) ? (frontmatter.paths as string[]) : []
    const cwdInPaths = existingPaths.includes(cwd)

    if (!cwdInPaths) {
      this.warn(`cwd ${cwd} was not in note's paths — removing orphan symlink anyway`)
    }

    const nextPaths = existingPaths.filter((p) => p !== cwd)
    const nextFrontmatter = {...frontmatter, paths: nextPaths}

    await writeFile(targetPath, stringifyFrontmatter(nextFrontmatter, body), 'utf8')

    const fileStat = await stat(targetPath)
    const pathInCollection = toCollectionRelativePath(collectionRoot, targetPath)

    const db = openIndexDb(collectionRoot)
    try {
      const collectionId = resolveCollectionId(db, collectionRoot)
      const mdmdId = typeof frontmatter.mdmd_id === 'string' ? frontmatter.mdmd_id : null
      upsertIndexNote(db, collectionId, {
        frontmatter: nextFrontmatter,
        mdmdId,
        mtime: Math.floor(fileStat.mtimeMs / 1000),
        pathInCollection,
        size: fileStat.size,
      })
    } finally {
      db.close()
    }

    await unlink(symlinkPath)
    this.log(`Unlinked ${symlinkArg} from ${cwd}`)
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

async function getLstatOrNull(targetPath: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(targetPath)
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException
    if (maybeError.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

async function question(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer)
    })
  })
}
