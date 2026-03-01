const KEYBINDINGS = [
  {action: 'Cursor down', keys: 'j / ↓'},
  {action: 'Cursor up', keys: 'k / ↑'},
  {action: 'Cursor to top', keys: 'g / Home'},
  {action: 'Cursor to bottom', keys: 'G / End'},
  {action: 'Page down (10)', keys: 'Ctrl+d / PgDn'},
  {action: 'Page up (10)', keys: 'Ctrl+u / PgUp'},
  {action: 'Cycle focus (list→preview→filter)', keys: 'Tab'},
  {action: 'Toggle scope (collection ↔ cwd)', keys: 'M'},
  {action: 'Toggle managed filter (managed ↔ all)', keys: 'm'},
  {action: 'Open with preview command', keys: 'Enter'},
  {action: 'Open in $EDITOR', keys: 'o'},
  {action: 'Link note to cwd (managed only)', keys: 'l'},
  {action: 'Remove note from cwd (managed only)', keys: 'x'},
  {action: 'Yank path to clipboard (OSC 52)', keys: 'y'},
  {action: 'Enter filter mode', keys: '/'},
  {action: 'Return to list (keep filter)', keys: 'Enter (filter mode)'},
  {action: 'Advance focus panel (keep filter)', keys: 'Tab (filter mode)'},
  {action: 'Clear filter and return', keys: 'Esc (filter mode)'},
  {action: 'Cycle sort field', keys: 's'},
  {action: 'Toggle sort direction', keys: 'S'},
  {action: 'Toggle selection (batch mode)', keys: 'Space'},
  {action: 'Select all / deselect all (batch)', keys: '*'},
  {action: 'Link all selected (batch)', keys: 'L'},
  {action: 'Remove all selected from cwd (batch)', keys: 'X'},
  {action: 'Toggle this help overlay', keys: '?'},
  {action: 'Quit', keys: 'q / Ctrl+C'},
]

export function HelpOverlay() {
  return (
    <box
      backgroundColor="#1a1b26"
      border
      borderColor="#7aa2f7"
      borderStyle="rounded"
      flexDirection="column"
      gap={0}
      height="80%"
      left="15%"
      padding={1}
      position="absolute"
      title=" Keyboard Shortcuts "
      titleAlignment="center"
      top="10%"
      width="70%"
      zIndex={100}
    >
      {KEYBINDINGS.map(({action, keys}) => (
        <box flexDirection="row" gap={2} key={keys}>
          <text fg="#7aa2f7" width={18}>{keys}</text>
          <text fg="#c0caf5">{action}</text>
        </box>
      ))}
      <box marginTop={1}>
        <text fg="#565f89">Press ? / Esc / q to close</text>
      </box>
    </box>
  )
}
