import {Command} from '@oclif/core'

type ConfigRootOutput = {
  subcommands: string[]
}

export default class Config extends Command {
  static override description = 'Manage mdmd configuration'
  public static override enableJsonFlag = true
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> list --resolved',
  ]

  async run(): Promise<ConfigRootOutput> {
    await this.parse(Config)
    const subcommands = this.config.commands
      .map((command) => command.id)
      .filter((id) => id.startsWith('config:'))
      .map((id) => id.slice('config:'.length))
      .sort((left, right) => left.localeCompare(right))

    this.log('Available config subcommands:')
    for (const subcommand of subcommands) {
      this.log(`- ${this.config.bin} config ${subcommand}`)
    }

    return {subcommands}
  }
}
