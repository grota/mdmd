import {Database} from 'bun:sqlite'
import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import {access, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {parseFrontmatter} from '../../src/lib/frontmatter'
import {INDEX_DB_PATH_ENV_VAR} from '../../src/lib/index-db'

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const filePath = fileURLToPath(import.meta.url)
const testDir = path.dirname(filePath)
const repoRoot = path.resolve(testDir, '../..')
const cliEntrypoint = path.join(repoRoot, 'bin', 'dev.js')

describe('mdmd ingest command', () => {
  let tempRoot = ''

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, {force: true, recursive: true})
      tempRoot = ''
    }
  })

  it('moves note into collection, writes metadata, creates symlink, and upserts index row', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-ingest-test-'))
    const workDir = path.join(tempRoot, 'work')
    const collectionDir = path.join(tempRoot, 'collection')
    const homeDir = path.join(tempRoot, 'home')
    const indexDbPath = path.join(tempRoot, 'index.db')
    await mkdir(workDir, {recursive: true})
    await mkdir(collectionDir, {recursive: true})
    await mkdir(homeDir, {recursive: true})

    const sourceFile = path.join(workDir, 'note.md')
    await writeFile(
      sourceFile,
      `---
title: Existing title
created_at: 2020-01-01T00:00:00.000Z
---
# Test
`,
      'utf8',
    )

    const result = spawnSync('bun', [cliEntrypoint, 'ingest', 'note.md', '--collection', collectionDir], {
      cwd: workDir,
      encoding: 'utf8',
      env: {...process.env, HOME: homeDir, [INDEX_DB_PATH_ENV_VAR]: indexDbPath},
    })

    expect(result.status, `${result.stdout}\n${result.stderr}`).to.equal(0)

    const destinationFile = path.join(collectionDir, 'mdmd_notes', 'note.md')
    const symlinkFile = path.join(workDir, 'mdmd_notes', 'note.md')

    await expectPathExists(destinationFile)
    await expectPathMissing(sourceFile)

    const symlinkStat = await lstat(symlinkFile)
    expect(symlinkStat.isSymbolicLink()).to.equal(true)

    const symlinkTarget = await readlink(symlinkFile)
    expect(path.resolve(path.dirname(symlinkFile), symlinkTarget)).to.equal(destinationFile)

    const destinationContents = await readFile(destinationFile, 'utf8')
    const {frontmatter} = parseFrontmatter(destinationContents)

    expect(frontmatter.title).to.equal('Existing title')
    expect(frontmatter.created_at).to.equal('2020-01-01T00:00:00.000Z')
    expect(frontmatter.path).to.equal(workDir)
    expect(frontmatter.mdmd_id).to.be.a('string')
    expect(UUID_V4_PATTERN.test(String(frontmatter.mdmd_id))).to.equal(true)

    const db = new Database(indexDbPath)
    const row = db.query(`
      SELECT path_in_collection, mdmd_id
      FROM index_notes
      WHERE path_in_collection = 'mdmd_notes/note.md'
    `).get() as null | {mdmd_id: string; path_in_collection: string;}
    db.close()

    expect(row).to.not.equal(null)
    expect(row?.path_in_collection).to.equal('mdmd_notes/note.md')
    expect(row?.mdmd_id).to.equal(frontmatter.mdmd_id)
  })

  it('ingests multiple files from one command invocation', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-ingest-test-'))
    const workDir = path.join(tempRoot, 'work')
    const collectionDir = path.join(tempRoot, 'collection')
    const homeDir = path.join(tempRoot, 'home')
    const indexDbPath = path.join(tempRoot, 'index.db')
    await mkdir(workDir, {recursive: true})
    await mkdir(collectionDir, {recursive: true})
    await mkdir(homeDir, {recursive: true})

    await writeFile(path.join(workDir, 'note-a.md'), '# A\n', 'utf8')
    await writeFile(path.join(workDir, 'note-b.md'), '# B\n', 'utf8')

    const result = spawnSync('bun', [cliEntrypoint, 'ingest', 'note-a.md', 'note-b.md', '--collection', collectionDir], {
      cwd: workDir,
      encoding: 'utf8',
      env: {...process.env, HOME: homeDir, [INDEX_DB_PATH_ENV_VAR]: indexDbPath},
    })

    expect(result.status, `${result.stdout}\n${result.stderr}`).to.equal(0)

    await expectPathExists(path.join(collectionDir, 'mdmd_notes', 'note-a.md'))
    await expectPathExists(path.join(collectionDir, 'mdmd_notes', 'note-b.md'))
    await expectPathExists(path.join(workDir, 'mdmd_notes', 'note-a.md'))
    await expectPathExists(path.join(workDir, 'mdmd_notes', 'note-b.md'))
    await expectPathMissing(path.join(workDir, 'note-a.md'))
    await expectPathMissing(path.join(workDir, 'note-b.md'))

    const db = new Database(indexDbPath)
    const rowCount = db.query(`
      SELECT COUNT(*) AS count
      FROM index_notes
      WHERE path_in_collection IN ('mdmd_notes/note-a.md', 'mdmd_notes/note-b.md')
    `).get() as {count: number}
    db.close()

    expect(rowCount.count).to.equal(2)
  })

  it('creates a suffixed filename when collection filename already exists', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-ingest-test-'))
    const workDir = path.join(tempRoot, 'work')
    const collectionDir = path.join(tempRoot, 'collection')
    const homeDir = path.join(tempRoot, 'home')
    const indexDbPath = path.join(tempRoot, 'index.db')
    await mkdir(workDir, {recursive: true})
    await mkdir(path.join(collectionDir, 'mdmd_notes'), {recursive: true})
    await mkdir(homeDir, {recursive: true})

    await writeFile(path.join(collectionDir, 'mdmd_notes', 'note.md'), '# existing\n', 'utf8')
    await writeFile(path.join(workDir, 'note.md'), '# to ingest\n', 'utf8')

    const result = spawnSync('bun', [cliEntrypoint, 'ingest', 'note.md', '--collection', collectionDir], {
      cwd: workDir,
      encoding: 'utf8',
      env: {...process.env, HOME: homeDir, [INDEX_DB_PATH_ENV_VAR]: indexDbPath},
    })

    expect(result.status, `${result.stdout}\n${result.stderr}`).to.equal(0)
    await expectPathExists(path.join(collectionDir, 'mdmd_notes', 'note_2.md'))
    await expectPathExists(path.join(workDir, 'mdmd_notes', 'note_2.md'))
  })

  it('refreshes stale index state before duplicate-id lookup when source already has mdmd_id', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-ingest-test-'))
    const workDir = path.join(tempRoot, 'work')
    const collectionDir = path.join(tempRoot, 'collection')
    const homeDir = path.join(tempRoot, 'home')
    const indexDbPath = path.join(tempRoot, 'index.db')
    await mkdir(workDir, {recursive: true})
    await mkdir(collectionDir, {recursive: true})
    await mkdir(homeDir, {recursive: true})

    const existingMdmdId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const staleDb = new Database(indexDbPath)
    staleDb.exec(`
      CREATE TABLE index_notes (
        path_in_collection TEXT NOT NULL PRIMARY KEY,
        mdmd_id TEXT,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        frontmatter TEXT
      );
      CREATE UNIQUE INDEX idx_notes_mdmd_id ON index_notes(mdmd_id) WHERE mdmd_id IS NOT NULL;
    `)
    staleDb.query(`
      INSERT INTO index_notes (path_in_collection, mdmd_id, mtime, size, frontmatter)
      VALUES ('mdmd_notes/stale.md', ?1, 1, 1, '{"mdmd_id":"${existingMdmdId}","path":"/tmp/stale"}');
    `).run(existingMdmdId)
    staleDb.close()

    await writeFile(
      path.join(workDir, 'note.md'),
      `---
mdmd_id: ${existingMdmdId}
---
# ingest with existing id
`,
      'utf8',
    )

    const result = spawnSync('bun', [cliEntrypoint, 'ingest', 'note.md', '--collection', collectionDir], {
      cwd: workDir,
      encoding: 'utf8',
      env: {...process.env, HOME: homeDir, [INDEX_DB_PATH_ENV_VAR]: indexDbPath},
    })

    expect(result.status, `${result.stdout}\n${result.stderr}`).to.equal(0)
    await expectPathExists(path.join(collectionDir, 'mdmd_notes', 'note.md'))

    const db = new Database(indexDbPath)
    const staleCount = db.query(`
      SELECT COUNT(*) AS count
      FROM index_notes
      WHERE path_in_collection = 'mdmd_notes/stale.md';
    `).get() as {count: number}
    const ingestedCount = db.query(`
      SELECT COUNT(*) AS count
      FROM index_notes
      WHERE path_in_collection = 'mdmd_notes/note.md' AND mdmd_id = ?1;
    `).get(existingMdmdId) as {count: number}
    db.close()

    expect(staleCount.count).to.equal(0)
    expect(ingestedCount.count).to.equal(1)
  })
})

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
