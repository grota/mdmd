import {Command, Flags} from '@oclif/core'

import {createMdmdRuntime} from '../../lib/config'
import {type ConfigOutput, listConfigValues} from '../../lib/config-command'

export default class ConfigList extends Command {
  static override description = 'List mdmd configuration values'
  public static override enableJsonFlag = true
  static override examples = ['<%= config.bin %> <%= command.id %> --resolved']
  static override flags = {
    resolved: Flags.boolean({
      description: 'Resolve effective values including env/Obsidian fallback',
    }),
  }

  async run(): Promise<ConfigOutput> {
    const {flags} = await this.parse(ConfigList)
    const runtime = createMdmdRuntime(this.config.configDir)
    const output = await listConfigValues(runtime, Boolean(flags.resolved))

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
}
