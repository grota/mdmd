export type Mode = 'batch' | 'filter' | 'help' | 'normal'
export type SortField = 'created_at' | 'path' | 'paths_count'
export type SortDir = 'asc' | 'desc'
export type Scope = 'collection' | 'cwd'
export type ManagedFilter = 'all' | 'managed'

export type NoteRow = {
  absolutePath: string
  frontmatter: Record<string, unknown>
  frontmatterJson: null | string
  managed: boolean
  mdmdId: null | string
  pathInCollection: null | string
}

export type State = {
  cursorIndex: number
  filter: string
  managedFilter: ManagedFilter
  mode: Mode
  notes: NoteRow[]
  previewContent: string
  scope: Scope
  selected: Set<string>
  sortDir: SortDir
  sortField: SortField
  statusMessage: string
}

export type Action =
  | {content: string; type: 'SET_PREVIEW';}
  | {filter: string; type: 'SET_FILTER';}
  | {index: number; type: 'SET_CURSOR';}
  | {key: string; type: 'TOGGLE_SELECT';}
  | {keys: string[]; type: 'SELECT_ALL';}
  | {message: string; type: 'SET_STATUS';}
  | {mode: Mode; type: 'SET_MODE';}
  | {notes: NoteRow[]; type: 'SET_NOTES';}
  | {type: 'CLEAR_SELECTION'}
  | {type: 'CYCLE_SORT_FIELD'}
  | {type: 'TOGGLE_MANAGED_FILTER'}
  | {type: 'TOGGLE_SCOPE'}
  | {type: 'TOGGLE_SORT_DIR'}

export const initialState: State = {
  cursorIndex: 0,
  filter: '',
  managedFilter: 'managed',
  mode: 'normal',
  notes: [],
  previewContent: '',
  scope: 'cwd',
  selected: new Set<string>(),
  sortDir: 'asc',
  sortField: 'path',
  statusMessage: '',
}

const SORT_FIELDS: SortField[] = ['path', 'created_at', 'paths_count']

function nextSortField(current: SortField): SortField {
  const idx = SORT_FIELDS.indexOf(current)
  return SORT_FIELDS[(idx + 1) % SORT_FIELDS.length] ?? 'path'
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'CLEAR_SELECTION': {
      return {...state, mode: 'normal', selected: new Set<string>()}
    }

    case 'CYCLE_SORT_FIELD': {
      return {...state, cursorIndex: 0, sortField: nextSortField(state.sortField)}
    }

    case 'SELECT_ALL': {
      const allSelected = action.keys.every((k) => state.selected.has(k))
      const next = allSelected ? new Set<string>() : new Set(action.keys)
      return {...state, selected: next}
    }

    case 'SET_CURSOR': {
      return {...state, cursorIndex: action.index}
    }

    case 'SET_FILTER': {
      return {...state, cursorIndex: 0, filter: action.filter}
    }

    case 'SET_MODE': {
      return {...state, mode: action.mode}
    }

    case 'SET_NOTES': {
      return {...state, cursorIndex: 0, notes: action.notes}
    }

    case 'SET_PREVIEW': {
      return {...state, previewContent: action.content}
    }

    case 'SET_STATUS': {
      return {...state, statusMessage: action.message}
    }

    case 'TOGGLE_MANAGED_FILTER': {
      return {...state, cursorIndex: 0, managedFilter: state.managedFilter === 'managed' ? 'all' : 'managed', selected: new Set<string>()}
    }

    case 'TOGGLE_SCOPE': {
      return {...state, cursorIndex: 0, scope: state.scope === 'cwd' ? 'collection' : 'cwd', selected: new Set<string>()}
    }

    case 'TOGGLE_SELECT': {
      const next = new Set(state.selected)
      if (next.has(action.key)) {
        next.delete(action.key)
      } else {
        next.add(action.key)
      }

      return {...state, mode: next.size > 0 ? 'batch' : 'normal', selected: next}
    }

    case 'TOGGLE_SORT_DIR': {
      return {...state, cursorIndex: 0, sortDir: state.sortDir === 'asc' ? 'desc' : 'asc'}
    }

    default: {
      return state
    }
  }
}
