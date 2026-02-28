import {Command, Flags} from '@oclif/core'
import {createCliRenderer} from '@opentui/core'
import {createRoot} from '@opentui/react'
import path from 'node:path'
import React from 'react'

import {createMdmdRuntime, readMdmdConfig, resolveCollectionRoot} from '../lib/config.js'
import {refreshIndex} from '../lib/refresh-index.js'

export default class Tui extends Command {
  static override description = 'Interactive TUI dashboard for browsing and managing notes'
  static override examples = ['<%= config.bin %> <%= command.id %>']
  static override flags = {
    collection: Flags.directory({
      char: 'c',
      description: 'Collection root path',
      exists: true,
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Tui)
    const runtime = createMdmdRuntime(this.config.configDir)
    const cwd = path.resolve(process.cwd())
    const collectionRoot = await resolveCollectionRoot(flags.collection, runtime)
    const mdmdConfig = await readMdmdConfig(runtime)

    await refreshIndex(collectionRoot)

    const {App} = await import('../tui/app.js')

    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
    })

    const root = createRoot(renderer)
    root.render(React.createElement(App, {collectionRoot, cwd, mdmdConfig}))
  }
}
