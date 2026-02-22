import {lstat, readlink, symlink, unlink} from 'node:fs/promises'
import path from 'node:path'

export async function ensureSymlinkTarget(symlinkPath: string, targetPath: string): Promise<void> {
  try {
    const symlinkStat = await lstat(symlinkPath)
    if (!symlinkStat.isSymbolicLink()) {
      throw new Error(`Cannot create symlink because a non-symlink exists at ${symlinkPath}`)
    }

    const existingTarget = await readlink(symlinkPath)
    const resolvedTarget = path.resolve(path.dirname(symlinkPath), existingTarget)
    if (resolvedTarget === targetPath) {
      return
    }

    await unlink(symlinkPath)
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException
    if (maybeError.code !== 'ENOENT') {
      throw error
    }
  }

  await symlink(targetPath, symlinkPath)
}
