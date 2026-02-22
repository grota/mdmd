import {expect} from 'chai'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'

import {
  COLLECTION_PATH_ENV_VAR,
  CONFIG_PATH_ENV_VAR,
  OBSIDIAN_CONFIG_PATH_ENV_VAR,
  resolveCollectionRoot,
  XDG_CONFIG_HOME_ENV_VAR,
} from '../../src/lib/config'

describe('collection path resolution', () => {
  const originalHome = process.env.HOME
  const originalCollectionEnv = process.env[COLLECTION_PATH_ENV_VAR]
  const originalConfigPath = process.env[CONFIG_PATH_ENV_VAR]
  const originalObsidianPath = process.env[OBSIDIAN_CONFIG_PATH_ENV_VAR]
  const originalXdgConfigHome = process.env[XDG_CONFIG_HOME_ENV_VAR]

  let tempRoot = ''

  afterEach(async () => {
    process.env.HOME = originalHome
    restoreEnv(COLLECTION_PATH_ENV_VAR, originalCollectionEnv)
    restoreEnv(CONFIG_PATH_ENV_VAR, originalConfigPath)
    restoreEnv(OBSIDIAN_CONFIG_PATH_ENV_VAR, originalObsidianPath)
    restoreEnv(XDG_CONFIG_HOME_ENV_VAR, originalXdgConfigHome)

    if (tempRoot) {
      await rm(tempRoot, {force: true, recursive: true})
      tempRoot = ''
    }
  })

  it('prefers flag over env, mdmd config, and Obsidian fallback', async () => {
    await setupConfigFixtures({
      mdmdConfigYaml: 'collection: /from-config\n',
      obsidianConfig: {
        lastOpenVault: 'vault-a',
        vaults: {
          'vault-a': {path: '/from-obsidian'},
        },
      },
    })
    process.env[COLLECTION_PATH_ENV_VAR] = '/from-env'

    const resolved = await resolveCollectionRoot('/from-flag')
    expect(resolved).to.equal(path.resolve('/from-flag'))
  })

  it('uses env value when flag is not set', async () => {
    await setupConfigFixtures({
      mdmdConfigYaml: 'collection: /from-config\n',
      obsidianConfig: {
        lastOpenVault: 'vault-a',
        vaults: {
          'vault-a': {path: '/from-obsidian'},
        },
      },
    })
    process.env[COLLECTION_PATH_ENV_VAR] = '/from-env'

    const resolved = await resolveCollectionRoot()
    expect(resolved).to.equal(path.resolve('/from-env'))
  })

  it('uses mdmd YAML config value when env and flag are absent', async () => {
    await setupConfigFixtures({
      mdmdConfigYaml: 'collection: /from-config\n',
      obsidianConfig: {
        lastOpenVault: 'vault-a',
        vaults: {
          'vault-a': {path: '/from-obsidian'},
        },
      },
    })
    delete process.env[COLLECTION_PATH_ENV_VAR]

    const resolved = await resolveCollectionRoot()
    expect(resolved).to.equal(path.resolve('/from-config'))
  })

  it('supports legacy collectionPath key in mdmd config', async () => {
    await setupConfigFixtures({
      mdmdConfigYaml: 'collectionPath: /from-legacy-key\n',
    })
    delete process.env[COLLECTION_PATH_ENV_VAR]

    const resolved = await resolveCollectionRoot()
    expect(resolved).to.equal(path.resolve('/from-legacy-key'))
  })

  it('falls back to active Obsidian vault when mdmd/env/flag are absent', async () => {
    await setupConfigFixtures({
      obsidianConfig: {
        lastOpenVault: 'vault-a',
        vaults: {
          'vault-a': {path: '/from-obsidian'},
        },
      },
    })
    delete process.env[COLLECTION_PATH_ENV_VAR]

    const resolved = await resolveCollectionRoot()
    expect(resolved).to.equal(path.resolve('/from-obsidian'))
  })

  it('throws when no collection source is available', async () => {
    await setupConfigFixtures({})
    delete process.env[COLLECTION_PATH_ENV_VAR]

    let errorMessage = ''
    try {
      await resolveCollectionRoot()
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).to.contain('Could not resolve collection path')
  })

  async function setupConfigFixtures(options: {
    mdmdConfigYaml?: string
    obsidianConfig?: Record<string, unknown>
  }): Promise<void> {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-config-test-'))
    const homeDir = path.join(tempRoot, 'home')
    const xdgConfigHome = path.join(tempRoot, 'xdg-config')
    process.env.HOME = homeDir
    process.env[XDG_CONFIG_HOME_ENV_VAR] = xdgConfigHome
    await mkdir(homeDir, {recursive: true})
    await mkdir(xdgConfigHome, {recursive: true})

    if (options.mdmdConfigYaml) {
      const mdmdConfigDir = path.join(xdgConfigHome, 'mdmd')
      await mkdir(mdmdConfigDir, {recursive: true})
      await writeFile(path.join(mdmdConfigDir, 'config.yaml'), options.mdmdConfigYaml, 'utf8')
    }

    if (options.obsidianConfig) {
      const obsidianConfigDir = path.join(xdgConfigHome, 'obsidian')
      await mkdir(obsidianConfigDir, {recursive: true})
      await writeFile(
        path.join(obsidianConfigDir, 'obsidian.json'),
        JSON.stringify(options.obsidianConfig, null, 2),
        'utf8',
      )
    }
  }
})

function restoreEnv(key: string, originalValue: string | undefined): void {
  if (originalValue === undefined) {
    delete process.env[key]
    return
  }

  process.env[key] = originalValue
}
