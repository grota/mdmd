import {Command, Flags} from '@oclif/core'
import {lstat, mkdir, readdir, readlink, unlink} from 'node:fs/promises'
import path from 'node:path'

import {createMdmdRuntime, readMdmdConfig, resolveCollectionRoot, resolveSymlinkDir} from '../lib/config'
import {ensureGitExcludeEntry, hasGitExcludeEntry} from '../lib/git'
import {openIndexDb, resolveCollectionId} from '../lib/index-db'
import {refreshIndex, scanCollectionMarkdownFiles} from '../lib/refresh-index'
import {ensureSymlinkTarget} from '../lib/symlink'
import {buildDesiredSymlinks, listManagedPathsForCwd} from '../lib/sync-state'

type DoctorScope = 'config' | 'index' | 'symlinks'

type DoctorIssue = {
  code: string
  message: string
  path?: string
  scope: DoctorScope
  severity: 'error' | 'warning'
}

type DoctorReport = {
  fixesApplied: string[]
  healthy: boolean
  issues: DoctorIssue[]
}

type IndexedRow = {
  frontmatterJson: null | string
  mdmdId: null | string
  pathInCollection: string
}

export default class Doctor extends Command {
  static override description = 'Run mdmd health checks for index, symlinks, and config'
  public static override enableJsonFlag = true
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --scope symlinks',
    '<%= config.bin %> <%= command.id %> --fix --json',
  ]
  static override flags = {
    collection: Flags.directory({
      char: 'c',
      description: 'Collection root path (highest priority over env/config defaults)',
      exists: true,
    }),
    fix: Flags.boolean({
      description: 'Apply safe deterministic fixes',
    }),
    scope: Flags.string({
      default: 'all',
      description: 'Scope to check: all, index, symlinks, config',
      options: ['all', 'config', 'index', 'symlinks'],
    }),
  }

  async run(): Promise<DoctorReport> {
    const {flags} = await this.parse(Doctor)
    const runtime = createMdmdRuntime(this.config.configDir)
    const cwd = path.resolve(process.cwd())

    try {
      const collectionRoot = await resolveCollectionRoot(flags.collection, runtime)
      const mdmdConfig = await readMdmdConfig(runtime)
      const symlinkDir = resolveSymlinkDir(mdmdConfig)
      const scopes = resolveScopes(flags.scope)

      let issues = await collectDoctorIssues(cwd, collectionRoot, scopes, symlinkDir)
      let fixesApplied: string[] = []

      if (flags.fix) {
        fixesApplied = await applyDoctorFixes(cwd, collectionRoot, scopes, issues, symlinkDir)
        issues = await collectDoctorIssues(cwd, collectionRoot, scopes, symlinkDir)
      }

      const report: DoctorReport = {
        fixesApplied,
        healthy: issues.length === 0,
        issues,
      }

      printHumanReport(this, report)

      if (issues.length > 0) {
        process.exitCode = 1
      }

      return report
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.error(`doctor failed: ${message}`, {exit: 2})
    }
  }
}

function resolveScopes(scopeFlag: string): Set<DoctorScope> {
  if (scopeFlag === 'all') {
    return new Set<DoctorScope>(['config', 'index', 'symlinks'])
  }

  return new Set<DoctorScope>([scopeFlag as DoctorScope])
}

