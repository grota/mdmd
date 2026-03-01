import type {Mode} from '../types.js'

type HintBarProps = {
  mode: Mode
  statusMessage: string
}

const HINTS: Record<Mode, string> = {
  batch: 'j/k:move  Space:toggle  *:all  L:link-all  X:remove-all  Esc:clear  ?:help  q:quit',
  filter: 'Type to filter  Enter:back  Tab:next-panel  Esc:clear+back',
  help: 'Esc/?/q:close',
  normal: 'j/k:move  Tab:focus  M:scope  m:managed  Enter:preview  o:edit  l:link  x:remove  y:yank  s:sort  Space:select  ?:help  q:quit',
}

export function HintBar({mode, statusMessage}: HintBarProps) {
  const hint = statusMessage || HINTS[mode]
  return (
    <box flexDirection="row" height={1} paddingX={1}>
      <text fg="#565f89">{hint}</text>
    </box>
  )
}
