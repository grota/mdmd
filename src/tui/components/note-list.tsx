import type {ManagedFilter, NoteRow, Scope} from '../types.js'

type NoteListProps = {
  collectionRoot: string
  cursorIndex: number
  cwd: string
  focused: boolean
  managedFilter: ManagedFilter
  notes: NoteRow[]
  onCursorChange: (index: number) => void
  onSelect: (index: number) => void
  scope: Scope
  selected: Set<string>
}

export function NoteList({collectionRoot, cursorIndex, cwd, focused, managedFilter, notes, onCursorChange, onSelect, scope, selected}: NoteListProps) {
  const scopeRoot = scope === 'collection' ? collectionRoot : cwd
  const options = notes.map((note) => {
    const inCwd = Array.isArray(note.frontmatter.paths) && (note.frontmatter.paths as string[]).includes(cwd)
    const isSelected = selected.has(note.absolutePath)
    const unmanagedMark = managedFilter === 'all' && !note.managed ? '? ' : ''
    const prefix = isSelected ? '✓ ' : (unmanagedMark || (inCwd ? '● ' : '  '))
    const displayPath = note.absolutePath.startsWith(scopeRoot + '/')
      ? note.absolutePath.slice(scopeRoot.length + 1)
      : note.absolutePath
    return {
      description: displayPath,
      name: `${prefix}${displayPath.split('/').pop() ?? displayPath}`,
      value: note.absolutePath,
    }
  })

  const bgColor = focused ? '#1e2030' : 'transparent'

  if (options.length === 0) {
    return (
      <box alignItems="center" backgroundColor={bgColor} justifyContent="center" title="Notes" width="40%">
        <text fg="#565f89">No notes found</text>
      </box>
    )
  }

  return (
    <select
      backgroundColor={bgColor}
      focused={focused}
      focusedBackgroundColor={bgColor}
      onChange={(index) => onCursorChange(index)}
      onSelect={(index) => onSelect(index)}
      options={options}
      selectedIndex={cursorIndex}
      showScrollIndicator
      width="40%"
    />
  )
}
