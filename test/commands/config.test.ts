import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parse} from 'yaml'

import {XDG_CONFIG_HOME_ENV_VAR} from '../../src/lib/config'

type ConfigListReport = {
  collection: null | string
  resolvedCollection?: null | string
}

const filePath = fileURLToPath(import.meta.url)
const testDir = path.dirname(filePath)
const repoRoot = path.resolve(testDir, '../..')
const cliEntrypoint = path.join(repoRoot, 'bin', 'dev.js')

describe('mdmd config command', () => {
  let tempRoot = ''

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, {force: true, recursive: true})
      tempRoot = ''
    }
  })

  it('supports set/get/unset for collection config', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-config-cmd-test-'))
    const {homeDir, workDir, xdgConfigHome} = await setupDirs(tempRoot)

    const setResult = runCli(['config', 'set', 'collection', '/vault/one'], workDir, homeDir, xdgConfigHome)
    expect(setResult.status, `${setResult.stdout}\n${setResult.stderr}`).to.equal(0)

    const configPath = path.join(xdgConfigHome, 'mdmd', 'config.yaml')
    const configContents = await readFile(configPath, 'utf8')
    const parsedConfig = parse(configContents) as {collection?: string}
    expect(parsedConfig.collection).to.equal('/vault/one')

    const getResult = runCli(['config', 'get', 'collection'], workDir, homeDir, xdgConfigHome)
    expect(getResult.status, `${getResult.stdout}\n${getResult.stderr}`).to.equal(0)
    expect(getResult.stdout.trim()).to.equal('/vault/one')

    const unsetResult = runCli(['config', 'unset', 'collection'], workDir, homeDir, xdgConfigHome)
    expect(unsetResult.status, `${unsetResult.stdout}\n${unsetResult.stderr}`).to.equal(0)

    const getMissingResult = runCli(['config', 'get', 'collection'], workDir, homeDir, xdgConfigHome)
    expect(getMissingResult.status).to.not.equal(0)
  })

  it('shows resolved value from Obsidian fallback when config key is unset', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-config-cmd-test-'))
    const {homeDir, workDir, xdgConfigHome} = await setupDirs(tempRoot)
    const obsidianDir = path.join(xdgConfigHome, 'obsidian')
    await mkdir(obsidianDir, {recursive: true})
    await writeFile(
      path.join(obsidianDir, 'obsidian.json'),
      JSON.stringify(
        {
          lastOpenVault: 'vault-a',
          vaults: {
            'vault-a': {
              path: '/vault/from-obsidian',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    )

    const listResult = runCli(['config', 'list', '--resolved', '--json'], workDir, homeDir, xdgConfigHome)
    expect(listResult.status, `${listResult.stdout}\n${listResult.stderr}`).to.equal(0)

    const report = JSON.parse(listResult.stdout.trim()) as ConfigListReport
    expect(report.collection).to.equal(null)
    expect(report.resolvedCollection).to.equal('/vault/from-obsidian')
  })
})

function runCli(args: string[], cwd: string, homeDir: string, xdgConfigHome: string): ReturnType<typeof spawnSync> {
  return spawnSync('bun', [cliEntrypoint, ...args], {
    cwd,
    encoding: 'utf8',
    env: {...process.env, HOME: homeDir, [XDG_CONFIG_HOME_ENV_VAR]: xdgConfigHome},
  })
}

async function setupDirs(tempPath: string): Promise<{homeDir: string; workDir: string; xdgConfigHome: string}> {
  const workDir = path.join(tempPath, 'work')
  const homeDir = path.join(tempPath, 'home')
  const xdgConfigHome = path.join(tempPath, 'xdg-config')

  await mkdir(workDir, {recursive: true})
  await mkdir(homeDir, {recursive: true})
  await mkdir(xdgConfigHome, {recursive: true})

  return {homeDir, workDir, xdgConfigHome}
}
