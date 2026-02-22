import {spawnSync} from 'node:child_process'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'

export async function ensureGitExcludeEntry(cwd: string, entry: string): Promise<void> {
  const gitDir = resolveGitDir(cwd)
  if (!gitDir) {
    return
  }

  const excludePath = path.join(gitDir, 'info', 'exclude')
  await mkdir(path.dirname(excludePath), {recursive: true})

  let existingContent = ''
  try {
    existingContent = await readFile(excludePath, 'utf8')
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException
    if (maybeError.code !== 'ENOENT') {
      throw error
    }
  }

  const lines = existingContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  if (lines.includes(entry)) {
    return
  }

  const separator = existingContent.length === 0 || existingContent.endsWith('\n') ? '' : '\n'
  await writeFile(excludePath, `${existingContent}${separator}${entry}\n`, 'utf8')
}

export function resolveGitHeadSha(cwd: string): null | string {
  return runGitCommand(cwd, ['rev-parse', 'HEAD'])
}

export async function hasGitExcludeEntry(cwd: string, entry: string): Promise<boolean | null> {
  const gitDir = resolveGitDir(cwd)
  if (!gitDir) {
    return null
  }

  const excludePath = path.join(gitDir, 'info', 'exclude')
  let existingContent = ''

  try {
    existingContent = await readFile(excludePath, 'utf8')
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException
    if (maybeError.code === 'ENOENT') {
      return false
    }

    throw error
  }

  return existingContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .includes(entry)
}

export function resolveGitDir(cwd: string): null | string {
  const gitDirOutput = runGitCommand(cwd, ['rev-parse', '--git-dir'])
  if (!gitDirOutput) {
    return null
  }

  if (path.isAbsolute(gitDirOutput)) {
    return gitDirOutput
  }

  return path.resolve(cwd, gitDirOutput)
}

function runGitCommand(cwd: string, args: string[]): null | string {
  const result = spawnSync('git', args, {cwd, encoding: 'utf8'})
  if (result.status !== 0) {
    return null
  }

  return result.stdout.trim()
}
