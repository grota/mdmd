import {useKeyboard, useRenderer} from '@opentui/react'
import {randomUUID} from 'node:crypto'
import {mkdir, readFile, stat, unlink, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {useCallback, useEffect, useMemo, useReducer} from 'react'

import type {MdmdConfig} from '../lib/config.js'

import {resolveSymlinkDir} from '../lib/config.js'
import {parseFrontmatter, stringifyFrontmatter} from '../lib/frontmatter.js'
import {ensureGitExcludeEntry} from '../lib/git.js'
import {openIndexDb, resolveCollectionId, upsertIndexNote} from '../lib/index-db.js'
import {ensureSymlinkTarget} from '../lib/symlink.js'
import {Header} from './components/header.js'
import {HelpOverlay} from './components/help-overlay.js'
import {HintBar} from './components/hint-bar.js'
import {NoteList} from './components/note-list.js'
import {NotePreview} from './components/note-preview.js'
import {applyFilterAndSort} from './filter.js'
import {useExternalProcess} from './hooks/use-external-process.js'
import {loadNotes} from './hooks/use-notes.js'
import {initialState, reducer} from './types.js'

export type AppProps = {
  collectionRoot: string
  cwd: string
  mdmdConfig: MdmdConfig
}

function resolvePreviewCmd(mdmdConfig: MdmdConfig): string {
  const env = process.env.MDMD_PREVIEW_CMD
  if (env && env.trim()) return env.trim()

  const configCmd = mdmdConfig['preview-cmd']
  if (typeof configCmd === 'string' && configCmd.trim()) return configCmd.trim()

  for (const cmd of ['glow', 'bat']) {
    if (Bun.which(cmd)) return cmd
  }

  return 'cat'
}

const ISO_8601_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/

function resolveCreatedAt(rawCreatedAt: unknown, fallback: string): string {
  if (typeof rawCreatedAt === 'string') {
    const value = rawCreatedAt.trim()
    if (ISO_8601_TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value))) {
      return value
    }
  }

  return fallback
}

async function linkNoteToDir(collectionRoot: string, cwd: string, pathInCollection: string, mdmdConfig: MdmdConfig): Promise<void> {
  const absoluteNotePath = path.join(collectionRoot, ...pathInCollection.split('/'))
  const noteContents = await readFile(absoluteNotePath, 'utf8')
  const {body, frontmatter: existing} = parseFrontmatter(noteContents)

  const mdmdId =
    typeof existing.mdmd_id === 'string' && existing.mdmd_id.trim() ? existing.mdmd_id : randomUUID()

  const existingPaths = Array.isArray(existing.paths) ? (existing.paths as string[]) : []
  const nextPaths = existingPaths.includes(cwd) ? existingPaths : [...existingPaths, cwd]

  const now = new Date().toISOString()
   
  const nextFrontmatter: Record<string, unknown> = {
    ...existing,
    // eslint-disable-next-line camelcase
    created_at: resolveCreatedAt(existing.created_at, now),
    // eslint-disable-next-line camelcase
    mdmd_id: mdmdId,
    paths: nextPaths,
  }
  delete nextFrontmatter.path

  await writeFile(absoluteNotePath, stringifyFrontmatter(nextFrontmatter, body), 'utf8')

  const fileStat = await stat(absoluteNotePath)
  const db = openIndexDb(collectionRoot)
  try {
    const collectionId = resolveCollectionId(db, collectionRoot)
    upsertIndexNote(db, collectionId, {
      frontmatter: nextFrontmatter,
      mdmdId,
      mtime: Math.floor(fileStat.mtimeMs / 1000),
      pathInCollection,
      size: fileStat.size,
    })
  } finally {
    db.close()
  }

  const symlinkDir = resolveSymlinkDir(mdmdConfig)
  const workingNotesDir = path.join(cwd, symlinkDir)
  await mkdir(workingNotesDir, {recursive: true})
  const symlinkName = path.posix.basename(pathInCollection)
  const symlinkPath = path.join(workingNotesDir, symlinkName)
  await ensureSymlinkTarget(symlinkPath, absoluteNotePath)
  await ensureGitExcludeEntry(cwd, `${symlinkDir}/`)
}

