import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import {access, lstat, mkdir, mkdtemp, readdir, readlink, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {stringifyFrontmatter} from '../../src/lib/frontmatter'
import {INDEX_DB_PATH_ENV_VAR} from '../../src/lib/index-db'

const filePath = fileURLToPath(import.meta.url)
const testDir = path.dirname(filePath)
const repoRoot = path.resolve(testDir, '../..')
const cliEntrypoint = path.join(repoRoot, 'bin', 'dev.js')

describe('mdmd sync command', () => {
  let tempRoot = ''

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, {force: true, recursive: true})
      tempRoot = ''
    }
  })

  it('mirrors managed notes for cwd and reconciles stale/wrong symlinks', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-sync-test-'))
    const workDir = path.join(tempRoot, 'work')
    const collectionDir = path.join(tempRoot, 'collection')
    const homeDir = path.join(tempRoot, 'home')
    const indexDbPath = path.join(tempRoot, 'index.db')
    const workingNotesDir = path.join(workDir, 'mdmd_notes')
    await mkdir(workDir, {recursive: true})
    await mkdir(collectionDir, {recursive: true})
    await mkdir(homeDir, {recursive: true})
    await mkdir(workingNotesDir, {recursive: true})

    const managedNotePath = path.join(collectionDir, 'managed.md')
    const unmanagedNotePath = path.join(collectionDir, 'unmanaged.md')
    const foreignNotePath = path.join(collectionDir, 'foreign.md')

    await writeMarkdownNote(
      managedNotePath,
      {
        // eslint-disable-next-line camelcase
        mdmd_id: '11111111-1111-4111-8111-111111111111',
        paths: [workDir],
      },
      '# managed\n',
    )
    await writeMarkdownNote(unmanagedNotePath, {}, '# unmanaged\n')
    await writeMarkdownNote(
      foreignNotePath,
      {
        // eslint-disable-next-line camelcase
        mdmd_id: '22222222-2222-4222-8222-222222222222',
        paths: ['/tmp/elsewhere'],
      },
      '# foreign\n',
    )

    await symlink(foreignNotePath, path.join(workingNotesDir, 'managed.md'))
    await symlink(managedNotePath, path.join(workingNotesDir, 'stale.md'))

    const result = spawnSync('bun', [cliEntrypoint, 'sync', '--collection', collectionDir], {
      cwd: workDir,
      encoding: 'utf8',
      env: {...process.env, HOME: homeDir, [INDEX_DB_PATH_ENV_VAR]: indexDbPath},
    })

    expect(result.status, `${result.stdout}\n${result.stderr}`).to.equal(0)

    await expectSymlinkTarget(path.join(workingNotesDir, 'managed.md'), managedNotePath)
    await expectPathMissing(path.join(workingNotesDir, 'stale.md'))
    await expectPathMissing(path.join(workingNotesDir, 'unmanaged.md'))

    const syncedEntries = await readdir(workingNotesDir)
    expect(syncedEntries).to.deep.equal(['managed.md'])
  })

  it('disambiguates basename collisions using parent directory suffix', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-sync-test-'))
    const workDir = path.join(tempRoot, 'work')
    const collectionDir = path.join(tempRoot, 'collection')
    const homeDir = path.join(tempRoot, 'home')
    const indexDbPath = path.join(tempRoot, 'index.db')
    await mkdir(workDir, {recursive: true})
    await mkdir(path.join(collectionDir, 'alpha'), {recursive: true})
    await mkdir(path.join(collectionDir, 'beta'), {recursive: true})
    await mkdir(homeDir, {recursive: true})

    const alphaNotePath = path.join(collectionDir, 'alpha', 'note.md')
    const betaNotePath = path.join(collectionDir, 'beta', 'note.md')

    await writeMarkdownNote(
      alphaNotePath,
      {
        // eslint-disable-next-line camelcase
        mdmd_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        paths: [workDir],
      },
      '# alpha\n',
    )
    await writeMarkdownNote(
      betaNotePath,
      {
        // eslint-disable-next-line camelcase
        mdmd_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        paths: [workDir],
      },
      '# beta\n',
    )

    const result = spawnSync('bun', [cliEntrypoint, 'sync', '--collection', collectionDir], {
      cwd: workDir,
      encoding: 'utf8',
      env: {...process.env, HOME: homeDir, [INDEX_DB_PATH_ENV_VAR]: indexDbPath},
    })

    expect(result.status, `${result.stdout}\n${result.stderr}`).to.equal(0)

    const workingNotesDir = path.join(workDir, 'mdmd_notes')
    await expectSymlinkTarget(path.join(workingNotesDir, 'note.md'), alphaNotePath)
    await expectSymlinkTarget(path.join(workingNotesDir, 'note__beta.md'), betaNotePath)
  })
})

async function writeMarkdownNote(filePath: string, frontmatter: Record<string, unknown>, body: string): Promise<void> {
  const markdown = stringifyFrontmatter(frontmatter, body)
  await writeFile(filePath, markdown, 'utf8')
}

async function expectSymlinkTarget(symlinkPath: string, expectedTarget: string): Promise<void> {
  const symlinkStat = await lstat(symlinkPath)
  expect(symlinkStat.isSymbolicLink()).to.equal(true)

  const targetPath = await readlink(symlinkPath)
  expect(path.resolve(path.dirname(symlinkPath), targetPath)).to.equal(expectedTarget)
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
