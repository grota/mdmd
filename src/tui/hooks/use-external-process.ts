import {useRenderer} from '@opentui/react'
import {useCallback} from 'react'

export function useExternalProcess() {
  const renderer = useRenderer()

  const run = useCallback(
    (cmd: string, args: string[]) => {
      // suspend() removes the stdin listener; resume() re-adds it exactly once.
      // pause() does NOT remove the stdin listener, so pause()+resume() would
      // accumulate listeners and double key events on each cycle.
      renderer.suspend()
      try {
        Bun.spawnSync([cmd, ...args], {
          stderr: 'inherit',
          stdin: 'inherit',
          stdout: 'inherit',
        })
      } finally {
        renderer.resume()
      }
    },
    [renderer],
  )

  return {run}
}
