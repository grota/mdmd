import {Args, Command, Flags} from '@oclif/core'
import {randomUUID} from 'node:crypto'
import {lstat, mkdir, readFile, stat, writeFile} from 'node:fs/promises'
import path from 'node:path'

import {createMdmdRuntime, readMdmdConfig, resolveCollectionRoot, resolveSymlinkDir} from '../lib/config'
import {parseFrontmatter, stringifyFrontmatter} from '../lib/frontmatter'
import {ensureGitExcludeEntry} from '../lib/git'
import {openIndexDb, resolveCollectionId, toCollectionRelativePath, upsertIndexNote} from '../lib/index-db'
import {refreshIndex} from '../lib/refresh-index'
import {ensureSymlinkTarget} from '../lib/symlink'

const ISO_8601_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/

export default class Link extends Command {
  static override args = {
    notePath: Args.string({description: 'Collection-relative path to the note to link', required: true}),
  }
  static override description = 'Link an existing collection note to the current directory'
  static override examples = [
    '<%= config.bin %> <%= command.id %> Projects/architecture.md',
    '<%= config.bin %> <%= command.id %> inbox/research.md',
  ]
  static override flags = {
    collection: Flags.directory({
      char: 'c',
      description: 'Collection root path (highest priority over env/config defaults)',
      exists: true,
    }),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Link)
    const runtime = createMdmdRuntime(this.config.configDir)
    const cwd = path.resolve(process.cwd())
    const collectionRoot = await resolveCollectionRoot(flags.collection, runtime)
    await assertExistingDirectory(collectionRoot, `Collection path does not exist: ${collectionRoot}`)

    await refreshIndex(collectionRoot)

    const mdmdConfig = await readMdmdConfig(runtime)
    const symlinkDir = resolveSymlinkDir(mdmdConfig)

    const absoluteNotePath = path.join(collectionRoot, ...args.notePath.split('/'))
    const noteStat = await getLstatOrNull(absoluteNotePath)
    if (!noteStat || !noteStat.isFile()) {
      this.error(`Collection file not found: ${args.notePath}`, {exit: 1})
    }

    const noteContents = await readFile(absoluteNotePath, 'utf8')
    const {body, frontmatter: existingFrontmatter} = parseFrontmatter(noteContents)

    // Assign mdmd_id if absent
    const mdmdId =
      typeof existingFrontmatter.mdmd_id === 'string' && existingFrontmatter.mdmd_id.trim().length > 0
        ? existingFrontmatter.mdmd_id
        : randomUUID()

    // Build updated paths array
    const existingPaths = Array.isArray(existingFrontmatter.paths) ? (existingFrontmatter.paths as string[]) : []
    const nextPaths = existingPaths.includes(cwd) ? existingPaths : [...existingPaths, cwd]

    const now = new Date().toISOString()
    const nextFrontmatter: Record<string, unknown> = {
      ...existingFrontmatter,
      // eslint-disable-next-line camelcase
      created_at: resolveCreatedAt(existingFrontmatter.created_at, now),
      // eslint-disable-next-line camelcase
      mdmd_id: mdmdId,
      paths: nextPaths,
    }

    // Remove legacy scalar 'path' if present
    delete nextFrontmatter.path

    await writeFile(absoluteNotePath, stringifyFrontmatter(nextFrontmatter, body), 'utf8')

    const fileStat = await stat(absoluteNotePath)
    const pathInCollection = toCollectionRelativePath(collectionRoot, absoluteNotePath)

    const db = openIndexDb(collectionRoot)
    try {
      const collectionId = resolveCollectionId(db, collectionRoot)
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

    const workingNotesDir = path.join(cwd, symlinkDir)
    await mkdir(workingNotesDir, {recursive: true})
    const symlinkName = resolveSymlinkName(pathInCollection)
    const symlinkPath = path.join(workingNotesDir, symlinkName)
    await ensureSymlinkTarget(symlinkPath, absoluteNotePath)

    await ensureGitExcludeEntry(cwd, `${symlinkDir}/`)

    const wasAlreadyLinked = existingPaths.includes(cwd)
    if (wasAlreadyLinked) {
      this.log(`Already linked (idempotent): ${path.relative(cwd, symlinkPath)} -> ${absoluteNotePath}`)
    } else {
      this.log(`Linked ${path.relative(cwd, symlinkPath)} -> ${absoluteNotePath}`)
    }
  }
}

function resolveSymlinkName(pathInCollection: string): string {
  return path.posix.basename(pathInCollection)
}

function resolveCreatedAt(rawCreatedAt: unknown, fallback: string): string {
  if (typeof rawCreatedAt === 'string') {
    const value = rawCreatedAt.trim()
    if (ISO_8601_TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value))) {
      return value
    }
  }

  return fallback
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
