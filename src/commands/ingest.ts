import {Args, Command, Flags} from '@oclif/core'
import {randomUUID} from 'node:crypto'
import {constants as fsConstants} from 'node:fs'
import {access, lstat, mkdir, readdir, readFile, stat, unlink, writeFile} from 'node:fs/promises'
import path from 'node:path'

import {createMdmdRuntime, resolveCollectionRoot} from '../lib/config'
import {parseFrontmatter, stringifyFrontmatter} from '../lib/frontmatter'
import {ensureGitExcludeEntry, resolveGitHeadSha} from '../lib/git'
import {findPathByMdmdId, openIndexDb, resolveCollectionId, toCollectionRelativePath, upsertIndexNote} from '../lib/index-db'
import {refreshIndex} from '../lib/refresh-index'
import {ensureSymlinkTarget} from '../lib/symlink'
import {NOTES_DIR_NAME} from '../lib/sync-state'

const ISO_8601_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type IngestContext = {
  collectionRoot: string
  cwd: string
}

export default class Ingest extends Command {
  static override args = {
    file: Args.string({description: 'Path to an existing markdown file', required: true}),
  }
  static override description = 'Ingest markdown file(s) into the collection and recreate them as symlinks'
  static override examples = [
    '<%= config.bin %> <%= command.id %> ./notes/todo.md',
    '<%= config.bin %> <%= command.id %> ./notes/todo.md ./notes/ideas.md',
    '<%= config.bin %> <%= command.id %> ./notes/todo.md --collection "/path/to/vault"',
  ]
  static override flags = {
    collection: Flags.directory({
      char: 'c',
      description: 'Collection root path (highest priority over env/config defaults)',
      exists: true,
    }),
  }
  static override strict = false

  async run(): Promise<void> {
    const {args, argv, flags} = await this.parse(Ingest)
    const runtime = createMdmdRuntime(this.config.configDir)
    const cwd = path.resolve(process.cwd())
    const collectionRoot = await resolveCollectionRoot(flags.collection, runtime)
    await assertExistingDirectory(collectionRoot, `Collection path does not exist: ${collectionRoot}`)

    const fileArgs = argv.length > 0 ? argv.map(String) : [args.file]
    const sourcePaths = fileArgs.map((filePath) => path.resolve(cwd, filePath))
    const context: IngestContext = {collectionRoot, cwd}
    for (const sourcePath of sourcePaths) {
      // eslint-disable-next-line no-await-in-loop
      await this.ingestSingleFile(sourcePath, context)
    }
  }

  private async ingestSingleFile(sourcePath: string, context: IngestContext): Promise<void> {
    const {collectionRoot, cwd} = context
    await assertMarkdownFile(sourcePath)

    if (isPathInsideRoot(sourcePath, collectionRoot)) {
      this.error(
        `File is already in the collection (${sourcePath}). Use \`mdmd sync\` instead.`,
        {exit: 1},
      )
    }

    const sourceText = await readFile(sourcePath, 'utf8')
    const {body, frontmatter: existingFrontmatter} = parseFrontmatter(sourceText)
    const rawMdmdId = existingFrontmatter.mdmd_id
    const hasExistingMdmdId = rawMdmdId !== undefined && rawMdmdId !== null && rawMdmdId !== ''
    const mdmdId = hasExistingMdmdId ? validateAndReturnExistingMdmdId(rawMdmdId) : randomUUID()

    if (hasExistingMdmdId) {
      // If the source already carries mdmd_id, refresh first so duplicate-id lookup
      // is based on current collection state (not potentially stale index rows).
      await refreshIndex(collectionRoot)
    }

    const db = openIndexDb(collectionRoot)
    try {
      const collectionId = resolveCollectionId(db, collectionRoot)
      const existingPath = findPathByMdmdId(db, collectionId, mdmdId)
      if (existingPath) {
        this.error(
          `A note with id ${mdmdId} already exists in the collection at ${existingPath}. Use \`mdmd sync\` instead.`,
          {exit: 1},
        )
      }

      const now = new Date().toISOString()
      const gitSha = resolveGitHeadSha(cwd)

      const nextFrontmatter: Record<string, unknown> = {
        ...existingFrontmatter,
        // eslint-disable-next-line camelcase
        created_at: resolveCreatedAt(existingFrontmatter.created_at, now),
        // eslint-disable-next-line camelcase
        mdmd_id: mdmdId,
        path: cwd,
      }

      if (gitSha) {
        // eslint-disable-next-line camelcase
        nextFrontmatter.git_sha = gitSha
      } else {
        // remove stale git_sha carried over from existing frontmatter when cwd is not a git repo
        delete nextFrontmatter.git_sha
      }

      const collectionNotesDir = path.join(collectionRoot, NOTES_DIR_NAME)
      await mkdir(collectionNotesDir, {recursive: true})
      const destinationName = await findAvailableFilename(collectionNotesDir, path.basename(sourcePath))
      const destinationPath = path.join(collectionNotesDir, destinationName)

      await writeFile(destinationPath, stringifyFrontmatter(nextFrontmatter, body), 'utf8')
      await unlink(sourcePath)

      const fileStat = await stat(destinationPath)
      const pathInCollection = toCollectionRelativePath(collectionRoot, destinationPath)
      upsertIndexNote(db, collectionId, {
        frontmatter: nextFrontmatter,
        mdmdId,
        mtime: Math.floor(fileStat.mtimeMs / 1000),
        pathInCollection,
        size: fileStat.size,
      })

      const workingNotesDir = path.join(cwd, NOTES_DIR_NAME)
      await mkdir(workingNotesDir, {recursive: true})
      const symlinkPath = path.join(workingNotesDir, destinationName)
      await ensureSymlinkTarget(symlinkPath, destinationPath)

      await ensureGitExcludeEntry(cwd, `${NOTES_DIR_NAME}/`)

      this.log(`Ingested ${sourcePath} -> ${destinationPath}`)
      this.log(`Symlinked ${path.relative(cwd, symlinkPath)} -> ${destinationPath}`)
    } finally {
      db.close()
    }
  }
}

async function assertMarkdownFile(filePath: string): Promise<void> {
  const fileName = path.basename(filePath).toLowerCase()
  if (!fileName.endsWith('.md')) {
    throw new Error(`Not a markdown file: ${filePath}`)
  }

  await access(filePath, fsConstants.F_OK)
  const sourceStat = await lstat(filePath)

  if (!sourceStat.isFile()) {
    throw new Error(`Source is not a regular file: ${filePath}`)
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

function validateAndReturnExistingMdmdId(rawMdmdId: unknown): string {
  if (typeof rawMdmdId !== 'string' || !UUID_V4_PATTERN.test(rawMdmdId)) {
    throw new Error('Invalid frontmatter mdmd_id: expected UUID v4')
  }

  return rawMdmdId
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

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath)
  return relativePath.length > 0 && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
}

async function findAvailableFilename(directoryPath: string, originalFilename: string): Promise<string> {
  const extension = path.extname(originalFilename)
  const base = path.basename(originalFilename, extension)
  const existingNames = new Set(await readdir(directoryPath))

  let candidate = originalFilename
  let index = 2

  while (existingNames.has(candidate)) {
    candidate = `${base}_${index}${extension}`
    index += 1
  }

  return candidate
}
