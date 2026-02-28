import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import path from 'node:path'
import {parse, stringify} from 'yaml'

export const COLLECTION_PATH_ENV_VAR = 'MDMD_COLLECTION_PATH'
export const CONFIG_PATH_ENV_VAR = 'MDMD_CONFIG_PATH'
export const OBSIDIAN_CONFIG_PATH_ENV_VAR = 'MDMD_OBSIDIAN_CONFIG_PATH'
export const XDG_CONFIG_HOME_ENV_VAR = 'XDG_CONFIG_HOME'

export const SYMLINK_DIR_DEFAULT = 'mdmd_notes'
export const INGEST_DEST_DEFAULT = 'inbox'

export const SUPPORTED_CONFIG_KEYS = ['collection', 'ingest-dest', 'preview-cmd', 'symlink-dir'] as const
export type SupportedConfigKey = (typeof SUPPORTED_CONFIG_KEYS)[number]

export type MdmdConfig = {
  [key: string]: unknown
  collection?: string
  'ingest-dest'?: string
  'preview-cmd'?: string
  'symlink-dir'?: string
}

export type MdmdRuntime = {
  configDir: string
  mdmdConfigPath: string
  obsidianConfigPath: string
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

function resolveEnvPath(envVarName: string): string | undefined {
  const value = process.env[envVarName]
  if (value && value.trim().length > 0) {
    return path.resolve(value)
  }

  return undefined
}

export function createMdmdRuntime(configDir?: string): MdmdRuntime {
  const resolvedConfigDir = path.resolve(configDir ?? path.join(getXdgConfigHome(), 'mdmd'))
  return {
    configDir: resolvedConfigDir,
    mdmdConfigPath: resolveEnvPath(CONFIG_PATH_ENV_VAR) ?? path.join(resolvedConfigDir, 'config.yaml'),
    obsidianConfigPath:
      resolveEnvPath(OBSIDIAN_CONFIG_PATH_ENV_VAR) ?? path.resolve(resolvedConfigDir, '..', 'obsidian', 'obsidian.json'),
  }
}

export function getMdmdConfigPath(runtime: MdmdRuntime = createMdmdRuntime()): string {
  return runtime.mdmdConfigPath
}

export function getObsidianConfigPath(runtime: MdmdRuntime = createMdmdRuntime()): string {
  return runtime.obsidianConfigPath
}

export async function readMdmdConfig(runtime: MdmdRuntime = createMdmdRuntime()): Promise<MdmdConfig> {
  const configPath = getMdmdConfigPath(runtime)

  try {
    const contents = await readFile(configPath, 'utf8')
    const parsed = parse(contents) as unknown
    if (parsed === undefined || parsed === null) {
      return {}
    }

    if (!isRecord(parsed)) {
      throw new Error(`Invalid config at ${configPath}: expected an object`)
    }

    validateMdmdConfig(parsed, configPath)
    return parsed as MdmdConfig
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException
    if (maybeError.code === 'ENOENT') {
      return {}
    }

    throw error
  }
}

export async function writeMdmdConfig(config: MdmdConfig, runtime: MdmdRuntime = createMdmdRuntime()): Promise<void> {
  const configPath = getMdmdConfigPath(runtime)
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

export async function resolveCollectionRoot(
  flagOverride?: string,
  runtime: MdmdRuntime = createMdmdRuntime(),
): Promise<string> {
  const config = await readMdmdConfig(runtime)
  const configPath = resolveCollectionPathFromConfig(config)
  const envPath = process.env[COLLECTION_PATH_ENV_VAR]

  const rawPath = pickFirstNonEmpty(flagOverride, envPath, configPath)
  if (rawPath) {
    return path.resolve(rawPath)
  }

  const obsidianPath = await resolveObsidianVaultPath(runtime)
  if (obsidianPath) {
    return path.resolve(obsidianPath)
  }

  throw new Error(
    'Could not resolve collection path. Use --collection, MDMD_COLLECTION_PATH, `mdmd config set collection <path>`, or open an Obsidian vault.',
  )
}

function validateMdmdConfig(config: Record<string, unknown>, configPath: string): void {
  const allowed = new Set<string>(SUPPORTED_CONFIG_KEYS)
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) {
      throw new Error(
        `Unknown config key '${key}' in ${configPath}. Valid keys: ${[...allowed].join(', ')}`,
      )
    }

    if (config[key] !== undefined && typeof config[key] !== 'string') {
      throw new Error(`Config key '${key}' must be a string in ${configPath}`)
    }
  }
}

function resolveCollectionPathFromConfig(config: MdmdConfig): string | undefined {
  if (typeof config.collection === 'string' && config.collection.trim().length > 0) {
    return config.collection
  }

  return undefined
}

async function resolveObsidianVaultPath(runtime: MdmdRuntime): Promise<string | undefined> {
  const obsidianConfigPath = getObsidianConfigPath(runtime)

  try {
    const contents = await readFile(obsidianConfigPath, 'utf8')
    const parsed = JSON.parse(contents) as unknown
    if (!isRecord(parsed)) {
      return undefined
    }

    // Some Obsidian variants persist the active vault path directly.
    const directPath = parsed.currentVaultPath
    if (typeof directPath === 'string' && directPath.trim().length > 0) {
      return directPath
    }

    // Other variants persist vaults keyed by ID and expose activity hints
    // such as lastOpenVault and/or per-vault open=true.
    const {vaults} = parsed
    if (!isRecord(vaults)) {
      return undefined
    }

    const candidates: string[] = []
    if (typeof parsed.lastOpenVault === 'string' && parsed.lastOpenVault.trim().length > 0) {
      candidates.push(parsed.lastOpenVault)
    }

    // Keep support broad by also considering any vault currently marked as open.
    for (const [vaultId, vaultValue] of Object.entries(vaults)) {
      if (isRecord(vaultValue) && vaultValue.open === true) {
        candidates.push(vaultId)
      }
    }

    // Return the first candidate with a valid path.
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

export function resolveSymlinkDir(config: MdmdConfig): string {
  const val = config['symlink-dir']
  if (typeof val === 'string' && val.trim().length > 0) return val.trim()
  return SYMLINK_DIR_DEFAULT
}

export function resolveIngestDest(config: MdmdConfig, flagOverride?: string): string {
  if (flagOverride && flagOverride.trim().length > 0) return flagOverride.trim()
  const val = config['ingest-dest']
  if (typeof val === 'string' && val.trim().length > 0) return val.trim()
  return INGEST_DEST_DEFAULT
}