async function removeNoteFromCwd(collectionRoot: string, cwd: string, pathInCollection: string, mdmdConfig: MdmdConfig): Promise<void> {
  const absoluteNotePath = path.join(collectionRoot, ...pathInCollection.split('/'))
  const noteContents = await readFile(absoluteNotePath, 'utf8')
  const {body, frontmatter} = parseFrontmatter(noteContents)

  const existingPaths = Array.isArray(frontmatter.paths) ? (frontmatter.paths as string[]) : []
  const nextPaths = existingPaths.filter((p) => p !== cwd)

  const symlinkDir = resolveSymlinkDir(mdmdConfig)
  const symlinkName = path.posix.basename(pathInCollection)
  const symlinkPath = path.join(cwd, symlinkDir, symlinkName)
  try {
    await unlink(symlinkPath)
  } catch {
    // Symlink may not exist; ignore
  }

  if (nextPaths.length === 0) {
    // No remaining project associations — delete the file and remove from index
    await unlink(absoluteNotePath)
    const db = openIndexDb(collectionRoot)
    try {
      const collectionId = resolveCollectionId(db, collectionRoot)
      db.query('DELETE FROM index_notes WHERE collection_id = ?1 AND path_in_collection = ?2').run(collectionId, pathInCollection)
    } finally {
      db.close()
    }

    return
  }

  const nextFrontmatter = {...frontmatter, paths: nextPaths}
  await writeFile(absoluteNotePath, stringifyFrontmatter(nextFrontmatter, body), 'utf8')

  const fileStat = await stat(absoluteNotePath)
  const db = openIndexDb(collectionRoot)
  try {
    const collectionId = resolveCollectionId(db, collectionRoot)
    const mdmdId = typeof frontmatter.mdmd_id === 'string' ? frontmatter.mdmd_id : null
    upsertIndexNote(db, collectionId, {
      frontmatter: nextFrontmatter,
      mdmdId,
      mtime: Math.floor(fileStat.mtimeMs / 1000),
      pathInCollection,
      size: fileStat.size,
    })
  } finally {
    db.close()
  }
}

