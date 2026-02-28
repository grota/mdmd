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

Collection resolution priority:
1. CLI `--collection`
2. `MDMD_COLLECTION_PATH` environment variable
3. mdmd config (`$XDG_CONFIG_HOME/mdmd/config.yaml`, fallback `~/.config/mdmd/config.yaml`)
4. Active Obsidian vault from `$XDG_CONFIG_HOME/obsidian/obsidian.json` (fallback `~/.config/obsidian/obsidian.json`)

### Frontmatter Properties

Notes managed by `mdmd` have the following frontmatter properties:

| Property     | Type       | Required | Set by                   | Description                                              |
|--------------|------------|----------|--------------------------|----------------------------------------------------------|
| `mdmd_id`    | UUID v4    | Yes      | `ingest` / `link`        | Unique identity for the note across renames and moves    |
| `paths`      | `string[]` | Yes      | `ingest` / `link` / `unlink` | Absolute paths of project directories this note is associated with |
| `created_at` | ISO 8601   | Yes      | `ingest` / `link` (first time) | When mdmd first managed this note                 |

Notes in the collection that have never been managed by mdmd have none of these
properties and are still indexed, but do not participate in `sync`.

### Note Identity

Notes are uniquely identified by `mdmd_id` (UUID v4), stored in frontmatter.
This allows notes to be renamed or moved within the collection without losing
identity or path associations.

Rules:
- A note with a `mdmd_id` is considered **managed**. Only managed notes participate
  in `sync` (since `sync` matches on the `paths` property).
- `ingest` and `link` always assign a `mdmd_id` if one is not present.
- `refresh_index` indexes all markdown files in the collection, regardless of
  whether they have a `mdmd_id`. This enables collection-wide search and filtering.

### Multi-directory Associations

A note's `paths` array holds the absolute paths of every project directory it is
linked to. A note may be associated with:
- **Zero directories**: it exists only in the collection (not projected anywhere).
- **One directory**: the common case — linked to exactly one project.
- **Multiple directories**: the note is relevant to more than one project.

`sync` for a given cwd creates symlinks for every managed note whose `paths` array
contains that cwd.

### Symlink Directory

Notes are projected into project directories as symlinks inside a subdirectory.
Two separate config settings govern the directory names involved:

- `symlink-dir` (default: `mdmd_notes/`): name of the symlink directory created
  inside each project directory (e.g., `<cwd>/mdmd_notes/`).
- `collection-notes-path` (default: `mdmd_notes/`): subdirectory within the
  collection root where `ingest` places newly ingested files
  (e.g., `<collection_root>/mdmd_notes/`). Does not affect `link`, which targets
  notes wherever they live in the collection.

Both default to `mdmd_notes/` but are configured independently.

Symlinks are named after the collection file's basename. In case of collisions
(two notes with the same filename both associated with the same cwd), disambiguate
by appending the parent folder name, e.g. `note__subfolder.md`.
If that still generates a collision, error out.

## Note Lifecycle

The following walkthrough illustrates the full lifecycle:

```bash
# Start with a local file — move it into the collection and link it here
mdmd ingest ./ideas.md
# ideas.md moved to <collection>/mdmd_notes/ideas.md
# frontmatter: mdmd_id assigned, paths=[/current/project], created_at set
# symlink created: mdmd_notes/ideas.md -> <collection>/mdmd_notes/ideas.md

# Adopt an existing note already in the Obsidian vault
mdmd link Projects/architecture.md
# frontmatter: mdmd_id assigned (if absent), /current/project appended to paths
# symlink created: mdmd_notes/architecture.md -> <collection>/Projects/architecture.md

# Share that note with another project
cd /other-project
mdmd link Projects/architecture.md
# frontmatter: /other-project appended to paths
# symlink created: mdmd_notes/architecture.md -> <collection>/Projects/architecture.md

# List notes linked to the current project
mdmd list
# architecture.md  (also linked from: /current/project)
# (ideas.md is not listed here — it belongs to /current/project, not /other-project)

# Done with it in this project — detach without deleting
mdmd unlink mdmd_notes/architecture.md
# /other-project removed from paths in frontmatter and index
# symlink mdmd_notes/architecture.md removed
# note remains in collection, still linked from /current/project

# Permanently delete a note from the collection
cd /current/project
mdmd remove mdmd_notes/architecture.md
# Safety check: passes (paths contains only /current/project now)
# physical file deleted from collection
# index row deleted, symlink removed

# remove refuses if note is still linked elsewhere
mdmd remove mdmd_notes/ideas.md   # (hypothetically still linked from /other-project too)
# Error: note is also linked from /other-project. Use --force to delete anyway.
```

