import {Args, Command, Flags} from '@oclif/core'
import {lstat, readFile, readlink, stat, unlink, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {createInterface} from 'node:readline'

import {createMdmdRuntime, readMdmdConfig, resolveCollectionRoot, resolveSymlinkDir} from '../lib/config'
import {parseFrontmatter, stringifyFrontmatter} from '../lib/frontmatter'
import {openIndexDb, resolveCollectionId, toCollectionRelativePath, upsertIndexNote} from '../lib/index-db'
import {refreshIndex} from '../lib/refresh-index'

type RemovalPlan = {
  absoluteNotePath: string
  body: string
  cwdSymlinkPath: string
  frontmatter: Record<string, unknown>
  mdmdId: null | string
  otherSymlinkPaths: string[]
  pathInCollection: string
  remainingPaths: string[]
  willDeleteFile: boolean
}

export default class Remove extends Command {
  static override args = {
    symlink: Args.file({
      description: 'Symlink path in the symlink directory',
      exists: true,
      required: true,
    }),
  }
  static override description = 'Remove a note from the current directory (and optionally from the collection)'
  static override examples = [
    '<%= config.bin %> <%= command.id %> mdmd_notes/note.md',
    '<%= config.bin %> <%= command.id %> --all mdmd_notes/shared.md',
    '<%= config.bin %> <%= command.id %> --preserve mdmd_notes/note.md',
    '<%= config.bin %> <%= command.id %> --dry-run mdmd_notes/note.md',
  ]
  static override flags = {
    all: Flags.boolean({
      char: 'a',
      description: 'Remove all path associations (not just cwd), then delete the collection file',
    }),
    collection: Flags.directory({
      char: 'c',
      description: 'Collection root path (highest priority over env/config defaults)',
      exists: true,
    }),
    'dry-run': Flags.boolean({
      description: 'Show what would happen without making any changes',
    }),
    interactive: Flags.boolean({
      char: 'i',
      description: 'Prompt for confirmation before each removal',
    }),
    preserve: Flags.boolean({
      char: 'p',
      description: 'Keep the collection file even when no path associations remain',
    }),
  }
  static override strict = false

  async run(): Promise<void> {
    const {argv, flags} = await this.parse(Remove)
    const runtime = createMdmdRuntime(this.config.configDir)
    const cwd = path.resolve(process.cwd())
    const collectionRoot = await resolveCollectionRoot(flags.collection, runtime)
    const stat = await lstat(collectionRoot).catch(() => null)
    if (!stat?.isDirectory()) {
      this.error(`Collection path does not exist: ${collectionRoot}`)
    }

    const mdmdConfig = await readMdmdConfig(runtime)
    const symlinkDir = resolveSymlinkDir(mdmdConfig)

    await refreshIndex(collectionRoot)

    // Validate ALL inputs before touching anything
    const plans = await Promise.all(
      argv.map(String).map((arg) =>
        this.buildPlan(arg, cwd, collectionRoot, symlinkDir, {
          all: flags.all ?? false,
          preserve: flags.preserve ?? false,
        }),
      ),
    )

    if (flags['dry-run']) {
      this.printDryRun(plans, cwd)
      return
    }

    const prompt = flags.interactive ? createInterface({input: process.stdin, output: process.stdout}) : null
    try {
      for (const plan of plans) {
        // eslint-disable-next-line no-await-in-loop
        await this.executePlan(plan, cwd, collectionRoot, prompt)
      }
    } finally {
      prompt?.close()
    }
  }

  private async buildPlan(
    symlinkArg: string,
    cwd: string,
    collectionRoot: string,
    symlinkDir: string,
    opts: {all: boolean; preserve: boolean},
  ): Promise<RemovalPlan> {
    const {all, preserve} = opts
    const workingNotesDir = path.join(cwd, symlinkDir)
    const cwdSymlinkPath = path.resolve(cwd, symlinkArg)

    const rel = path.relative(workingNotesDir, cwdSymlinkPath)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      this.error(`Symlink must be in ${symlinkDir}/: ${symlinkArg}`)
    }

    const symlinkStat = await lstat(cwdSymlinkPath).catch(() => null)
    if (!symlinkStat?.isSymbolicLink()) {
      this.error(`Symlink does not exist: ${symlinkArg}`)
    }

    const linkTarget = await readlink(cwdSymlinkPath)
    const absoluteNotePath = path.resolve(path.dirname(cwdSymlinkPath), linkTarget)

    const relToCollection = path.relative(collectionRoot, absoluteNotePath)
    if (relToCollection.startsWith('..') || path.isAbsolute(relToCollection)) {
      this.error(`Target is outside collection: ${absoluteNotePath}`)
    }

    const contents = await readFile(absoluteNotePath, 'utf8')
    const {body, frontmatter} = parseFrontmatter(contents)

    if (!frontmatter.mdmd_id) {
      this.error(`Note is not managed (no mdmd_id): ${absoluteNotePath}`)
    }

    const existingPaths = Array.isArray(frontmatter.paths) ? (frontmatter.paths as string[]) : []
    const pathInCollection = toCollectionRelativePath(collectionRoot, absoluteNotePath)
    const basename = path.basename(cwdSymlinkPath)

    if (!all && !existingPaths.includes(cwd)) {
      this.error(`metadata mismatch: note is not associated with ${cwd} (paths: ${existingPaths.join(', ')})`)
    }

    const pathsToRemove = all ? existingPaths : [cwd]
    const remainingPaths = existingPaths.filter((p) => !pathsToRemove.includes(p))
    const willDeleteFile = remainingPaths.length === 0 && !preserve

    // For --all: compute symlink paths in other directories
    const otherDirs = all ? existingPaths.filter((p) => p !== cwd) : []
    const otherSymlinkPaths = otherDirs.map((p) => path.join(p, symlinkDir, basename))

    return {
      absoluteNotePath,
      body,
      cwdSymlinkPath,
      frontmatter,
      mdmdId: typeof frontmatter.mdmd_id === 'string' ? frontmatter.mdmd_id : null,
      otherSymlinkPaths,
      pathInCollection,
      remainingPaths,
      willDeleteFile,
    }
  }

  private async executePlan(
    plan: RemovalPlan,
    cwd: string,
    collectionRoot: string,
    prompt: null | ReturnType<typeof createInterface>,
  ): Promise<void> {
    if (prompt) {
      const target = plan.willDeleteFile ? `delete ${plan.absoluteNotePath}` : `remove ${cwd} from ${plan.pathInCollection}`
      const response = (await question(prompt, `${target}? [y/N]: `)).trim().toLowerCase()
      if (response !== 'y' && response !== 'yes') {
        this.log(`Skipped: ${plan.absoluteNotePath}`)
        return
      }
    }

    // Remove cwd symlink
    await unlink(plan.cwdSymlinkPath).catch(() => {})

    // Remove symlinks in other dirs (best-effort)
    for (const sym of plan.otherSymlinkPaths) {
      // eslint-disable-next-line no-await-in-loop
      await unlink(sym).catch(() => this.warn(`Could not remove symlink: ${sym}`))
    }

    const db = openIndexDb(collectionRoot)
    try {
      const collectionId = resolveCollectionId(db, collectionRoot)

      if (plan.willDeleteFile) {
        await unlink(plan.absoluteNotePath)
        db.query('DELETE FROM index_notes WHERE collection_id = ?1 AND path_in_collection = ?2').run(collectionId, plan.pathInCollection)
        this.log(`Deleted: ${plan.absoluteNotePath}`)
        this.log(`Removed from index: ${plan.pathInCollection}`)
      } else {
        const nextFrontmatter = {...plan.frontmatter, paths: plan.remainingPaths}
        await writeFile(plan.absoluteNotePath, stringifyFrontmatter(nextFrontmatter, plan.body), 'utf8')
        const fileStat = await stat(plan.absoluteNotePath)
        upsertIndexNote(db, collectionId, {
          frontmatter: nextFrontmatter,
          mdmdId: plan.mdmdId,
          mtime: Math.floor(fileStat.mtimeMs / 1000),
          pathInCollection: plan.pathInCollection,
          size: fileStat.size,
        })
        this.log(`Removed from ${path.basename(plan.cwdSymlinkPath)}`)
        this.log(`  Remaining paths: ${plan.remainingPaths.join(', ')}`)
      }
    } finally {
      db.close()
    }
  }

  private printDryRun(plans: RemovalPlan[], cwd: string): void {
    for (const plan of plans) {
      this.log(`Would remove symlink: ${path.relative(cwd, plan.cwdSymlinkPath)}`)
      for (const sym of plan.otherSymlinkPaths) {
        this.log(`Would remove symlink: ${sym}`)
      }

      if (plan.willDeleteFile) {
        this.log(`Would delete: ${plan.absoluteNotePath}`)
        this.log(`Would remove from index: ${plan.pathInCollection}`)
      } else {
        this.log(`Would update paths in: ${plan.absoluteNotePath}`)
        this.log(`  Remaining paths: ${plan.remainingPaths.join(', ')}`)
      }
    }
  }
}

async function question(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer)
    })
  })
}