export function App({collectionRoot, cwd, mdmdConfig}: AppProps) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const renderer = useRenderer()
  const {run: runExternal} = useExternalProcess()
  const previewCmd = useMemo(() => resolvePreviewCmd(mdmdConfig), [mdmdConfig])

  const filteredNotes = useMemo(
    () => applyFilterAndSort(state.notes, state.filter, state.sortField, state.sortDir),
    [state.notes, state.filter, state.sortField, state.sortDir],
  )

  const clampedCursor = Math.min(state.cursorIndex, Math.max(0, filteredNotes.length - 1))
  const cursorNote = filteredNotes[clampedCursor]

  const reloadNotes = useCallback(async () => {
    const notes = await loadNotes(collectionRoot, cwd, state.scope, state.managedFilter)
    dispatch({notes, type: 'SET_NOTES'})
  }, [collectionRoot, cwd, state.scope, state.managedFilter])

  // Reload notes when scope or managedFilter changes
  useEffect(() => {
    reloadNotes().catch(() => {})
  }, [reloadNotes])

  // Load preview when cursor changes
  useEffect(() => {
    if (!cursorNote) {
      dispatch({content: '', type: 'SET_PREVIEW'})
      return
    }

    readFile(cursorNote.absolutePath, 'utf8')
      .then((content) => dispatch({content, type: 'SET_PREVIEW'}))
      .catch(() => dispatch({content: '(could not read file)', type: 'SET_PREVIEW'}))
  }, [cursorNote?.absolutePath])

  const setStatus = useCallback((message: string) => {
    dispatch({message, type: 'SET_STATUS'})
    setTimeout(() => dispatch({message: '', type: 'SET_STATUS'}), 2000)
  }, [])

  useKeyboard((key) => {
    const {mode} = state

    if (mode === 'help') {
      if (key.name === 'escape' || key.name === 'q' || (key.shift && key.name === '/')) {
        dispatch({mode: 'normal', type: 'SET_MODE'})
      }

      return
    }

    if (mode === 'filter') {
      if (key.name === 'enter' || key.name === 'tab') {
        dispatch({mode: 'normal', type: 'SET_MODE'})
      } else if (key.name === 'escape') {
        dispatch({filter: '', type: 'SET_FILTER'})
        dispatch({mode: 'normal', type: 'SET_MODE'})
      }

      return
    }

    // NORMAL + BATCH mode keys
    const maxIndex = filteredNotes.length - 1

    switch (key.name) {
      case '*': {
        if (mode === 'batch' || mode === 'normal') {
          dispatch({keys: filteredNotes.map((n) => n.absolutePath), type: 'SELECT_ALL'})
        }

        break
      }

      case '/': {
        dispatch({mode: 'filter', type: 'SET_MODE'})
        break
      }

      case '?': {
        dispatch({mode: state.mode === 'help' ? 'normal' : 'help', type: 'SET_MODE'})
        break
      }

      case 'c': {
        if (key.ctrl) renderer.destroy()
        break
      }

      case 'd': {
        if (key.ctrl) dispatch({index: Math.min(clampedCursor + 10, maxIndex), type: 'SET_CURSOR'})
        break
      }

      case 'end': {
        dispatch({index: Math.max(0, maxIndex), type: 'SET_CURSOR'})
        break
      }

      case 'enter': {
        if (cursorNote) {
          runExternal(previewCmd, [cursorNote.absolutePath])
        }

        break
      }

      case 'escape': {
        if (mode === 'batch') {
          dispatch({type: 'CLEAR_SELECTION'})
        }

        break
      }

      case 'g':
      // falls through
      case 'home': {
        dispatch({index: 0, type: 'SET_CURSOR'})
        break
      }

      case 'G': { // shift+g comes as name='G' shift=true
        dispatch({index: Math.max(0, maxIndex), type: 'SET_CURSOR'})
        break
      }

      case 'l': {
        if (key.shift && mode === 'batch') {
          // L = link all selected (managed only)
          const toLink = [...state.selected]
            .map((absPath) => state.notes.find((n) => n.absolutePath === absPath))
            .filter((n): n is typeof n & {managed: true; pathInCollection: string} => Boolean(n?.managed && n?.pathInCollection))
            .map((n) => n.pathInCollection)
          Promise.all(toLink.map((pic) => linkNoteToDir(collectionRoot, cwd, pic, mdmdConfig)))
            .then(() => {
              setStatus(`Linked ${toLink.length} notes`)
              dispatch({type: 'CLEAR_SELECTION'})
              return reloadNotes()
            })
            .catch((error: unknown) => setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`))
        } else if (!key.shift && cursorNote) {
          if (!cursorNote.managed || !cursorNote.pathInCollection) {
            setStatus('Cannot link: note is not managed by mdmd')
            break
          }

          linkNoteToDir(collectionRoot, cwd, cursorNote.pathInCollection, mdmdConfig)
            .then(() => {
              setStatus(`Linked: ${cursorNote.pathInCollection}`)
              return reloadNotes()
            })
            .catch((error: unknown) => setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`))
        }

        break
      }

      case 'm': {
        dispatch({type: 'TOGGLE_MANAGED_FILTER'})
        break
      }

      case 'o': {
        if (cursorNote) {
          const editor = process.env.EDITOR ?? 'vi'
          runExternal(editor, [cursorNote.absolutePath])
          reloadNotes().catch(() => {})
        }

        break
      }

      case 'pagedown': {
        dispatch({index: Math.min(clampedCursor + 10, maxIndex), type: 'SET_CURSOR'})
        break
      }

      case 'pageup': {
        dispatch({index: Math.max(clampedCursor - 10, 0), type: 'SET_CURSOR'})
        break
      }

      case 'q': {
        renderer.destroy()
        break
      }

      case 's': {
        if (key.shift) {
          dispatch({type: 'TOGGLE_SORT_DIR'})
        } else {
          dispatch({type: 'CYCLE_SORT_FIELD'})
        }

        break
      }

      case 'space': {
        if (cursorNote) {
          dispatch({key: cursorNote.absolutePath, type: 'TOGGLE_SELECT'})
        }

        break
      }

      case 'tab': {
        dispatch({type: 'TOGGLE_SCOPE'})
        break
      }

      case 'u': {
        // ctrl+u = page up (vim style)
        if (key.ctrl) {
          dispatch({index: Math.max(clampedCursor - 10, 0), type: 'SET_CURSOR'})
        }

        break
      }

      case 'x': {
        if (key.shift && mode === 'batch') {
          // X = remove all selected managed notes from cwd
          const toRemove = [...state.selected]
            .map((absPath) => state.notes.find((n) => n.absolutePath === absPath))
            .filter((n): n is typeof n & {managed: true; pathInCollection: string} => Boolean(n?.managed && n?.pathInCollection))
            .map((n) => n.pathInCollection)
          if (toRemove.length === 0) {
            setStatus('No managed notes selected for removal')
            break
          }

          Promise.all(toRemove.map((pic) => removeNoteFromCwd(collectionRoot, cwd, pic, mdmdConfig)))
            .then(() => {
              setStatus(`Removed ${toRemove.length} notes`)
              dispatch({type: 'CLEAR_SELECTION'})
              return reloadNotes()
            })
            .catch((error: unknown) => setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`))
        } else if (!key.shift && cursorNote) {
          if (!cursorNote.managed || !cursorNote.pathInCollection) {
            setStatus('Cannot remove: note is not managed by mdmd')
            break
          }

          removeNoteFromCwd(collectionRoot, cwd, cursorNote.pathInCollection, mdmdConfig)
            .then(() => {
              setStatus(`Removed: ${cursorNote.pathInCollection}`)
              return reloadNotes()
            })
            .catch((error: unknown) => setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`))
        }

        break
      }

      case 'y': {
        if (cursorNote) {
          renderer.copyToClipboardOSC52(cursorNote.absolutePath)
          setStatus(`Yanked: ${cursorNote.absolutePath}`)
        }

        break
      }

      default: {
        break
      }
    }
  })

  return (
    <box flexDirection="column" height="100%" width="100%">
      <Header
        filter={state.filter}
        filteredCount={filteredNotes.length}
        filterFocused={state.mode === 'filter'}
        managedFilter={state.managedFilter}
        mode={state.mode}
        onFilterChange={(value) => dispatch({filter: value, type: 'SET_FILTER'})}
        scope={state.scope}
        sortDir={state.sortDir}
        sortField={state.sortField}
        totalCount={state.notes.length}
      />
      <box flexDirection="row" flexGrow={1}>
        <NoteList
          collectionRoot={collectionRoot}
          cursorIndex={clampedCursor}
          cwd={cwd}
          focused={state.mode !== 'filter' && state.mode !== 'help'}
          managedFilter={state.managedFilter}
          notes={filteredNotes}
          onCursorChange={(index) => dispatch({index, type: 'SET_CURSOR'})}
          onSelect={() => {
            if (cursorNote) {
              runExternal(previewCmd, [cursorNote.absolutePath])
            }
          }}
          scope={state.scope}
          selected={state.selected}
        />
        <NotePreview content={state.previewContent} />
      </box>
      <HintBar mode={state.mode} statusMessage={state.statusMessage} />
      {state.mode === 'help' && <HelpOverlay />}
    </box>
  )
}
