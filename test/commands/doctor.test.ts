import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import {access, mkdir, mkdtemp, rm, symlink, unlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {INDEX_DB_PATH_ENV_VAR} from '../../src/lib/index-db'

const filePath = fileURLToPath(import.meta.url)
const testDir = path.dirname(filePath)
const repoRoot = path.resolve(testDir, '../..')
const cliEntrypoint = path.join(repoRoot, 'bin', 'dev.js')

type DoctorReport = {
  fixesApplied: string[]
  healthy: boolean
  issues: Array<{code: string; path?: string; scope: string; severity: string}>
}

describe('mdmd doctor command', () => {
  let tempRoot = ''

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, {force: true, recursive: true})
      tempRoot = ''
    }
  })

  it('reports issues in read-only mode and exits with code 1', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-doctor-test-'))
    const {collectionDir, homeDir, indexDbPath, workDir} = await setupDirs(tempRoot)

    await writeFile(path.join(workDir, 'note.md'), '# doctor note\n', 'utf8')
    const ingestResult = runCli(['ingest', 'note.md', '--collection', collectionDir], workDir, homeDir, indexDbPath)
    expect(ingestResult.status, `${ingestResult.stdout}\n${ingestResult.stderr}`).to.equal(0)

    await unlink(path.join(workDir, 'mdmd_notes', 'note.md'))

    const doctorResult = runCli(
      ['doctor', '--scope', 'symlinks', '--collection', collectionDir, '--json'],
      workDir,
      homeDir,
      indexDbPath,
    )
    expect(doctorResult.status, `${doctorResult.stdout}\n${doctorResult.stderr}`).to.equal(1)

    const report = JSON.parse(doctorResult.stdout.trim()) as DoctorReport
    expect(report.healthy).to.equal(false)
    expect(report.issues.some((issue) => issue.code === 'symlinks.missing')).to.equal(true)
  })

  it('fixes safe symlink issues with --fix and exits with code 0 when healthy', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-doctor-test-'))
    const {collectionDir, homeDir, indexDbPath, workDir} = await setupDirs(tempRoot)
    const workingNotesDir = path.join(workDir, 'mdmd_notes')

    await writeFile(path.join(workDir, 'note.md'), '# doctor note\n', 'utf8')
    const ingestResult = runCli(['ingest', 'note.md', '--collection', collectionDir], workDir, homeDir, indexDbPath)
    expect(ingestResult.status, `${ingestResult.stdout}\n${ingestResult.stderr}`).to.equal(0)

    await unlink(path.join(workingNotesDir, 'note.md'))
    const orphanTarget = path.join(collectionDir, 'orphan-target.md')
    await writeFile(orphanTarget, '# orphan target\n', 'utf8')
    await symlink(orphanTarget, path.join(workingNotesDir, 'orphan.md'))

    const doctorResult = runCli(
      ['doctor', '--scope', 'symlinks', '--fix', '--collection', collectionDir, '--json'],
      workDir,
      homeDir,
      indexDbPath,
    )
    expect(doctorResult.status, `${doctorResult.stdout}\n${doctorResult.stderr}`).to.equal(0)

    const report = JSON.parse(doctorResult.stdout.trim()) as DoctorReport
    expect(report.healthy).to.equal(true)
    expect(report.issues).to.deep.equal([])
    expect(report.fixesApplied.some((fix) => fix.startsWith('reconcile_symlinks'))).to.equal(true)

    await expectPathExists(path.join(workingNotesDir, 'note.md'))
    await expectPathMissing(path.join(workingNotesDir, 'orphan.md'))
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
