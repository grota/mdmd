import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {stringifyFrontmatter} from '../../src/lib/frontmatter'
import {INDEX_DB_PATH_ENV_VAR} from '../../src/lib/index-db'

const filePath = fileURLToPath(import.meta.url)
const testDir = path.dirname(filePath)
const repoRoot = path.resolve(testDir, '../..')
const cliEntrypoint = path.join(repoRoot, 'bin', 'dev.js')

describe('mdmd list command', () => {
  let tempRoot = ''

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, {force: true, recursive: true})
      tempRoot = ''
    }
  })

  it('lists notes linked to current directory', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-list-test-'))
    const {collectionDir, homeDir, indexDbPath, workDir} = await setupDirs(tempRoot)

    // Ingest 2 notes in workDir
    await writeFile(path.join(workDir, 'note-a.md'), '# A\n', 'utf8')
    await writeFile(path.join(workDir, 'note-b.md'), '# B\n', 'utf8')
    runCliOk(['ingest', 'note-a.md', '--collection', collectionDir], workDir, homeDir, indexDbPath)
    runCliOk(['ingest', 'note-b.md', '--collection', collectionDir], workDir, homeDir, indexDbPath)

    // Create a 3rd note linked to a different dir
    const otherDir = path.join(tempRoot, 'other')
    await mkdir(otherDir, {recursive: true})
    const thirdNote = path.join(collectionDir, 'third.md')
    await writeFile(
      thirdNote,
      stringifyFrontmatter(
        {
          // eslint-disable-next-line camelcase
          mdmd_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          paths: [otherDir],
        },
        '# Third\n',
      ),
      'utf8',
    )

    const result = runCli(['list', '--collection', collectionDir], workDir, homeDir, indexDbPath)
    expect(result.status, `${result.stdout}\n${result.stderr}`).to.equal(0)
    expect(result.stdout).to.contain('note-a.md')
    expect(result.stdout).to.contain('note-b.md')
    expect(result.stdout).not.to.contain('third.md')
  })

  it('--collection-wide lists all managed notes', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-list-test-'))
    const {collectionDir, homeDir, indexDbPath, workDir} = await setupDirs(tempRoot)

    await writeFile(path.join(workDir, 'note-a.md'), '# A\n', 'utf8')
    await writeFile(path.join(workDir, 'note-b.md'), '# B\n', 'utf8')
    runCliOk(['ingest', 'note-a.md', '--collection', collectionDir], workDir, homeDir, indexDbPath)
    runCliOk(['ingest', 'note-b.md', '--collection', collectionDir], workDir, homeDir, indexDbPath)

    const otherDir = path.join(tempRoot, 'other')
    await mkdir(otherDir, {recursive: true})
    const thirdNote = path.join(collectionDir, 'third.md')
    await writeFile(
      thirdNote,
      stringifyFrontmatter(
        {
          // eslint-disable-next-line camelcase
          mdmd_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          paths: [otherDir],
        },
        '# Third\n',
      ),
      'utf8',
    )

    const result = runCli(['list', '--collection-wide', '--collection', collectionDir], workDir, homeDir, indexDbPath)
    expect(result.status, `${result.stdout}\n${result.stderr}`).to.equal(0)
    expect(result.stdout).to.contain('note-a.md')
    expect(result.stdout).to.contain('note-b.md')
    expect(result.stdout).to.contain('third.md')
  })

  it('--json emits a valid JSON array', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-list-test-'))
    const {collectionDir, homeDir, indexDbPath, workDir} = await setupDirs(tempRoot)

    await writeFile(path.join(workDir, 'note-a.md'), '# A\n', 'utf8')
    runCliOk(['ingest', 'note-a.md', '--collection', collectionDir], workDir, homeDir, indexDbPath)

    const result = runCli(['list', '--json', '--collection', collectionDir], workDir, homeDir, indexDbPath)
    expect(result.status, `${result.stdout}\n${result.stderr}`).to.equal(0)

    const parsed = JSON.parse(result.stdout.trim()) as unknown[]
    expect(Array.isArray(parsed)).to.equal(true)
    expect(parsed.length).to.equal(1)
    const first = parsed[0] as {mdmd_id: string; path_in_collection: string; paths: string[]}
    expect(first.path_in_collection).to.equal('inbox/note-a.md')
    expect(first.paths).to.deep.equal([workDir])
  })
})

function runCli(args: string[], cwd: string, homeDir: string, indexDbPath: string): ReturnType<typeof spawnSync> {
  return spawnSync('bun', [cliEntrypoint, ...args], {
    cwd,
    encoding: 'utf8',
    env: {...process.env, HOME: homeDir, [INDEX_DB_PATH_ENV_VAR]: indexDbPath},
  })
}

function runCliOk(args: string[], cwd: string, homeDir: string, indexDbPath: string): void {
  const result = runCli(args, cwd, homeDir, indexDbPath)
  if (result.status !== 0) {
    throw new Error(`CLI command failed: ${result.stderr}`)
  }
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
