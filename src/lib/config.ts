import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import path from 'node:path'
import {parse, stringify} from 'yaml'

export const COLLECTION_PATH_ENV_VAR = 'MDMD_COLLECTION_PATH'
export const CONFIG_PATH_ENV_VAR = 'MDMD_CONFIG_PATH'
export const OBSIDIAN_CONFIG_PATH_ENV_VAR = 'MDMD_OBSIDIAN_CONFIG_PATH'
export const XDG_CONFIG_HOME_ENV_VAR = 'XDG_CONFIG_HOME'

export type MdmdConfig = {
  [key: string]: unknown
  collection?: unknown
  collectionPath?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function getXdgConfigHome(): string {
  const xdgConfigHome = process.env[XDG_CONFIG_HOME_ENV_VAR]
  if (xdgConfigHome && xdgConfigHome.trim().length > 0) {
    return path.resolve(xdgConfigHome)
  }

  return path.join(homedir(), '.config')
}

export function getMdmdConfigPath(): string {
  const override = process.env[CONFIG_PATH_ENV_VAR]
  if (override && override.trim().length > 0) {
    return path.resolve(override)
  }

  return path.join(getXdgConfigHome(), 'mdmd', 'config.yaml')
}

export function getObsidianConfigPath(): string {
  const override = process.env[OBSIDIAN_CONFIG_PATH_ENV_VAR]
  if (override && override.trim().length > 0) {
    return path.resolve(override)
  }

  return path.join(getXdgConfigHome(), 'obsidian', 'obsidian.json')
}

export async function readMdmdConfig(): Promise<MdmdConfig> {
  const configPath = getMdmdConfigPath()

  try {
    const contents = await readFile(configPath, 'utf8')
    const parsed = parse(contents) as unknown
    if (parsed === undefined || parsed === null) {
      return {}
    }

    if (!isRecord(parsed)) {
      throw new Error(`Invalid config at ${configPath}: expected an object`)
    }

    return parsed as MdmdConfig
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException
    if (maybeError.code === 'ENOENT') {
      return {}
    }

    throw error
  }
}

export async function writeMdmdConfig(config: MdmdConfig): Promise<void> {
  const configPath = getMdmdConfigPath()
  await mkdir(path.dirname(configPath), {recursive: true})

  const serialized = stringify(config).trim()
  if (serialized.length === 0) {
    await writeFile(configPath, '{}\n', 'utf8')
    return
  }

  await writeFile(configPath, `${serialized}\n`, 'utf8')
}

function pickFirstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value && value.trim().length > 0) {
      return value
    }
  }

  return undefined
}

export async function resolveCollectionRoot(flagOverride?: string): Promise<string> {
  const config = await readMdmdConfig()
  const configPath = resolveCollectionPathFromConfig(config)
  const envPath = process.env[COLLECTION_PATH_ENV_VAR]

  const rawPath = pickFirstNonEmpty(flagOverride, envPath, configPath)
  if (rawPath) {
    return path.resolve(rawPath)
  }

  const obsidianPath = await resolveObsidianVaultPath()
  if (obsidianPath) {
    return path.resolve(obsidianPath)
  }

  throw new Error(
    'Could not resolve collection path. Use --collection, MDMD_COLLECTION_PATH, `mdmd config set collection <path>`, or open an Obsidian vault.',
  )
}

function resolveCollectionPathFromConfig(config: MdmdConfig): string | undefined {
  if (typeof config.collection === 'string' && config.collection.trim().length > 0) {
    return config.collection
  }

  if (typeof config.collectionPath === 'string' && config.collectionPath.trim().length > 0) {
    return config.collectionPath
  }

  return undefined
}

async function resolveObsidianVaultPath(): Promise<string | undefined> {
  const obsidianConfigPath = getObsidianConfigPath()

  try {
    const contents = await readFile(obsidianConfigPath, 'utf8')
    const parsed = JSON.parse(contents) as unknown
    if (!isRecord(parsed)) {
      return undefined
    }

    const directPath = parsed.currentVaultPath
    if (typeof directPath === 'string' && directPath.trim().length > 0) {
      return directPath
    }

    const {vaults} = parsed
    if (!isRecord(vaults)) {
      return undefined
    }

    const candidates: string[] = []
    if (typeof parsed.lastOpenVault === 'string' && parsed.lastOpenVault.trim().length > 0) {
      candidates.push(parsed.lastOpenVault)
    }

    for (const [vaultId, vaultValue] of Object.entries(vaults)) {
      if (isRecord(vaultValue) && vaultValue.open === true) {
        candidates.push(vaultId)
      }
    }

    for (const candidate of candidates) {
      const vaultValue = vaults[candidate]
      if (!isRecord(vaultValue)) {
        continue
      }

      const vaultPath = vaultValue.path
      if (typeof vaultPath === 'string' && vaultPath.trim().length > 0) {
        return vaultPath
      }
    }
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException
    if (maybeError.code === 'ENOENT') {
      return undefined
    }

    throw error
  }

  return undefined
}

export function resolveCollectionPathFromMdmdConfig(config: MdmdConfig): string | undefined {
  return resolveCollectionPathFromConfig(config)
}
