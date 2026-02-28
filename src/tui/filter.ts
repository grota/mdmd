import type {NoteRow, SortDir, SortField} from './types.js'

type FilterToken =
  | {field: string; type: 'field'; value: string}
  | {type: 'fuzzy'; value: string}

function parseFilterTokens(filter: string): FilterToken[] {
  return filter
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((token) => {
      const colonIdx = token.indexOf(':')
      if (colonIdx > 0) {
        return {field: token.slice(0, colonIdx).toLowerCase(), type: 'field', value: token.slice(colonIdx + 1).toLowerCase()}
      }

      return {type: 'fuzzy', value: token.toLowerCase()}
    })
}

function noteMatchesToken(note: NoteRow, token: FilterToken): boolean {
  if (token.type === 'field') {
    const fm = note.frontmatter
    if (token.field === 'paths') {
      const paths = Array.isArray(fm.paths) ? (fm.paths as unknown[]) : []
      return paths.some((p) => typeof p === 'string' && p.toLowerCase().includes(token.value))
    }

    const fieldVal = fm[token.field]
    if (typeof fieldVal === 'string') {
      return fieldVal.toLowerCase().includes(token.value)
    }

    if (Array.isArray(fieldVal)) {
      return fieldVal.some((v) => typeof v === 'string' && v.toLowerCase().includes(token.value))
    }

    return false
  }

  // fuzzy: match path or any string value in frontmatter
  if (note.absolutePath.toLowerCase().includes(token.value)) return true
  for (const v of Object.values(note.frontmatter)) {
    if (typeof v === 'string' && v.toLowerCase().includes(token.value)) return true
  }

  return false
}

export function applyFilter(notes: NoteRow[], filter: string): NoteRow[] {
  if (!filter.trim()) return notes
  const tokens = parseFilterTokens(filter)
  return notes.filter((note) => tokens.every((token) => noteMatchesToken(note, token)))
}

export function applySort(notes: NoteRow[], sortField: SortField, sortDir: SortDir): NoteRow[] {
  const sorted = [...notes]
  sorted.sort((a, b) => {
    let cmp = 0
    switch (sortField) {
    case 'created_at': {
      const aDate = typeof a.frontmatter.created_at === 'string' ? a.frontmatter.created_at : ''
      const bDate = typeof b.frontmatter.created_at === 'string' ? b.frontmatter.created_at : ''
      if (!aDate && !bDate) cmp = 0
      else if (!aDate) cmp = 1
      else if (bDate) {cmp = bDate.localeCompare(aDate)}
      else {cmp = -1} // newest first = desc by default
    
    break;
    }

    case 'path': {
      cmp = a.absolutePath.localeCompare(b.absolutePath)
    
    break;
    }

    case 'paths_count': {
      const aCount = Array.isArray(a.frontmatter.paths) ? a.frontmatter.paths.length : 0
      const bCount = Array.isArray(b.frontmatter.paths) ? b.frontmatter.paths.length : 0
      cmp = bCount - aCount // descending by default
    
    break;
    }
    // No default
    }

    return sortDir === 'asc' ? cmp : -cmp
  })

  return sorted
}

export function applyFilterAndSort(notes: NoteRow[], filter: string, sortField: SortField, sortDir: SortDir): NoteRow[] {
  return applySort(applyFilter(notes, filter), sortField, sortDir)
}
