import {Database} from 'bun:sqlite'
import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import {access, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {stringifyFrontmatter} from '../../src/lib/frontmatter'
import {INDEX_DB_PATH_ENV_VAR} from '../../src/lib/index-db'
import {refreshIndex} from '../../src/lib/refresh-index'

const filePath = fileURLToPath(import.meta.url)
const testDir = path.dirname(filePath)
const repoRoot = path.resolve(testDir, '../..')
const cliEntrypoint = path.join(repoRoot, 'bin', 'dev.js')

describe('mdmd remove command', () => {
  let tempRoot = ''

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, {force: true, recursive: true})
      tempRoot = ''
    }
  })

  it('removes collection file, index row, and symlink', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-remove-test-'))
    const {collectionDir, homeDir, indexDbPath, workDir} = await setupDirs(tempRoot)
    const sourcePath = path.join(workDir, 'note.md')
    await writeFile(sourcePath, '# remove me\n', 'utf8')

    const ingestResult = runCli(['ingest', 'note.md', '--collection', collectionDir], workDir, homeDir, indexDbPath)
    expect(ingestResult.status, `${ingestResult.stdout}\n${ingestResult.stderr}`).to.equal(0)

    const removeResult = runCli(
      ['remove', 'mdmd_notes/note.md', '--collection', collectionDir],
      workDir,
      homeDir,
      indexDbPath,
    )
    expect(removeResult.status, `${removeResult.stdout}\n${removeResult.stderr}`).to.equal(0)

    await expectPathMissing(path.join(collectionDir, 'inbox', 'note.md'))
    await expectPathMissing(path.join(workDir, 'mdmd_notes', 'note.md'))

    const db = new Database(indexDbPath)
    const remaining = db.query(`
      SELECT COUNT(*) AS count
      FROM index_notes
      WHERE path_in_collection = 'inbox/note.md'
    `).get() as {count: number}
    db.close()

    expect(remaining.count).to.equal(0)
  })

  it('supports dry-run without deleting anything', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-remove-test-'))
    const {collectionDir, homeDir, indexDbPath, workDir} = await setupDirs(tempRoot)
    await writeFile(path.join(workDir, 'note.md'), '# keep me\n', 'utf8')

    const ingestResult = runCli(['ingest', 'note.md', '--collection', collectionDir], workDir, homeDir, indexDbPath)
    expect(ingestResult.status, `${ingestResult.stdout}\n${ingestResult.stderr}`).to.equal(0)

    const dryRunResult = runCli(
      ['remove', '--dry-run', 'mdmd_notes/note.md', '--collection', collectionDir],
      workDir,
      homeDir,
      indexDbPath,
    )
    expect(dryRunResult.status, `${dryRunResult.stdout}\n${dryRunResult.stderr}`).to.equal(0)
    expect(dryRunResult.stdout).to.contain('Would delete:')

    await expectPathExists(path.join(collectionDir, 'inbox', 'note.md'))
    await expectPathExists(path.join(workDir, 'mdmd_notes', 'note.md'))
  })

  it('aborts without deleting anything when any safety check fails', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-remove-test-'))
    const {collectionDir, homeDir, indexDbPath, workDir} = await setupDirs(tempRoot)
    const workingNotesDir = path.join(workDir, 'mdmd_notes')
    await mkdir(workingNotesDir, {recursive: true})

    const validPath = path.join(collectionDir, 'valid.md')
    const mismatchPath = path.join(collectionDir, 'mismatch.md')

    await writeMarkdownNote(
      validPath,
      {
        // eslint-disable-next-line camelcase
        mdmd_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        paths: [workDir],
      },
      '# valid\n',
    )
    await writeMarkdownNote(
      mismatchPath,
      {
        // eslint-disable-next-line camelcase
        mdmd_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        paths: ['/tmp/not-this-cwd'],
      },
      '# mismatch\n',
    )

    await symlink(validPath, path.join(workingNotesDir, 'valid.md'))
    await symlink(mismatchPath, path.join(workingNotesDir, 'mismatch.md'))
    process.env[INDEX_DB_PATH_ENV_VAR] = indexDbPath
    await refreshIndex(collectionDir)

    const removeResult = runCli(
      ['remove', 'mdmd_notes/valid.md', 'mdmd_notes/mismatch.md', '--collection', collectionDir],
      workDir,
      homeDir,
      indexDbPath,
    )
    expect(removeResult.status).to.not.equal(0)
    expect(removeResult.stderr).to.contain('metadata mismatch')

    await expectPathExists(validPath)
    await expectPathExists(mismatchPath)
    await expectPathExists(path.join(workingNotesDir, 'valid.md'))
    await expectPathExists(path.join(workingNotesDir, 'mismatch.md'))
  })

  it('aborts if note is linked from other directories without --force, succeeds with --force', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-remove-test-'))
    const {collectionDir, homeDir, indexDbPath, workDir} = await setupDirs(tempRoot)
    await writeFile(path.join(workDir, 'note.md'), '# shared\n', 'utf8')

    const ingestResult = runCli(['ingest', 'note.md', '--collection', collectionDir], workDir, homeDir, indexDbPath)
    expect(ingestResult.status, `${ingestResult.stdout}\n${ingestResult.stderr}`).to.equal(0)

    // Manually add a second path to the frontmatter to simulate a multi-dir note
    const collectionFile = path.join(collectionDir, 'inbox', 'note.md')
    const {parseFrontmatter, stringifyFrontmatter} = await import('../../src/lib/frontmatter')
    const noteContents = await readFile(collectionFile, 'utf8')
    const {body, frontmatter} = parseFrontmatter(noteContents)
    const updatedFrontmatter = {...frontmatter, paths: [...(frontmatter.paths as string[]), '/tmp/other-dir']}
    await writeFile(collectionFile, stringifyFrontmatter(updatedFrontmatter, body), 'utf8')

    // Remove without --force should fail
    const removeResult = runCli(
      ['remove', 'mdmd_notes/note.md', '--collection', collectionDir],
      workDir,
      homeDir,
      indexDbPath,
    )
    expect(removeResult.status).to.not.equal(0)
    expect(removeResult.stderr).to.contain('also linked from')

    await expectPathExists(collectionFile)
    await expectPathExists(path.join(workDir, 'mdmd_notes', 'note.md'))

    // Remove with --force should succeed
    const forceResult = runCli(
      ['remove', '--force', 'mdmd_notes/note.md', '--collection', collectionDir],
      workDir,
      homeDir,
      indexDbPath,
    )
    expect(forceResult.status, `${forceResult.stdout}\n${forceResult.stderr}`).to.equal(0)
    await expectPathMissing(collectionFile)
    await expectPathMissing(path.join(workDir, 'mdmd_notes', 'note.md'))
  })
})