## Commands

### `mdmd ingest <file> [file...]`

Takes one or more local files, moves them into the collection, and links them to
the current directory. It is a thin wrapper: move the file, then apply `link`
semantics.

For each input file (processed in argument order):
1. Parse existing frontmatter (if any) and preserve non-mdmd properties.
2. Determine destination in collection: `<collection_root>/<collection-notes-path>/<filename>`.
   - If a file with the same name already exists there, append a short suffix
     (e.g., `ideas_2.md`) to avoid collisions.
3. Set/overwrite `mdmd` managed properties:
   - `mdmd_id`: generate UUID v4 (unless already present and valid).
   - `paths`: initialize to `[<cwd>]` (or append cwd if already has other paths).
   - `created_at`: set to current timestamp (if not already present).
4. Write updated frontmatter back to the file, then move the file to the collection
   destination.
5. Upsert the note into the SQLite index.
6. Create the symlink directory in cwd if it does not exist.
7. Create a symlink from `<cwd>/<symlink-dir>/<filename>` to the collection file.
8. If cwd is a git repo, ensure `<symlink-dir>/` is in `.git/info/exclude`.

When multiple files are provided, ingest stops at the first error. Files already
ingested earlier in that invocation remain ingested.

**Error cases:**
- File does not exist: error.
- File is already in the collection (path prefix match): error, suggest `link`.
- File already has a `mdmd_id` in the index: error, already managed. Suggest `link`
  or `sync`.

### `mdmd link <collection-relative-path>`

Associates an existing collection note with the current directory. Works for notes
already managed by mdmd as well as unmanaged notes (adopts them).

Steps:
1. Resolve the path relative to the collection root. Error if the file does not exist.
2. Read existing frontmatter.
3. If `mdmd_id` is absent, assign a new UUID v4.
4. If `cwd` is not already in `paths`, append it.
5. Set `created_at` if not present.
6. Write updated frontmatter back to the file.
7. Upsert the note into the SQLite index.
8. Create the symlink directory in cwd if it does not exist.
9. Create a symlink from `<cwd>/<symlink-dir>/<basename>` to the collection file.
   (Handle name collisions as described in Symlink Directory section.)
10. If cwd is a git repo, ensure `<symlink-dir>/` is in `.git/info/exclude`.

**`link` is idempotent**: if cwd is already in `paths` and the symlink exists,
it exits cleanly (equivalent to `sync` for that one note).

**Error cases:**
- Collection file not found: error.
- Symlink name collision that cannot be resolved: error.

### `mdmd unlink <symlink>...`

Detaches a note from the current directory without deleting it from the collection.
The note remains in the collection and stays linked to any other directories.

Steps (per symlink):
1. Verify the symlink exists in `<cwd>/<symlink-dir>/`.
2. Resolve the symlink to get the physical collection path.
3. Verify the target exists and is within the collection.
4. Read frontmatter; verify note is managed (has `mdmd_id`).
5. Remove cwd from `paths`. Write updated frontmatter back to file.
6. Update the SQLite index.
7. Remove the symlink.

**Flags:**
- `-i, --interactive`: Prompt for confirmation before each unlink.

**Error cases:**
- Symlink does not exist: error.
- Target is outside the collection: error.
- Note is not managed (no `mdmd_id`): error (nothing to unlink from).
- cwd is not in note's `paths`: warning, still removes the symlink (drift recovery).

### `mdmd list`

Lists notes associated with the current directory, or all notes in the collection.

**Flags:**
- `--collection`: List all managed notes in the collection, not just those for cwd.
- `--json`: Emit machine-readable JSON.
- `--all-fields`: Include full frontmatter in output.

