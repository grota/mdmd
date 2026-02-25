import {Args, Command, Flags} from '@oclif/core'

import {createMdmdRuntime} from '../../lib/config'
import {
  getConfigValue,
  getSupportedConfigKeysMessage,
  isSupportedConfigKey,
  type SupportedConfigKey,
} from '../../lib/config-command'

type ConfigGetOutput = {
  key: SupportedConfigKey
  value: string
}

export default class ConfigGet extends Command {
  static override args = {
    key: Args.string({
      description: 'Configuration key to read',
      required: true,
    }),
  }
  static override description = 'Get a mdmd configuration value'
  public static override enableJsonFlag = true
  static override examples = [
    '<%= config.bin %> <%= command.id %> collection',
    '<%= config.bin %> <%= command.id %> collection --resolved',
  ]
  static override flags = {
    resolved: Flags.boolean({
      description: 'Resolve effective values including env/Obsidian fallback',
    }),
  }

  async run(): Promise<ConfigGetOutput> {
    const {args, flags} = await this.parse(ConfigGet)
    if (!isSupportedConfigKey(args.key)) {
      this.error(getSupportedConfigKeysMessage(), {exit: 1})
    }

    const runtime = createMdmdRuntime(this.config.configDir)
    try {
      const value = await getConfigValue(runtime, args.key, Boolean(flags.resolved))
      this.log(value)
      return {key: args.key, value}
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.error(message, {exit: 1})
    }
  }
}