function runCli(args: string[], cwd: string, homeDir: string, indexDbPath: string): ReturnType<typeof spawnSync> {
  return spawnSync('bun', [cliEntrypoint, ...args], {
    cwd,
    encoding: 'utf8',
    env: {...process.env, HOME: homeDir, [INDEX_DB_PATH_ENV_VAR]: indexDbPath},
  })
}

async function setupDirs(tempPath: string): Promise<{
  collectionDir: string
  homeDir: string
  indexDbPath: string
  workDir: string
}> {
  const workDir = path.join(tempPath, 'work')
  const collectionDir = path.join(tempPath, 'collection')
  const homeDir = path.join(tempPath, 'home')
  const indexDbPath = path.join(tempPath, 'index.db')

  await mkdir(workDir, {recursive: true})
  await mkdir(collectionDir, {recursive: true})
  await mkdir(homeDir, {recursive: true})

  return {collectionDir, homeDir, indexDbPath, workDir}
}

async function writeMarkdownNote(filePath: string, frontmatter: Record<string, unknown>, body: string): Promise<void> {
  const markdown = stringifyFrontmatter(frontmatter, body)
  await writeFile(filePath, markdown, 'utf8')
}

async function expectPathExists(targetPath: string): Promise<void> {
  await access(targetPath)
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await access(targetPath)
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException
    if (maybeError.code === 'ENOENT') {
      return
    }

    throw error
  }

  throw new Error(`Expected path to be missing: ${targetPath}`)
}