**Default output** (notes for cwd):
```
architecture.md   (also linked from: /other-project)
ideas.md
meeting-notes.md  (also linked from: /team-project, /archive)
```

**JSON output** per note includes: `path_in_collection`, `mdmd_id`, `paths`,
`created_at`, and any other frontmatter properties.

### Internal: `refresh_index`

**Note:** This is an internal operation automatically called by other commands.
It is not exposed as a standalone CLI command.

Scans the entire collection and builds/updates an index of note metadata.

**Index storage:** SQLite database at `$XDG_DATA_HOME/mdmd/index.db`
(fallback `~/.local/share/mdmd/index.db`).

**Schema:**

```sql
CREATE TABLE collections (
    collection_id       INTEGER PRIMARY KEY,
    root                TEXT NOT NULL UNIQUE
);

CREATE TABLE index_notes (
    collection_id      INTEGER NOT NULL,           -- foreign key to collections(collection_id)
    path_in_collection TEXT NOT NULL,              -- relative path within the collection
    mdmd_id            TEXT,                       -- UUID if managed, NULL otherwise
    mtime              INTEGER NOT NULL,           -- file mtime (epoch seconds)
    size               INTEGER NOT NULL,           -- file size in bytes
    frontmatter        TEXT,                       -- full frontmatter stored as JSON
    PRIMARY KEY (collection_id, path_in_collection)
);

CREATE UNIQUE INDEX idx_notes_collection_mdmd_id
ON index_notes(collection_id, mdmd_id)
WHERE mdmd_id IS NOT NULL;
```

**Querying frontmatter:**

Frontmatter is stored as a JSON string in the `frontmatter` column. SQLite's
built-in JSON functions are used for all queries:

- **Scalar properties** (text, number, checkbox, date, date & time): use
  `json_extract()` directly, e.g.:
  ```sql
  SELECT * FROM index_notes WHERE json_extract(frontmatter, '$.status') = 'draft';
  ```

- **Searching within `paths` array** (used by `sync` and `list`):
  ```sql
  -- Find all managed notes associated with a directory
  SELECT n.* FROM index_notes n
  INNER JOIN collections c ON c.collection_id = n.collection_id
  WHERE c.root = '/path/to/collection'
    AND n.mdmd_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM json_each(json_extract(n.frontmatter, '$.paths'))
      WHERE value = '/home/grota/Projects/personal/my-project'
    );
  ```

- **Other list/array properties** (tags, etc.): use `json_each()` similarly:
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

Ensures `<cwd>/<symlink-dir>/` is an exact mirror of all managed collection notes
whose `paths` array contains the current directory.