async function collectDoctorIssues(cwd: string, collectionRoot: string, scopes: Set<DoctorScope>, symlinkDir: string): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = []
  const collectionExists = await directoryExists(collectionRoot)

  if (scopes.has('config')) {
    if (!collectionExists) {
      issues.push({
        code: 'config.collection_missing',
        message: 'Collection path does not exist or is inaccessible',
        path: collectionRoot,
        scope: 'config',
        severity: 'error',
      })
    }

    const gitExcludePresent = await hasGitExcludeEntry(cwd, `${symlinkDir}/`)
    if (gitExcludePresent === false) {
      issues.push({
        code: 'config.git_exclude_missing',
        message: `Missing ${symlinkDir}/ entry in .git/info/exclude`,
        path: path.join(cwd, '.git', 'info', 'exclude'),
        scope: 'config',
        severity: 'warning',
      })
    }
  }

  if (!collectionExists) {
    return issues
  }

  const [indexIssues, symlinkIssues] = await Promise.all([
    scopes.has('index') ? collectIndexIssues(collectionRoot) : Promise.resolve([]),
    scopes.has('symlinks') ? collectSymlinkIssues(cwd, collectionRoot, symlinkDir) : Promise.resolve([]),
  ])

  return [...issues, ...indexIssues, ...symlinkIssues]
}

async function collectIndexIssues(collectionRoot: string): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = []
  const snapshots = await scanCollectionMarkdownFiles(collectionRoot)
  const filePathSet = new Set(snapshots.map((snapshot) => snapshot.pathInCollection))

  const db = openIndexDb(collectionRoot)
  try {
    const collectionId = resolveCollectionId(db, collectionRoot)
    const rows = db.query(`
        SELECT path_in_collection AS pathInCollection,
               mdmd_id AS mdmdId,
               frontmatter AS frontmatterJson
        FROM index_notes
        WHERE collection_id = ?1
        ORDER BY path_in_collection ASC
      `).all(collectionId) as IndexedRow[]

    const rowPathSet = new Set(rows.map((row) => row.pathInCollection))

    for (const snapshot of snapshots) {
      if (!rowPathSet.has(snapshot.pathInCollection)) {
        issues.push({
          code: 'index.missing_row',
          message: 'Collection file is missing from index',
          path: snapshot.pathInCollection,
          scope: 'index',
          severity: 'error',
        })
      }
    }

    for (const row of rows) {
      if (!filePathSet.has(row.pathInCollection)) {
        issues.push({
          code: 'index.stale_row',
          message: 'Index row points to a file not found in collection',
          path: row.pathInCollection,
          scope: 'index',
          severity: 'error',
        })
      }
    }

    const duplicateIds = collectDuplicateMdmdIds(rows)
    issues.push(...duplicateIds)

    const metadataIssues = collectManagedMetadataIssues(rows)
    issues.push(...metadataIssues)
  } finally {
    db.close()
  }

  return issues
}

function collectDuplicateMdmdIds(rows: IndexedRow[]): DoctorIssue[] {
  const idMap = new Map<string, string[]>()

  for (const row of rows) {
    if (!row.mdmdId) {
      continue
    }

    const existingPaths = idMap.get(row.mdmdId) ?? []
    idMap.set(row.mdmdId, [...existingPaths, row.pathInCollection])
  }

  const issues: DoctorIssue[] = []
  for (const [mdmdId, paths] of idMap.entries()) {
    if (paths.length > 1) {
      issues.push({
        code: 'index.duplicate_mdmd_id',
        message: `Duplicate mdmd_id ${mdmdId} found in index`,
        path: paths.join(', '),
        scope: 'index',
        severity: 'error',
      })
    }
  }

  return issues
}

function collectManagedMetadataIssues(rows: IndexedRow[]): DoctorIssue[] {
  const issues: DoctorIssue[] = []

  for (const row of rows) {
    if (!row.mdmdId) {
      continue
    }

    const frontmatter = parseIndexedFrontmatter(row.frontmatterJson)
    if (!frontmatter) {
      issues.push({
        code: 'index.invalid_frontmatter_json',
        message: 'Managed note has invalid frontmatter JSON in index',
        path: row.pathInCollection,
        scope: 'index',
        severity: 'error',
      })

      continue
    }

     
    const frontmatterMdmdId = frontmatter.mdmd_id
    if (typeof frontmatterMdmdId !== 'string' || frontmatterMdmdId !== row.mdmdId) {
      issues.push({
        code: 'index.invalid_mdmd_id',
        message: 'Managed note has missing or mismatched frontmatter mdmd_id',
        path: row.pathInCollection,
        scope: 'index',
        severity: 'error',
      })
    }

    const notePaths = frontmatter.paths
    if (!Array.isArray(notePaths) || notePaths.length === 0) {
      issues.push({
        code: 'index.invalid_paths',
        message: 'Managed note has missing or empty frontmatter paths array',
        path: row.pathInCollection,
        scope: 'index',
        severity: 'error',
      })
    }

     
    if (typeof frontmatter.created_at !== 'string' || frontmatter.created_at.trim().length === 0) {
      issues.push({
        code: 'index.invalid_created_at',
         
        message: 'Managed note has missing or invalid frontmatter created_at',
        path: row.pathInCollection,
        scope: 'index',
        severity: 'warning',
      })
    }
  }

  return issues
}

