# mdmd - Metadata Markdown Manager

## Overview

`mdmd` is a CLI utility that manages markdown files based on their YAML frontmatter
metadata. It indexes a collection of markdown files and projects them into working
directories via symlinks based on metadata properties.

While primarily designed for Obsidian vaults, `mdmd` works with any directory
containing markdown files with YAML frontmatter.

## Core Concepts

### Collection

The collection is the canonical storage location for all markdown files.
This is typically an Obsidian vault, but can be any directory containing
markdown files with YAML frontmatter.

Currently hardcoded to: `/home/grota/Documents/Main Obsidian Vault`
(to be made configurable later).

### Frontmatter Properties

Notes managed by `mdmd` have the following frontmatter properties:

| Property         | Type       | Required | Description                                      |
|------------------|------------|----------|--------------------------------------------------|
| `mdmd_id`        | UUID v4    | Yes      | Unique identifier for the note                   |
| `path`           | `string`   | Yes      | Directory path this note is related to           |
| `last_updated_at`| ISO 8601   | Yes      | Timestamp of last modification by `mdmd`         |
| `created_at`     | ISO 8601   | Yes      | Timestamp of creation by `mdmd`                  |
| `git_sha`        | string     | No       | HEAD commit SHA, set if cwd is a git repo at ingest time |

This schema may be expanded in the future.

### Note Identity

Notes are uniquely identified by `mdmd_id` (UUID v4), stored in frontmatter.
This allows notes to be renamed or moved within the collection without losing identity.

Rules:
- `ingest` always generates a `mdmd_id` if one is not present.
- `refresh_index` indexes all markdown files in the collection, regardless of whether
  they have a `mdmd_id`. Notes without a `mdmd_id` are indexed by their
  collection-relative path. This allows collection-wide search and filtering.
- A note with a `mdmd_id` is considered "managed" by mdmd. Only managed notes
  participate in `sync` (since `sync` matches on the `path` property, which is
  only guaranteed to exist on managed notes).

### Symlink Directory

Notes are symlinked into `mdmd_notes/` relative to the working directory.
This directory name is configurable (default: `mdmd_notes/`).

Symlinks are named after the collection file's basename. In case of collisions
(two notes with the same filename both matching the same path), disambiguate
by appending the parent folder name, e.g. `note__subfolder.md`.
If that still generates a collision error out.

## Commands

### `mdmd ingest <file>`

Takes an existing markdown file, prepares it for the collection, and symlinks it back.

Steps:
1. Parse existing frontmatter (if any) and preserve it.
2. Set/overwrite `mdmd` managed properties:
   - `mdmd_id`: generate UUID v4 (unless already present).
   - `path`: set to `<cwd>` (absolute path to current directory).
   - `last_updated_at`: set to current timestamp.
   - `created_at`: set to current timestamp (if not already present).
   - `git_sha`: set to HEAD SHA if cwd is a git repo, omit otherwise.
3. Move the file into the collection under `mdmd_notes/` subdirectory.
   - If a file with the same name already exists in `mdmd_notes/`, append a short
     suffix (e.g., `note_2.md`) to avoid collisions.
4. Upsert the note into the SQLite index (so it's immediately available to
   `sync` without requiring a full `refresh_index`).
5. Create `mdmd_notes/` directory in the cwd if it does not exist.
6. Create a symlink from `mdmd_notes/<filename>` to the collection file.
7. If cwd is a git repo, ensure `mdmd_notes/` is in `.git/info/exclude`.

**Error cases:**
- File does not exist: error.
- File is already in the collection (detected by path prefix): error, suggest using
  `sync` instead.
- File already has a `mdmd_id` that exists in the index: error, the note is
  already managed. Suggest `sync`.

### Internal: `refresh_index`

**Note:** This is an internal operation automatically called by other commands.
It is not exposed as a standalone CLI command.

Scans the entire collection and builds/updates an index of note metadata.

**Index storage:** SQLite database at `~/.cache/mdmd/index.db`.

**Schema:**

```sql
CREATE TABLE index_notes (
    path_in_collection TEXT NOT NULL PRIMARY KEY,  -- relative path within the collection
    mdmd_id            TEXT,                       -- UUID if managed, NULL otherwise
    mtime              INTEGER NOT NULL,           -- file mtime (epoch seconds)
    size               INTEGER NOT NULL,           -- file size in bytes
    frontmatter        TEXT                        -- full frontmatter stored as JSON
);

CREATE UNIQUE INDEX idx_notes_mdmd_id ON index_notes(mdmd_id) WHERE mdmd_id IS NOT NULL;
```

**Querying frontmatter:**

Frontmatter is stored as a JSON string in the `frontmatter` column. SQLite's
built-in JSON functions are used for all queries:

