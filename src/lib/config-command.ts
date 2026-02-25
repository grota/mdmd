import {
  type MdmdConfig,
  type MdmdRuntime,
  readMdmdConfig,
  resolveCollectionPathFromMdmdConfig,
  resolveCollectionRoot,
  writeMdmdConfig,
} from './config'

export const SUPPORTED_CONFIG_KEYS = ['collection'] as const

export type SupportedConfigKey = (typeof SUPPORTED_CONFIG_KEYS)[number]

export type ConfigOutput = {
  collection: null | string
  resolvedCollection?: null | string
  resolvedError?: null | string
}

export function getSupportedConfigKeysMessage(): string {
  return `Supported config keys: ${SUPPORTED_CONFIG_KEYS.join(', ')}`
}

export function isSupportedConfigKey(key: string | undefined): key is SupportedConfigKey {
  return key === 'collection'
}

export function readConfigValue(config: MdmdConfig, key: SupportedConfigKey): string | undefined {
  if (key === 'collection') {
    return resolveCollectionPathFromMdmdConfig(config)
  }
}

export async function listConfigValues(runtime: MdmdRuntime, includeResolved: boolean): Promise<ConfigOutput> {
  const config = await readMdmdConfig(runtime)
  const output: ConfigOutput = {
    collection: resolveCollectionPathFromMdmdConfig(config) ?? null,
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
  if (resolved) {
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
  const nextConfig: MdmdConfig = {...config}

  if (key === 'collection') {
    nextConfig.collection = value
    delete nextConfig.collectionPath
  }

  await writeMdmdConfig(nextConfig, runtime)
}

export async function unsetConfigValue(runtime: MdmdRuntime, key: SupportedConfigKey): Promise<void> {
  const config = await readMdmdConfig(runtime)
  const nextConfig: MdmdConfig = {...config}

  if (key === 'collection') {
    delete nextConfig.collection
    delete nextConfig.collectionPath
  }

  await writeMdmdConfig(nextConfig, runtime)
}
