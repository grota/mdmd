import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import {access, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {parseFrontmatter, stringifyFrontmatter} from '../../src/lib/frontmatter'
import {INDEX_DB_PATH_ENV_VAR, openIndexDb} from '../../src/lib/index-db'

const filePath = fileURLToPath(import.meta.url)
const testDir = path.dirname(filePath)
const repoRoot = path.resolve(testDir, '../..')
const cliEntrypoint = path.join(repoRoot, 'bin', 'dev.js')

describe('mdmd unlink command', () => {
  let tempRoot = ''

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, {force: true, recursive: true})
      tempRoot = ''
    }
  })

  it('removes cwd from paths, removes symlink, keeps collection file', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-unlink-test-'))
    const {collectionDir, homeDir, indexDbPath, workDir} = await setupDirs(tempRoot)

    // Ingest a note to set up the full state
    await writeFile(path.join(workDir, 'note.md'), '# unlink me\n', 'utf8')
    const ingestResult = runCli(['ingest', 'note.md', '--collection', collectionDir], workDir, homeDir, indexDbPath)
    expect(ingestResult.status, `${ingestResult.stdout}\n${ingestResult.stderr}`).to.equal(0)

    const collectionFile = path.join(collectionDir, 'inbox', 'note.md')
    const symlinkPath = path.join(workDir, 'mdmd_notes', 'note.md')

    await expectPathExists(collectionFile)
    await expectPathExists(symlinkPath)

    const unlinkResult = runCli(['unlink', 'mdmd_notes/note.md', '--collection', collectionDir], workDir, homeDir, indexDbPath)
    expect(unlinkResult.status, `${unlinkResult.stdout}\n${unlinkResult.stderr}`).to.equal(0)

    // Symlink is gone
    await expectPathMissing(symlinkPath)

    // Collection file still exists
    await expectPathExists(collectionFile)

    // paths array is now empty
    const noteContents = await readFile(collectionFile, 'utf8')
    const {frontmatter} = parseFrontmatter(noteContents)
    expect(frontmatter.paths).to.deep.equal([])

    // Index row has empty paths
    process.env[INDEX_DB_PATH_ENV_VAR] = indexDbPath
    const db = openIndexDb(collectionDir)
    const row = db.query(`
      SELECT frontmatter
      FROM index_notes
      WHERE path_in_collection = 'inbox/note.md'
    `).get() as null | {frontmatter: string}
    db.close()
    delete process.env[INDEX_DB_PATH_ENV_VAR]

    expect(row).to.not.equal(null)
    const indexedFm = JSON.parse(row!.frontmatter) as {paths: string[]}
    expect(indexedFm.paths).to.deep.equal([])
  })

  it('warns when cwd is not in paths but removes orphan symlink', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-unlink-test-'))
    const {collectionDir, homeDir, indexDbPath, workDir} = await setupDirs(tempRoot)

    // Create a managed note that doesn't include workDir in paths
    const notePath = path.join(collectionDir, 'orphan.md')
    await writeFile(
      notePath,
      stringifyFrontmatter(
        {
          // eslint-disable-next-line camelcase
          mdmd_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          paths: ['/tmp/some-other-dir'],
        },
        '# orphan\n',
      ),
      'utf8',
    )

    // Manually create the symlink as if it were orphaned
    const workingNotesDir = path.join(workDir, 'mdmd_notes')
    await mkdir(workingNotesDir, {recursive: true})
    await symlink(notePath, path.join(workingNotesDir, 'orphan.md'))

    const result = runCli(['unlink', 'mdmd_notes/orphan.md', '--collection', collectionDir], workDir, homeDir, indexDbPath)
    expect(result.status, `${result.stdout}\n${result.stderr}`).to.equal(0)
    expect(result.stderr).to.contain('was not in note\'s paths')

    // Symlink is gone
    await expectPathMissing(path.join(workingNotesDir, 'orphan.md'))

    // Collection file still exists
    await expectPathExists(notePath)
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

async function expectPathExists(targetPath: string): Promise<void> {
  await access(targetPath)
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await lstat(targetPath)
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException
    if (maybeError.code === 'ENOENT') {
      return
    }

    throw error
  }

  throw new Error(`Expected path to be missing: ${targetPath}`)
}