- **Scalar properties** (text, number, checkbox, date, date & time): use
  `json_extract()` directly, e.g.:
  ```sql
  SELECT * FROM index_notes WHERE json_extract(frontmatter, '$.status') = 'draft';
  ```

- **String matching for path** (since `path` is now a scalar string):
  ```sql
  -- Find all notes associated with a directory (used by sync)
  SELECT * FROM index_notes
  WHERE json_extract(frontmatter, '$.path') = '/home/grota/Projects/personal/obn';
  ```

- **List/array properties** (list, tags): use `json_each()` to search within arrays:
  ```sql
  -- Find all notes with a specific tag
  SELECT * FROM index_notes
  WHERE EXISTS (
    SELECT 1 FROM json_each(json_extract(frontmatter, '$.tags'))
    WHERE value = 'architecture'
  );
  ```

- **Ad-hoc filtering on any frontmatter key** works without schema changes.

**Performance notes on JSON queries:**

`json_each()` and `json_extract()` cannot use B-tree indexes directly, so these
queries scan all rows. For a collection with up to a few thousand notes this is fast
(sub-millisecond). If a specific query becomes a bottleneck at scale, SQLite
supports adding indexed generated columns after the fact without data migration:

```sql
-- Example: index a scalar property that is queried frequently
ALTER TABLE index_notes ADD COLUMN status TEXT
    GENERATED ALWAYS AS (json_extract(frontmatter, '$.status')) VIRTUAL;
CREATE INDEX idx_notes_status ON index_notes(status);
```

For array properties, a denormalized join table can be introduced later if needed.
This is explicitly deferred until profiling shows it's necessary.

**Common frontmatter property types and their JSON representation:**

These types are based on Obsidian's property system, which `mdmd` uses as its
primary reference. Other markdown editors may use similar conventions.

| Property Type | JSON Representation         | Example                          |
|---------------|-----------------------------|----------------------------------|
| Text          | `string`                    | `"some text"`                    |
| List          | `array` of strings          | `["item1", "item2"]`             |
| Number        | `number`                    | `42`                             |
| Checkbox      | `boolean`                   | `true`                           |
| Date          | `string` (ISO 8601 date)    | `"2026-02-17"`                   |
| Date & time   | `string` (ISO 8601)         | `"2026-02-17T14:30:00"`          |
| Tags          | `array` of strings          | `["tag1", "tag2"]`               |

**Performance strategy:**
- The entire refresh operation runs within a single SQLite transaction.
  A crash mid-refresh rolls back cleanly, leaving the previous index intact.
- Store `(mtime, size)` per file in the index.
- On refresh, `stat()` every `.md` file in the collection to detect:
  - **New files**: Files present in collection but not in index
  - **Deleted files**: Files in index but no longer exist in collection
  - **Moved files**: Old path no longer exists, new path appears (detected as delete + add)
  - **Modified files**: Files where mtime or size has changed
- Only re-parse frontmatter for files where mtime or size has changed.
- Remove index entries for files that no longer exist at their indexed path.
- Add index entries for newly discovered files.
- The `stat()` loop is fast (tens of thousands of files/second on Linux). The
  expensive operation is YAML parsing, which this approach minimizes.
- **Note on file moves:** When a note is moved within the collection, the old
  `path_in_collection` row is deleted and a new row is inserted with the new path.
  The `mdmd_id` in the frontmatter ensures note identity is preserved across moves.
- Filesystem watching (inotify) is explicitly deferred. The mtime approach is
  sufficient unless the collection grows to hundreds of thousands of files.

### `mdmd sync`

Ensures `mdmd_notes/` in cwd is an exact mirror of all collection notes whose
`path` property equals the current directory.

