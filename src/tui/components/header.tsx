import type {ManagedFilter, Mode, Scope, SortDir, SortField} from '../types.js'

type HeaderProps = {
  filter: string
  filteredCount: number
  filterFocused: boolean
  managedFilter: ManagedFilter
  mode: Mode
  onFilterChange: (value: string) => void
  scope: Scope
  sortDir: SortDir
  sortField: SortField
  totalCount: number
}

export function Header({filter, filteredCount, filterFocused, managedFilter, mode, onFilterChange, scope, sortDir, sortField, totalCount}: HeaderProps) {
  const sortLabel = `${sortField}:${sortDir}`
  const modeLabel = mode === 'normal' ? '' : ` [${mode.toUpperCase()}]`
  const scopeColor = scope === 'collection' ? '#9ece6a' : '#7aa2f7'
  const managedColor = managedFilter === 'all' ? '#e0af68' : '#7dcfff'

  return (
    <box alignItems="center" border borderStyle="single" flexDirection="row" gap={2} height={3} paddingX={1}>
      <text>
        <span fg="#7aa2f7">
          <strong>mdmd</strong>
        </span>
        {modeLabel}
      </text>
      <text>
        <span fg={scopeColor}>{scope}</span>
        <span fg="#565f89">/</span>
        <span fg={managedColor}>{managedFilter}</span>
      </text>
      <input
        flexGrow={1}
        focused={filterFocused}
        onChange={onFilterChange}
        placeholder="filter… (/ to focus)"
        value={filter}
      />
      <text fg="#565f89">{sortLabel}</text>
      <text>
        {filteredCount}/{totalCount}
      </text>
    </box>
  )
}