async function collectSymlinkIssues(cwd: string, collectionRoot: string, symlinkDir: string): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = []
  const managedPaths = listManagedPathsForCwd(cwd, collectionRoot)
  const desiredSymlinks = buildDesiredSymlinks(collectionRoot, managedPaths)
  const desiredByName = new Map(desiredSymlinks.map((entry) => [entry.symlinkName, entry.targetPath]))
  const workingNotesDir = path.join(cwd, symlinkDir)

  if (!(await directoryExists(workingNotesDir))) {
    if (desiredSymlinks.length > 0) {
      issues.push({
        code: 'symlinks.directory_missing',
        message: `Expected ${symlinkDir}/ directory is missing`,
        path: workingNotesDir,
        scope: 'symlinks',
        severity: 'error',
      })
    }

    return issues
  }

  const entries = await readdir(workingNotesDir)
  const existingNames = new Set(entries)
  const entryIssues = await Promise.all(
    entries.map(async (entryName) => inspectWorkingEntry(workingNotesDir, entryName, desiredByName, symlinkDir)),
  )

  issues.push(...entryIssues.flat())

  for (const desired of desiredSymlinks) {
    if (!existingNames.has(desired.symlinkName)) {
      issues.push({
        code: 'symlinks.missing',
        message: 'Expected symlink is missing',
        path: path.join(workingNotesDir, desired.symlinkName),
        scope: 'symlinks',
        severity: 'error',
      })
    }
  }

  return issues
}

async function inspectWorkingEntry(
  workingNotesDir: string,
  entryName: string,
  desiredByName: Map<string, string>,
  symlinkDir: string,
): Promise<DoctorIssue[]> {
  const entryPath = path.join(workingNotesDir, entryName)
  const entryStat = await lstat(entryPath)

  if (!entryStat.isSymbolicLink()) {
    return [
      {
        code: 'symlinks.non_symlink_entry',
        message: `Found non-symlink entry inside ${symlinkDir}/`,
        path: entryPath,
        scope: 'symlinks',
        severity: 'warning',
      },
    ]
  }

  const linkTarget = await readlink(entryPath)
  const targetPath = path.resolve(path.dirname(entryPath), linkTarget)
  const desiredTarget = desiredByName.get(entryName)
  const issues: DoctorIssue[] = []

  if (!desiredTarget) {
    issues.push({
      code: 'symlinks.orphan',
      message: 'Symlink is not part of the desired managed-note set',
      path: entryPath,
      scope: 'symlinks',
      severity: 'warning',
    })
  } else if (desiredTarget !== targetPath) {
    issues.push({
      code: 'symlinks.stale_target',
      message: 'Symlink points to stale or incorrect target',
      path: entryPath,
      scope: 'symlinks',
      severity: 'error',
    })
  }

  if (!(await pathExists(targetPath))) {
    issues.push({
      code: 'symlinks.broken',
      message: 'Symlink target does not exist',
      path: entryPath,
      scope: 'symlinks',
      severity: 'error',
    })
  }

  return issues
}