Steps:
1. Run `refresh_index` (always, since it's fast with mtime optimization).
2. Query the index for all notes where `path` equals cwd (exact match).
3. Determine desired symlink state: set of `(symlink_name, path_in_collection)` pairs.
4. Create `mdmd_notes/` directory if it does not exist.
5. Scan existing `mdmd_notes/` directory.
6. Remove symlinks that don't correspond to a matched note.
7. Create symlinks for matched notes that aren't already linked.
8. Fix symlinks that point to stale paths (e.g., note was moved in collection).
9. If cwd is a git repo, ensure `mdmd_notes/` is in `.git/info/exclude`.

**Sync is idempotent.** Running it twice produces the same result.

Manually deleted symlinks are recreated. The collection is the source of truth.

### `mdmd remove <symlink>...`

Removes one or more notes from the collection by specifying their symlinks in the
current directory.

**Arguments:**
- `<symlink>...`: One or more paths to symlinks in `mdmd_notes/` directory
  (e.g., `mdmd_notes/foo.md mdmd_notes/bar.md`)

**Steps (per symlink):**
1. Verify symlink exists in `mdmd_notes/` within cwd.
2. Resolve symlink to get physical path in collection.
3. Verify target file exists and is within the collection (safety check).
4. Read target file's frontmatter and extract `path` property.
5. Verify `path` equals current working directory (safety check - error if mismatch).
6. **[If `--dry-run`]** Print what would be deleted and skip to next symlink.
7. Delete the physical file from collection.
8. Remove entry from SQLite index immediately:
   ```sql
   DELETE FROM index_notes WHERE path_in_collection = ?
   ```
9. Remove the symlink from `mdmd_notes/`.

**Flags:**
- `--dry-run`: Show what would be deleted without actually deleting
- `-i, --interactive`: Prompt for confirmation before each deletion

**Error cases:**
- Symlink does not exist: error and abort
- Symlink target not found: error and abort
- Target is outside collection: error and abort
- Frontmatter `path` doesn't match cwd: error with message "metadata mismatch: 
  note claims to belong to {note.path} but symlink is in {cwd}" and abort
- Note has no `path` property in frontmatter: error and abort
- Note is not managed (no `mdmd_id`): warning, but continue with deletion

**Behavior:**
- No confirmation prompt by default - deletion is immediate unless `-i` is passed
- Supports batch operations: multiple symlinks can be removed in one command
- All safety checks must pass for ALL symlinks before ANY deletions occur
- If any symlink fails safety checks, the entire operation aborts with no changes

**Example:**
```bash
cd /home/user/my-project
ls mdmd_notes/
# architecture-notes.md -> /collection/mdmd_notes/architecture-notes.md
# meeting-notes.md -> /collection/mdmd_notes/meeting-notes.md

# Remove single note
mdmd remove mdmd_notes/architecture-notes.md
# ✓ Deleted: /collection/mdmd_notes/architecture-notes.md
# ✓ Removed from index
# ✓ Removed symlink

# Remove multiple notes
mdmd remove mdmd_notes/*.md
# ✓ Deleted: /collection/mdmd_notes/architecture-notes.md
# ✓ Deleted: /collection/mdmd_notes/meeting-notes.md
# (2 notes removed)

# Dry run
mdmd remove --dry-run mdmd_notes/architecture-notes.md
# Would delete: /collection/mdmd_notes/architecture-notes.md
# Would remove from index: path_in_collection='mdmd_notes/architecture-notes.md'
# Would remove symlink: mdmd_notes/architecture-notes.md

# Interactive mode
mdmd remove -i mdmd_notes/architecture-notes.md
# Delete /collection/mdmd_notes/architecture-notes.md? [y/N]: y
# ✓ Deleted: /collection/mdmd_notes/architecture-notes.md
```

## Future Considerations

- Configurable collection path (CLI flag, env var, or config file).
- Configurable target directory (instead of always using cwd).
- Configurable symlink directory name (default: `mdmd_notes/`).
- Additional CRUD operations on notes (create new note, read/query, update frontmatter).
- Search and filter by frontmatter properties (tags, dates, etc.).
- Faceted narrowing.
- TUI for interactive browsing/filtering (using opentui).
- `mdmd unlink` command: Remove symlink from current directory and update note's
  `path` to disassociate it from this directory (without deleting the note).

## Open Questions

None at this time.

## Decisions Log

- **Tool name**: `mdmd` (Metadata Markdown Manager) - reflects the core
  functionality of managing markdown via metadata, independent of any specific
  note-taking application.
- **Primary target**: Obsidian vaults, with architecture supporting other
  markdown collections in the future.
- **Path property**: Scalar string (`path: string`) instead of array. Each note
  is associated with exactly one directory. This simplifies the model and makes
  queries more efficient.
- **Path representation**: absolute paths. Known limitation: associations break
  if the project directory is moved/renamed.
- **Frontmatter on ingest**: if the file has no frontmatter, create it from
  scratch with all required mdmd properties.
- **Index scope**: all collection markdown files are indexed, not just managed ones.
  This enables future collection-wide search/filtering.
- **Index table name**: `index_notes` (clarifies it's an index, not the source data).
- **Primary key**: `path_in_collection` serves as the primary key. When files are
  moved within the collection, the old row is deleted and a new row is inserted.
  Note identity is preserved via `mdmd_id` in frontmatter.
- **Symlink directory**: `mdmd_notes/` (visible, not dot-prefixed). Configurable.
- **Index format**: SQLite. Frontmatter stored as JSON column, queried via
  SQLite's native `json_extract()` and `json_each()`. No denormalized tables
  upfront; indexed generated columns can be added later if needed.
- **refresh_index operation**: Internal operation, not exposed as CLI command.
  Automatically called by other commands as needed.
- **Removal behavior**: No confirmation by default. Interactive mode via `-i` flag.
  All safety checks must pass before any deletions occur.
- **Language/runtime**: TypeScript on Bun. opentui available for future TUI
  needs, but initial implementation is CLI-only.
