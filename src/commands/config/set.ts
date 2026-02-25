import {Args, Command} from '@oclif/core'

import {createMdmdRuntime} from '../../lib/config'
import {getSupportedConfigKeysMessage, isSupportedConfigKey, setConfigValue, type SupportedConfigKey} from '../../lib/config-command'

type ConfigSetOutput = Record<SupportedConfigKey, string>

export default class ConfigSet extends Command {
  static override args = {
    key: Args.string({
      description: 'Configuration key to set',
      required: true,
    }),
    value: Args.string({
      description: 'New value',
      required: true,
    }),
  }
  static override description = 'Set a mdmd configuration value'
  public static override enableJsonFlag = true
  static override examples = ['<%= config.bin %> <%= command.id %> collection "/path/to/vault"']

  async run(): Promise<ConfigSetOutput> {
    const {args} = await this.parse(ConfigSet)
    if (!isSupportedConfigKey(args.key)) {
      this.error(getSupportedConfigKeysMessage(), {exit: 1})
    }

    const runtime = createMdmdRuntime(this.config.configDir)
    await setConfigValue(runtime, args.key, args.value)
    this.log(`Set ${args.key}=${args.value}`)
    return {[args.key]: args.value}
  }
}