async function applyDoctorFixes(
  cwd: string,
  collectionRoot: string,
  scopes: Set<DoctorScope>,
  issues: DoctorIssue[],
  symlinkDir: string,
): Promise<string[]> {
  const fixesApplied: string[] = []

  if (scopes.has('index') && issues.some((issue) => issue.scope === 'index')) {
    const result = await refreshIndex(collectionRoot)
    fixesApplied.push(
      `refresh_index: refreshed=${result.refreshed}, deleted=${result.deleted}, unchanged=${result.unchanged}`,
    )
  }

  if (scopes.has('symlinks')) {
    const symlinkFixResult = await applySymlinkFixes(cwd, collectionRoot, symlinkDir)
    fixesApplied.push(
      `reconcile_symlinks: removed=${symlinkFixResult.removed}, ensured=${symlinkFixResult.ensured}`,
    )
  }

  if (scopes.has('config') || scopes.has('symlinks')) {
    const gitExcludeEntry = `${symlinkDir}/`
    const excludePresentBefore = await hasGitExcludeEntry(cwd, gitExcludeEntry)
    if (excludePresentBefore === false) {
      await ensureGitExcludeEntry(cwd, gitExcludeEntry)
      fixesApplied.push(`ensure_git_exclude: added ${gitExcludeEntry}`)
    }
  }

  return fixesApplied
}

async function applySymlinkFixes(cwd: string, collectionRoot: string, symlinkDir: string): Promise<{ensured: number; removed: number}> {
  const managedPaths = listManagedPathsForCwd(cwd, collectionRoot)
  const desiredSymlinks = buildDesiredSymlinks(collectionRoot, managedPaths)
  const desiredByName = new Map(desiredSymlinks.map((entry) => [entry.symlinkName, entry.targetPath]))
  const workingNotesDir = path.join(cwd, symlinkDir)

  await mkdir(workingNotesDir, {recursive: true})

  const existingEntries = await readdir(workingNotesDir)
  const existingEntryStates = await Promise.all(
    existingEntries.map(async (entryName) => {
      const entryPath = path.join(workingNotesDir, entryName)
      const entryStat = await lstat(entryPath)
      return {
        entryName,
        entryPath,
        isSymlink: entryStat.isSymbolicLink(),
      }
    }),
  )

  const staleSymlinks = existingEntryStates.filter((entry) => entry.isSymlink && !desiredByName.has(entry.entryName))
  await Promise.all(staleSymlinks.map(async (entry) => unlink(entry.entryPath)))

  const ensureResults = await Promise.allSettled(
    desiredSymlinks.map(async (entry) =>
      ensureSymlinkTarget(path.join(workingNotesDir, entry.symlinkName), entry.targetPath),
    ),
  )

  const ensured = ensureResults.filter((result) => result.status === 'fulfilled').length
  return {
    ensured,
    removed: staleSymlinks.length,
  }
}

function parseIndexedFrontmatter(frontmatterJson: null | string): null | Record<string, unknown> {
  if (!frontmatterJson) {
    return null
  }

  try {
    const parsed = JSON.parse(frontmatterJson) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return null
  }

  return null
}

async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    const targetStat = await lstat(targetPath)
    return targetStat.isDirectory()
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException
    if (maybeError.code === 'ENOENT') {
      return false
    }

    throw error
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath)
    return true
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException
    if (maybeError.code === 'ENOENT') {
      return false
    }

    throw error
  }
}

function printHumanReport(command: Command, report: DoctorReport): void {
  if (report.fixesApplied.length > 0) {
    command.log(`Applied fixes (${report.fixesApplied.length}):`)
    for (const fix of report.fixesApplied) {
      command.log(`- ${fix}`)
    }
  }

  if (report.issues.length === 0) {
    command.log('Doctor found no issues.')
    return
  }

  command.log(`Doctor found ${report.issues.length} issue(s):`)
  for (const issue of report.issues) {
    const location = issue.path ? ` (${issue.path})` : ''
    command.log(`- [${issue.severity}] ${issue.code}${location}: ${issue.message}`)
  }
}
