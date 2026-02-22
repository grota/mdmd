import {Command, Flags} from '@oclif/core'

import {
  type MdmdConfig,
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

export default class Config extends Command {
  static override description = 'Read and manage mdmd configuration'
  static override examples = [
    '<%= config.bin %> <%= command.id %> list --resolved',
    '<%= config.bin %> <%= command.id %> get collection',
    '<%= config.bin %> <%= command.id %> set collection "/path/to/vault"',
    '<%= config.bin %> <%= command.id %> unset collection',
  ]
  static override flags = {
    json: Flags.boolean({
      description: 'Emit JSON output',
    }),
    resolved: Flags.boolean({
      description: 'Resolve effective values including env/Obsidian fallback',
    }),
  }
  static override strict = false

  async run(): Promise<void> {
    const {argv, flags} = await this.parse(Config)
    const [action = 'list', ...rest] = argv.map(String)

    if (action === 'list') {
      await this.handleList(flags)
      return
    }

    if (action === 'get') {
      const key = rest[0]
      if (!isSupportedKey(key)) {
        this.error('Supported config keys: collection', {exit: 1})
      }

      await this.handleGet(flags, key)
      return
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

      await this.handleSet(key, value)
      return
    }

    if (action === 'unset') {
      const key = rest[0]
      if (!isSupportedKey(key)) {
        this.error('Supported config keys: collection', {exit: 1})
      }

      await this.handleUnset(key)
      return
    }

    this.error(`Unknown config action: ${action}. Use list|get|set|unset.`, {exit: 1})
  }

  private async handleGet(flags: {json?: boolean; resolved?: boolean}, key: string): Promise<void> {
    const config = await readMdmdConfig()
    const rawValue = readConfigValue(config, key)

    if (flags.resolved) {
      let resolved = ''
      try {
        resolved = await resolveCollectionRoot()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.error(message, {exit: 1})
      }

      if (flags.json) {
        this.log(JSON.stringify({key, value: resolved}, null, 2))
      } else {
        this.log(resolved)
      }

      return
    }

    if (!rawValue) {
      this.error(`Config key is not set: ${key}`, {exit: 1})
    }

    if (flags.json) {
      this.log(JSON.stringify({key, value: rawValue}, null, 2))
    } else {
      this.log(rawValue)
    }
  }

  private async handleList(flags: {json?: boolean; resolved?: boolean}): Promise<void> {
    const config = await readMdmdConfig()
    const output = await buildConfigOutput(config, Boolean(flags.resolved))

    if (flags.json) {
      this.log(JSON.stringify(output, null, 2))
      return
    }

    this.log(`collection: ${output.collection ?? '(unset)'}`)
    if (flags.resolved) {
      if (output.resolvedCollection) {
        this.log(`collection (resolved): ${output.resolvedCollection}`)
      } else {
        this.log(`collection (resolved): (unresolved: ${output.resolvedError ?? 'unknown error'})`)
      }
    }
  }

  private async handleSet(key: string, value: string): Promise<void> {
    const config = await readMdmdConfig()
    const nextConfig: MdmdConfig = {...config}

    if (key === 'collection') {
      nextConfig.collection = value
      delete nextConfig.collectionPath
    }

    await writeMdmdConfig(nextConfig)
    this.log(`Set ${key}=${value}`)
  }

  private async handleUnset(key: string): Promise<void> {
    const config = await readMdmdConfig()
    const nextConfig: MdmdConfig = {...config}

    if (key === 'collection') {
      delete nextConfig.collection
      delete nextConfig.collectionPath
    }

    await writeMdmdConfig(nextConfig)
    this.log(`Unset ${key}`)
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

async function buildConfigOutput(config: MdmdConfig, includeResolved: boolean): Promise<ConfigOutput> {
  const output: ConfigOutput = {
    collection: resolveCollectionPathFromMdmdConfig(config) ?? null,
  }

  if (!includeResolved) {
    return output
  }

  try {
    output.resolvedCollection = await resolveCollectionRoot()
    output.resolvedError = null
  } catch (error) {
    output.resolvedCollection = null
    output.resolvedError = error instanceof Error ? error.message : String(error)
  }

  return output
}
