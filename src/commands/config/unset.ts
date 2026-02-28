import {Args, Command} from '@oclif/core'

import {createMdmdRuntime} from '../../lib/config'
import {getSupportedConfigKeysMessage, isSupportedConfigKey, type SupportedConfigKey, unsetConfigValue} from '../../lib/config-command'

type ConfigUnsetOutput = Record<SupportedConfigKey, null>

export default class ConfigUnset extends Command {
  static override args = {
    key: Args.string({
      description: 'Configuration key to unset',
      required: true,
    }),
  }
  static override description = 'Unset a mdmd configuration value'
  public static override enableJsonFlag = true
  static override examples = ['<%= config.bin %> <%= command.id %> collection']

  async run(): Promise<ConfigUnsetOutput> {
    const {args} = await this.parse(ConfigUnset)
    if (!isSupportedConfigKey(args.key)) {
      this.error(getSupportedConfigKeysMessage(), {exit: 1})
    }

    const runtime = createMdmdRuntime(this.config.configDir)
    await unsetConfigValue(runtime, args.key)
    this.log(`Unset ${args.key}`)
    return {[args.key]: null} as unknown as ConfigUnsetOutput
  }
}