Steps:
1. Run `refresh_index` (always, since it's fast with mtime optimization).
2. Query the index for all notes where `mdmd_id` is present and `paths` contains cwd.
3. Determine desired symlink state: set of `(symlink_name, path_in_collection)` pairs.
4. Create symlink directory if it does not exist.
5. Scan existing symlink directory.
6. Remove symlinks that don't correspond to a matched note.
7. Create symlinks for matched notes that aren't already linked.
8. Fix symlinks that point to stale paths (e.g., note was moved in collection).
9. If cwd is a git repo, ensure symlink dir is in `.git/info/exclude`.

**Sync is idempotent.** Running it twice produces the same result.

Manually deleted symlinks are recreated. The collection is the source of truth.

### `mdmd remove <symlink>...`

Permanently deletes one or more notes from the collection by specifying their
symlinks in the current directory.

**Arguments:**
- `<symlink>...`: One or more symlink paths inside the symlink directory
  (e.g., `mdmd_notes/foo.md mdmd_notes/bar.md`)

**Steps (per symlink, all safety checks run before any deletions):**
1. Verify symlink exists.
2. Resolve symlink to get physical collection path.
3. Verify target file exists and is within the collection.
4. Read frontmatter; extract `paths`.
5. If `paths` contains entries **other than cwd**, abort with a warning listing
   the other directories. Require `--force` to override.
6. **[If `--dry-run`]** Print what would be deleted and stop.
7. Delete the physical file from the collection.
8. Remove the index entry.
9. Remove the symlink.

**Flags:**
- `--dry-run`: Show what would be deleted without actually deleting.
- `-i, --interactive`: Prompt for confirmation before each deletion.
- `--force`: Delete even if the note is still linked from other directories.

**Error cases:**
- Symlink does not exist: error and abort.
- Symlink target not found: error and abort.
- Target is outside collection: error and abort.
- Note still linked from other directories (without `--force`): error and abort.
- Note is not managed (no `mdmd_id`): warning, still proceed with deletion.

**Behavior:**
- All safety checks must pass for ALL symlinks before ANY deletions occur.
- No confirmation prompt by default unless `-i`.

**Example:**
```bash
# Remove a note only linked here — succeeds immediately
mdmd remove mdmd_notes/ideas.md
# ✓ Deleted: <collection>/mdmd_notes/ideas.md

# Remove a note also linked elsewhere — blocked
mdmd remove mdmd_notes/architecture.md
# Error: architecture.md is also linked from: /other-project
# Use --force to delete anyway.

# Force delete
mdmd remove --force mdmd_notes/architecture.md
# ✓ Deleted: <collection>/Projects/architecture.md

# Dry run
mdmd remove --dry-run mdmd_notes/ideas.md
# Would delete: <collection>/mdmd_notes/ideas.md

# Interactive
mdmd remove -i mdmd_notes/ideas.md
# Delete <collection>/mdmd_notes/ideas.md? [y/N]: y
# ✓ Deleted
```

### `mdmd doctor`

Runs health checks for index, symlink state, and configuration.

By default, `doctor` is **read-only** and reports problems without changing files.

**Flags:**
- `--scope <scope>`: `index`, `symlinks`, `config`, or `all` (default: `all`)
- `--fix`: Apply safe deterministic fixes
- `--json`: Emit machine-readable JSON report
- `-c, --collection <dir>`: Override collection root (same priority semantics as other commands)

**Checks:**
- **Index scope**
  - Stale index rows whose `path_in_collection` no longer exists in collection
  - Missing index rows for markdown files present in collection
  - Duplicate `mdmd_id` values (if present)
  - Invalid managed metadata in frontmatter (`mdmd_id`, `paths`, `created_at`)
  - Stale `paths` entries pointing to directories that no longer exist on disk
    (warning: the directory may be temporarily unmounted, not necessarily an error)
- **Symlinks scope**
  - Missing expected symlinks in `<cwd>/<symlink-dir>/`
  - Orphan symlinks not represented by current managed-note selection
  - Broken symlinks and stale/wrong symlink targets
  - Non-symlink filesystem entries inside `<cwd>/<symlink-dir>/`
- **Config scope**
  - Collection root existence/accessibility
  - Presence of symlink dir in `.git/info/exclude` when cwd is a git repo

**Fix behavior (`--fix`):**
- Allowed automatic fixes:
  1. Run internal `refresh_index`
  2. Reconcile symlinks using `sync` semantics
  3. Ensure symlink dir entry exists in `.git/info/exclude`
  4. Remove stale `paths` entries for directories confirmed not to exist
- `doctor --fix` never deletes collection notes automatically.

**Output contract:**
- Human output: summary + issue lines
- JSON output includes:
  - `healthy: boolean`
  - `issues: [{severity, scope, code, path?, message}]`
  - `fixesApplied: string[]`
- Exit codes:
  - `0`: no issues
  - `1`: issues found (after fixes, if `--fix` is used)
  - `2`: runtime error executing doctor

### `mdmd config`

Manages mdmd configuration values.

**Storage format:** YAML (comment-friendly) at
`$XDG_CONFIG_HOME/mdmd/config.yaml` (fallback `~/.config/mdmd/config.yaml`).

`config` uses topic-style subcommands (`mdmd config <subcommand>`) with oclif's
space topic separator.

**Config keys:**

| Key | Default | Description |
|-----|---------|-------------|
| `collection` | (none) | Absolute path to the collection root |
| `collection-notes-path` | `mdmd_notes` | Subdirectory within the collection where `ingest` places new files |
| `symlink-dir` | `mdmd_notes` | Name of the symlink directory created inside each project directory |

**Subcommands:**
- `mdmd config` (prints available config subcommands)
- `mdmd config list [--resolved] [--json]`
- `mdmd config get <key> [--resolved] [--json]`
- `mdmd config set <key> <value>`
- `mdmd config unset <key>`

**Behavior:**
- `--resolved` on `get collection` returns the effective value after full
  resolution (including Obsidian fallback).
- `--json` returns machine-readable output suitable for scripts.

## Implementation Order

Implement commands in this order to minimize cross-command rework:
1. internal `refresh_index`
2. `link`
3. `ingest` (wraps `link`)
4. `unlink`
5. `sync`
6. `list`
7. `remove`
8. `doctor`
9. `config` (new keys)

## Future Considerations

- `mdmd move <symlink> --to <other-dir>`: reassign a note's path association
  (equivalent to `unlink` + `link` in the target directory).
- Search and filter by frontmatter properties (tags, dates, etc.) via `mdmd list`.
- Faceted narrowing.
- TUI for interactive browsing/filtering (using opentui).

## Open Questions

None at this time.

## Decisions Log

- **Tool name**: `mdmd` (Metadata Markdown Manager) - reflects the core
  functionality of managing markdown via metadata, independent of any specific
  note-taking application.
- **Primary target**: Obsidian vaults, with architecture supporting other
  markdown collections in the future.
- **`paths` property**: Array of strings (`paths: string[]`). A note can be
  associated with zero, one, or many project directories. This is the central
  design choice enabling `link`/`unlink` and safe multi-project sharing.
  Replaced the prior scalar `path: string` design.
- **`git_sha` dropped**: With `paths` being an array, there is no single git
  repository to associate a SHA with. The property was low-value and is removed.
  Users who need it can add it manually.
- **`link` and `unlink` are atoms**: `ingest` = move + link. `remove` = unlink-all
  + delete. `sync` = reconcile reality to match what `paths` says. All commands
  compose from these two primitives.
- **`remove` multi-path safety**: If a note's `paths` contains entries beyond the
  current cwd, `remove` aborts unless `--force` is passed. This prevents accidental
  deletion of notes still in use elsewhere.
- **Path representation**: absolute paths. Known limitation: associations break
  if the project directory is moved/renamed. `doctor` can detect and optionally
  clean stale path entries.
- **Collection path configuration priority**: CLI flag > env var > mdmd config >
  Obsidian active-vault fallback.
- **Frontmatter on ingest/link**: if the file has no frontmatter, create it from
  scratch with all required mdmd properties.
- **Index scope**: all collection markdown files are indexed, not just managed ones.
  This enables future collection-wide search/filtering.
- **Sync scope**: only managed notes (`mdmd_id` is not NULL) are eligible for sync.
- **Index table name**: `index_notes` (clarifies it's an index, not the source data).
- **Primary key**: `(collection_id, path_in_collection)` serves as the primary key.
  When files are moved within the collection, the old row is deleted and a new row
  is inserted. Note identity is preserved via `mdmd_id` in frontmatter.
- **Symlink directory**: `mdmd_notes/` by default (visible, not dot-prefixed).
  Configurable via `symlink-dir` config key.
- **Collection notes directory**: `mdmd_notes/` by default within the collection
  root. Configurable via `collection-notes-path` config key. These two settings are
  independent; they happen to share the same default.
- **Index format**: SQLite. Frontmatter stored as JSON column, queried via
  SQLite's native `json_extract()` and `json_each()`. No denormalized tables
  upfront; indexed generated columns can be added later if needed.
- **Config format**: YAML for comment support.
- **XDG compliance**:
  - mdmd config uses `$XDG_CONFIG_HOME/mdmd/config.yaml` fallback `~/.config/mdmd/config.yaml`
  - index db uses `$XDG_DATA_HOME/mdmd/index.db` fallback `~/.local/share/mdmd/index.db`
- **refresh_index operation**: Internal operation, not exposed as CLI command.
  Automatically called by other commands as needed.
- **Removal behavior**: No confirmation by default. Interactive mode via `-i` flag.
  All safety checks must pass before any deletions occur.
- **Language/runtime**: TypeScript on Bun. opentui available for future TUI
  needs, but initial implementation is CLI-only.
