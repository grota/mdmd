import {Command, Flags} from '@oclif/core'

import {
  createMdmdRuntime,
  type MdmdConfig,
  type MdmdRuntime,
  readMdmdConfig,
  resolveCollectionPathFromMdmdConfig,
  resolveCollectionRoot,
  writeMdmdConfig,
} from '../lib/config'

type ConfigOutput = {
  collection: null | string
  resolvedCollection?: null | string
  resolvedError?: null | string
}

type ConfigGetOutput = {
  key: string
  value: string
}

type ConfigMutationOutput = Record<string, null | string>
type ConfigActionOutput = ConfigGetOutput | ConfigMutationOutput | ConfigOutput

export default class Config extends Command {
  static override description = 'Read and manage mdmd configuration'
  public static override enableJsonFlag = true
  static override examples = [
    '<%= config.bin %> <%= command.id %> list --resolved',
    '<%= config.bin %> <%= command.id %> get collection',
    '<%= config.bin %> <%= command.id %> set collection "/path/to/vault"',
    '<%= config.bin %> <%= command.id %> unset collection',
  ]
  static override flags = {
    resolved: Flags.boolean({
      description: 'Resolve effective values including env/Obsidian fallback',
    }),
  }
  static override strict = false

  async run(): Promise<ConfigActionOutput> {
    const {argv, flags} = await this.parse(Config)
    const runtime = createMdmdRuntime(this.config.configDir)

    const [action = 'list', ...rest] = argv.map(String)

    if (action === 'list') {
      return this.handleList(runtime, flags)
    }

    if (action === 'get') {
      const key = rest[0]
      if (!isSupportedKey(key)) {
        this.error('Supported config keys: collection', {exit: 1})
      }

      return this.handleGet(runtime, flags, key)
    }

    if (action === 'set') {
      const key = rest[0]
      if (!isSupportedKey(key)) {
        this.error('Supported config keys: collection', {exit: 1})
      }

      const value = rest.slice(1).join(' ').trim()
      if (value.length === 0) {
        this.error('Usage: mdmd config set collection <value>', {exit: 1})
      }

      return this.handleSet(runtime, key, value)
    }

    if (action === 'unset') {
      const key = rest[0]
      if (!isSupportedKey(key)) {
        this.error('Supported config keys: collection', {exit: 1})
      }

      return this.handleUnset(runtime, key)
    }

    this.error(`Unknown config action: ${action}. Use list|get|set|unset.`, {exit: 1})
  }

  private async handleGet(runtime: MdmdRuntime, flags: {resolved?: boolean}, key: string): Promise<ConfigGetOutput> {
    const config = await readMdmdConfig(runtime)
    const rawValue = readConfigValue(config, key)

    if (flags.resolved) {
      try {
        const resolved = await resolveCollectionRoot(undefined, runtime)
        this.log(resolved)
        return {key, value: resolved}
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.error(message, {exit: 1})
      }
    }

    if (!rawValue) {
      this.error(`Config key is not set: ${key}`, {exit: 1})
    }

    this.log(rawValue)
    return {key, value: rawValue}
  }

  private async handleList(runtime: MdmdRuntime, flags: {resolved?: boolean}): Promise<ConfigOutput> {
    const config = await readMdmdConfig(runtime)
    const output = await buildConfigOutput(config, Boolean(flags.resolved), runtime)

    this.log(`collection: ${output.collection ?? '(unset)'}`)
    if (flags.resolved) {
      const {resolvedCollection} = output
      if (resolvedCollection) {
        this.log(`collection (resolved): ${resolvedCollection}`)
      } else {
        this.log(`collection (resolved): (unresolved: ${output.resolvedError ?? 'unknown error'})`)
      }
    }

    return output
  }

  private async handleSet(runtime: MdmdRuntime, key: string, value: string): Promise<Record<string, string>> {
    const config = await readMdmdConfig(runtime)
    const nextConfig: MdmdConfig = {...config}

    if (key === 'collection') {
      nextConfig.collection = value
      delete nextConfig.collectionPath
    }

    await writeMdmdConfig(nextConfig, runtime)
    this.log(`Set ${key}=${value}`)
    return {[key]: value}
  }

  private async handleUnset(runtime: MdmdRuntime, key: string): Promise<ConfigMutationOutput> {
    const config = await readMdmdConfig(runtime)
    const nextConfig: MdmdConfig = {...config}

    if (key === 'collection') {
      delete nextConfig.collection
      delete nextConfig.collectionPath
    }

    await writeMdmdConfig(nextConfig, runtime)
    this.log(`Unset ${key}`)
    return {[key]: null}
  }
}

function isSupportedKey(key: string | undefined): key is string {
  return key === 'collection'
}

function readConfigValue(config: MdmdConfig, key: string): string | undefined {
  if (key !== 'collection') {
    return undefined
  }

  return resolveCollectionPathFromMdmdConfig(config)
}

async function buildConfigOutput(config: MdmdConfig, includeResolved: boolean, runtime: MdmdRuntime): Promise<ConfigOutput> {
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
