import {
  type MdmdConfig,
  type MdmdRuntime,
  readMdmdConfig,
  resolveCollectionPathFromMdmdConfig,
  resolveCollectionRoot,
  SUPPORTED_CONFIG_KEYS,
  type SupportedConfigKey,
  writeMdmdConfig,
} from './config'

export type {SupportedConfigKey} from './config'
export {SUPPORTED_CONFIG_KEYS} from './config'

export type ConfigOutput = {
  collection: null | string
  'ingest-dest': null | string
  resolvedCollection?: null | string
  resolvedError?: null | string
  'symlink-dir': null | string
}

export function getSupportedConfigKeysMessage(): string {
  return `Supported config keys: ${SUPPORTED_CONFIG_KEYS.join(', ')}`
}

export function isSupportedConfigKey(key: string | undefined): key is SupportedConfigKey {
  return SUPPORTED_CONFIG_KEYS.includes(key as SupportedConfigKey)
}

export function readConfigValue(config: MdmdConfig, key: SupportedConfigKey): string | undefined {
  if (key === 'collection') {
    return resolveCollectionPathFromMdmdConfig(config)
  }

  const val = config[key]
  return typeof val === 'string' && val.trim().length > 0 ? val : undefined
}

export async function listConfigValues(runtime: MdmdRuntime, includeResolved: boolean): Promise<ConfigOutput> {
  const config = await readMdmdConfig(runtime)
  const output: ConfigOutput = {
    collection: resolveCollectionPathFromMdmdConfig(config) ?? null,
    'ingest-dest': (typeof config['ingest-dest'] === 'string' ? config['ingest-dest'] : null),
    'symlink-dir': (typeof config['symlink-dir'] === 'string' ? config['symlink-dir'] : null),
  }

  if (!includeResolved) {
    return output
  }

  try {
    output.resolvedCollection = await resolveCollectionRoot(undefined, runtime)
    output.resolvedError = null
  } catch (error) {
    output.resolvedCollection = null
    output.resolvedError = error instanceof Error ? error.message : String(error)
  }

  return output
}

export async function getConfigValue(
  runtime: MdmdRuntime,
  key: SupportedConfigKey,
  resolved: boolean,
): Promise<string> {
  if (resolved && key === 'collection') {
    return resolveCollectionRoot(undefined, runtime)
  }

  const config = await readMdmdConfig(runtime)
  const value = readConfigValue(config, key)
  if (!value) {
    throw new Error(`Config key is not set: ${key}`)
  }

  return value
}

export async function setConfigValue(runtime: MdmdRuntime, key: SupportedConfigKey, value: string): Promise<void> {
  const config = await readMdmdConfig(runtime)
  const nextConfig: MdmdConfig = {...config, [key]: value}
  await writeMdmdConfig(nextConfig, runtime)
}

export async function unsetConfigValue(runtime: MdmdRuntime, key: SupportedConfigKey): Promise<void> {
  const config = await readMdmdConfig(runtime)
  const nextConfig: MdmdConfig = {...config}
  delete nextConfig[key]
  await writeMdmdConfig(nextConfig, runtime)
}
