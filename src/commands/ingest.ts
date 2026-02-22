import {Args, Command, Flags} from '@oclif/core'
import {randomUUID} from 'node:crypto'
import {constants as fsConstants} from 'node:fs'
import {access, lstat, mkdir, readdir, readFile, stat, unlink, writeFile} from 'node:fs/promises'
import path from 'node:path'

import {resolveCollectionRoot} from '../lib/config'
import {parseFrontmatter, stringifyFrontmatter} from '../lib/frontmatter'
import {ensureGitExcludeEntry, resolveGitHeadSha} from '../lib/git'
import {findPathByMdmdId, openIndexDb, toCollectionRelativePath, upsertIndexNote} from '../lib/index-db'
import {ensureSymlinkTarget} from '../lib/symlink'

const NOTES_DIR_NAME = 'mdmd_notes'
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export default class Ingest extends Command {
  static override args = {
    file: Args.string({description: 'Path to an existing markdown file', required: true}),
  }
static override description = 'Ingest a markdown file into the collection and recreate it as a symlink'
static override examples = [
    '<%= config.bin %> <%= command.id %> ./notes/todo.md',
    '<%= config.bin %> <%= command.id %> ./notes/todo.md --collection "/path/to/vault"',
  ]
static override flags = {
    collection: Flags.directory({
      char: 'c',
      description: 'Collection root path (highest priority over env/config defaults)',
      exists: true,
    }),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Ingest)
    const cwd = path.resolve(process.cwd())
    const sourcePath = path.resolve(cwd, args.file)
    await assertMarkdownFile(sourcePath)

    const collectionRoot = await resolveCollectionRoot(flags.collection)
    await assertExistingDirectory(collectionRoot, `Collection path does not exist: ${collectionRoot}`)

    if (isPathInsideRoot(sourcePath, collectionRoot)) {
      this.error(
        `File is already in the collection (${sourcePath}). Use \`mdmd sync\` instead.`,
        {exit: 1},
      )
    }

    const sourceText = await readFile(sourcePath, 'utf8')
    const {body, frontmatter: existingFrontmatter} = parseFrontmatter(sourceText)
    const mdmdId = resolveMdmdId(existingFrontmatter.mdmd_id)

    const db = openIndexDb()
    try {
      const existingPath = findPathByMdmdId(db, mdmdId)
      if (existingPath) {
        this.error(
          `File already has a managed mdmd_id (${mdmdId}) at ${existingPath}. Use \`mdmd sync\` instead.`,
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
        last_updated_at: now,
        // eslint-disable-next-line camelcase
        mdmd_id: mdmdId,
        path: cwd,
      }

      if (gitSha) {
        // eslint-disable-next-line camelcase
        nextFrontmatter.git_sha = gitSha
      } else {
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
      upsertIndexNote(db, {
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

function resolveMdmdId(rawMdmdId: unknown): string {
  if (rawMdmdId === undefined || rawMdmdId === null || rawMdmdId === '') {
    return randomUUID()
  }

  if (typeof rawMdmdId !== 'string' || !UUID_V4_PATTERN.test(rawMdmdId)) {
    throw new Error('Invalid frontmatter mdmd_id: expected UUID v4')
  }

  return rawMdmdId
}

function resolveCreatedAt(rawCreatedAt: unknown, fallback: string): string {
  if (typeof rawCreatedAt === 'string' && rawCreatedAt.trim().length > 0) {
    return rawCreatedAt
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
