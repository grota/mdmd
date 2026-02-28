import {Database} from 'bun:sqlite'
import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import {lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {parseFrontmatter, stringifyFrontmatter} from '../../src/lib/frontmatter'
import {INDEX_DB_PATH_ENV_VAR} from '../../src/lib/index-db'

const filePath = fileURLToPath(import.meta.url)
const testDir = path.dirname(filePath)
const repoRoot = path.resolve(testDir, '../..')
const cliEntrypoint = path.join(repoRoot, 'bin', 'dev.js')

describe('mdmd link command', () => {
  let tempRoot = ''

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, {force: true, recursive: true})
      tempRoot = ''
    }
  })

  it('links an existing collection note to the current directory', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-link-test-'))
    const {collectionDir, homeDir, indexDbPath, workDir} = await setupDirs(tempRoot)

    // Create a note directly in the collection (not managed)
    const notePath = path.join(collectionDir, 'research.md')
    await writeFile(notePath, '# Research\nSome content.\n', 'utf8')

    const result = runCli(['link', 'research.md', '--collection', collectionDir], workDir, homeDir, indexDbPath)
    expect(result.status, `${result.stdout}\n${result.stderr}`).to.equal(0)

    // Symlink should exist in workDir/mdmd_notes/research.md
    const symlinkPath = path.join(workDir, 'mdmd_notes', 'research.md')
    const symlinkStat = await lstat(symlinkPath)
    expect(symlinkStat.isSymbolicLink()).to.equal(true)

    const target = await readlink(symlinkPath)
    expect(path.resolve(path.dirname(symlinkPath), target)).to.equal(notePath)

    // Frontmatter should have mdmd_id and paths=[workDir]
    const noteContents = await readFile(notePath, 'utf8')
    const {frontmatter} = parseFrontmatter(noteContents)
    expect(frontmatter.mdmd_id).to.be.a('string')
    expect(frontmatter.paths).to.deep.equal([workDir])

    // Index should have a row
    const db = new Database(indexDbPath)
    const row = db.query(`
      SELECT path_in_collection, mdmd_id
      FROM index_notes
      WHERE path_in_collection = 'research.md'
    `).get() as null | {mdmd_id: string; path_in_collection: string}
    db.close()
    expect(row).to.not.equal(null)
    expect(row?.path_in_collection).to.equal('research.md')
  })

  it('is idempotent when note is already linked', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-link-test-'))
    const {collectionDir, homeDir, indexDbPath, workDir} = await setupDirs(tempRoot)

    const notePath = path.join(collectionDir, 'note.md')
    await writeFile(notePath, '# Note\n', 'utf8')

    // Link once
    const first = runCli(['link', 'note.md', '--collection', collectionDir], workDir, homeDir, indexDbPath)
    expect(first.status, `${first.stdout}\n${first.stderr}`).to.equal(0)

    // Link again — should succeed without duplicating paths
    const second = runCli(['link', 'note.md', '--collection', collectionDir], workDir, homeDir, indexDbPath)
    expect(second.status, `${second.stdout}\n${second.stderr}`).to.equal(0)
    expect(second.stdout).to.contain('idempotent')

    const noteContents = await readFile(notePath, 'utf8')
    const {frontmatter} = parseFrontmatter(noteContents)
    const paths = frontmatter.paths as string[]
    expect(paths.filter((p) => p === workDir)).to.have.length(1)
  })

  it('links an already-managed note from another directory', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-link-test-'))
    const {collectionDir, homeDir, indexDbPath, workDir} = await setupDirs(tempRoot)

    const otherDir = '/tmp/other-project'
    const notePath = path.join(collectionDir, 'shared.md')
    await writeFile(
      notePath,
      stringifyFrontmatter(
        {
          // eslint-disable-next-line camelcase
          mdmd_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          paths: [otherDir],
        },
        '# Shared\n',
      ),
      'utf8',
    )

    const result = runCli(['link', 'shared.md', '--collection', collectionDir], workDir, homeDir, indexDbPath)
    expect(result.status, `${result.stdout}\n${result.stderr}`).to.equal(0)

    const noteContents = await readFile(notePath, 'utf8')
    const {frontmatter} = parseFrontmatter(noteContents)
    expect(frontmatter.paths).to.deep.equal([otherDir, workDir])
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
