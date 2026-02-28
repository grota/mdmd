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

mdmd has a strict ownership model for frontmatter:

- **mdmd-maintained properties**: mdmd reads and writes these. They are the
  structural metadata mdmd needs to function. mdmd will overwrite stale values.
- **mdmd-stamped properties**: mdmd writes these exactly once (when absent) and
  never overwrites them again. They record point-in-time facts.
- **User properties**: everything else. mdmd never touches them. Users are free
  to add any frontmatter keys they want (`tags`, `status`, `project`, `git_sha`,
  etc.). mdmd indexes them all via the JSON `frontmatter` column, making them
  queryable, but takes no responsibility for their consistency.

| Property     | Type       | Ownership   | Set by                          | Description                                                              |
|--------------|------------|-------------|---------------------------------|--------------------------------------------------------------------------|
| `mdmd_id`    | UUID v4    | maintained  | `ingest` / `link`               | Unique identity for the note across renames and moves                    |
| `paths`      | `string[]` | maintained  | `ingest` / `link` / `remove`    | Absolute paths of project directories this note is associated with       |
| `created_at` | ISO 8601   | stamped     | `ingest` / `link` (first time)  | When mdmd first managed this note; never overwritten                     |
| `git_sha`    | string     | stamped     | `ingest` (if cwd is a git repo) | HEAD commit SHA at time of ingestion; records the project state snapshot |

`git_sha` is set once at `ingest` time and never updated. It intentionally
records the state of the project at the moment the note was moved into the
collection — useful for research and reference notes that document
"the situation as of this commit." If the note is later linked to additional
directories via `link`, `git_sha` is not changed; it retains the original
ingestion context.

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

Notes are projected into project directories as symlinks inside a dedicated
subdirectory. Its name is configurable via `symlink-dir` (default: `mdmd_notes/`).
Example: `<cwd>/mdmd_notes/`. This directory contains **only symlinks** — files
should never be edited inside it directly.

Symlinks are named after the collection file's basename. In case of collisions
(two notes with the same filename both associated with the same cwd), disambiguate
by appending the parent folder name, e.g. `note__subfolder.md`.
If that still generates a collision, error out.

### Ingest Destination

When `ingest` moves a file into the collection, it places it in a subdirectory
configured via `ingest-dest` (default: `inbox/`). This affects only `ingest`;
`link` works with notes wherever they already live in the collection.

The default `inbox/` is intentionally different from the cwd symlink dir
(`mdmd_notes/`) to avoid confusion between physical collection files and
per-project symlinks. The `inbox/` name matches common vault conventions:
files land there and can be reorganised in Obsidian afterward.

Override per-call with `--dest <collection-relative-dir>`, or set permanently:
```
mdmd config set ingest-dest Projects/work
```

### Index as Cache: Frontmatter is Truth

The SQLite index is a **cache** of what the collection's frontmatter says.
Frontmatter on disk is always authoritative.

Consequences:
- Users can edit `paths`, `mdmd_id`, or any other frontmatter directly in
  Obsidian (or any editor) and mdmd will honour it on the next command run.
- Every user-facing command (`ingest`, `sync`, `link`, `list`, `remove`,
  `doctor`) runs `refresh_index` first, so the cache is always fresh before
  any decision is made.
- External changes (note moved/renamed in Obsidian, frontmatter edited) are
  self-healing: the next command run picks them up automatically.
- There is an unavoidable gap between an external change and the next command
  run (e.g., a broken symlink after a note is moved). This is accepted — the
  same trade-off git makes with untracked file changes.

## Note Lifecycle

The following walkthrough illustrates the full lifecycle:

```bash
# Start with a local file — move it into the collection and link it here
mdmd ingest ./ideas.md
# ideas.md moved to <collection>/inbox/ideas.md
# frontmatter: mdmd_id assigned, paths=[/current/project], created_at set, git_sha set (if git repo)
# symlink created: mdmd_notes/ideas.md -> <collection>/inbox/ideas.md

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
mdmd remove mdmd_notes/architecture.md
# /other-project removed from paths in frontmatter and index
# symlink mdmd_notes/architecture.md removed
# note remains in collection, still linked from /current/project

# Permanently delete a note from the collection
cd /current/project
mdmd remove mdmd_notes/architecture.md
# paths now contains only /current/project → last path removed
# physical file deleted from collection
# index row deleted, symlink removed

# remove all path associations at once and delete
mdmd remove --all mdmd_notes/ideas.md   # (linked from /other-project too)
# symlinks in both /current/project and /other-project removed
# physical file deleted from collection
```

## Commands

### `mdmd ingest <file> [file...] [--dest <collection-relative-dir>]`

Takes one or more local files, moves them into the collection, and links them to
the current directory. It is a thin wrapper: move the file, then apply `link`
semantics.

For each input file (processed in argument order):
1. Parse existing frontmatter (if any) and preserve non-mdmd properties.
2. Determine destination in collection: `<collection_root>/<ingest-dest>/<filename>`,
   where `ingest-dest` comes from `--dest` flag > `ingest-dest` config > `inbox/`.
   - If a file with the same name already exists there, append a short suffix
     (e.g., `ideas_2.md`) to avoid collisions.
3. Write mdmd managed properties into the frontmatter:
   - `mdmd_id`: generate UUID v4 (unless already present and valid). *(maintained — overwritten if invalid)*
   - `paths`: initialize to `[<cwd>]` (or append cwd if already has other paths). *(maintained — always updated)*
   - `created_at`: set to current timestamp if not already present; never overwrite. *(stamped)*
   - `git_sha`: set to HEAD SHA if cwd is a git repo, only if not already present. *(stamped)*
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

**Known UX limitation**: `link` requires the user to supply a collection-relative
path, which means knowing where the note lives inside the collection. Use
`mdmd list --collection` to discover paths before linking.

**Error cases:**
- Collection file not found: error.
- Symlink name collision that cannot be resolved: error.

### `mdmd remove <symlink>...`

Removes path associations from one or more managed notes. By default, removes
cwd from `paths` for each given symlink and deletes the collection file if no
paths remain. Use `--all` to remove all associations at once. Use `--preserve`
to keep the file even if paths becomes empty.

**Arguments:**
- `<symlink>...`: One or more symlink paths inside the symlink directory
  (e.g., `mdmd_notes/foo.md mdmd_notes/bar.md`)

**Steps (per symlink, all safety checks run before any changes):**
1. Verify the symlink exists in `<cwd>/<symlink-dir>/`.
2. Resolve the symlink to get the physical collection path.
3. Verify the target exists and is within the collection.
4. Read frontmatter; verify note is managed (has `mdmd_id`).
5. Default mode: verify cwd is in `paths` (error if not — indicates drift).
6. Compute `remainingPaths = existingPaths − pathsToRemove`.
7. Determine `willDeleteFile = remainingPaths.length === 0 && !--preserve`.
8. **[If `--dry-run`]** Print the plan and stop.
9. Remove the symlink(s): always the cwd symlink; if `--all`, also symlinks in
   all other path directories (best-effort — warns on failure, does not abort).
10. If `willDeleteFile`: delete the physical file from the collection and remove
    the index entry.
11. Otherwise: write updated frontmatter (`paths = remainingPaths`) and upsert
    the index.

**Flags:**
- `-a, --all`: Remove ALL path associations (not just cwd). Attempts to remove
  symlinks from every directory in `paths`. Combined with the default delete
  behavior, this is equivalent to the old `remove --force`.
- `-p, --preserve`: Keep the collection file even if `remainingPaths` is empty.
  Creates an "orphaned" note (no `paths`) that can be re-linked later.
- `--dry-run`: Show what would change without executing.
- `-i, --interactive`: Prompt for confirmation before each note.

**Error cases:**
- Symlink does not exist: error and abort.
- Symlink target not found: error and abort.
- Target is outside collection: error and abort.
- Note is not managed (no `mdmd_id`): error and abort.
- cwd not in note's `paths` (default mode only): error and abort.
- All safety checks must pass for ALL symlinks before ANY changes occur.

**Example:**
```bash
# Default: remove cwd from paths — file deleted because last path
mdmd remove mdmd_notes/ideas.md
# ✓ Removed cwd from paths. No remaining paths → deleted: <collection>/inbox/ideas.md

# Default: remove cwd from paths — file kept because other paths remain
mdmd remove mdmd_notes/architecture.md
# ✓ Removed /current/project from paths. Remaining: /other-project

# Remove all associations and delete
mdmd remove --all mdmd_notes/architecture.md
# ✓ Removed all paths. Deleted: <collection>/Projects/architecture.md

# Remove all but keep the file
mdmd remove --all --preserve mdmd_notes/architecture.md
# ✓ Removed all paths. File preserved (no paths remain).

# Dry run
mdmd remove --dry-run mdmd_notes/ideas.md
# Would remove /current/project from paths. No remaining paths → would delete: <collection>/inbox/ideas.md

# Interactive
mdmd remove -i mdmd_notes/ideas.md
# Remove /current/project from paths of <collection>/inbox/ideas.md? [y/N]: y
# ✓ Done
```

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

**Note:** This is an internal operation automatically called by **every
user-facing command** before it does any work. It is not exposed as a standalone
CLI command.

Scans the entire collection and builds/updates an index of note metadata.
Because every command runs it first, the index is always fresh when decisions
are made — no stale reads.

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
1. Query the index for all notes where `mdmd_id` is present and `paths` contains cwd.
2. Determine desired symlink state: set of `(symlink_name, path_in_collection)` pairs.
3. Create symlink directory if it does not exist.
4. Scan existing symlink directory.
5. Remove symlinks that don't correspond to a matched note.
6. Create symlinks for matched notes that aren't already linked.
7. Fix symlinks that point to stale paths (e.g., note was moved in collection).
8. If cwd is a git repo, ensure symlink dir is in `.git/info/exclude`.

**Sync is idempotent.** Running it twice produces the same result.

Manually deleted symlinks are recreated. The collection is the source of truth.

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
  4. Remove stale `paths` entries (for directories confirmed not to exist) from
     note frontmatter and index — modifies collection files but never deletes them.
- `doctor --fix` never deletes collection note files automatically.

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
| `ingest-dest` | `inbox` | Collection-relative subdirectory where `ingest` places new files; override per-call with `--dest` |
| `symlink-dir` | `mdmd_notes` | Name of the symlink directory created inside each project directory |

**Subcommands:**
- `mdmd config` (prints available config subcommands)
- `mdmd config list [--resolved] [--json]`
- `mdmd config get <key> [--resolved] [--json]`
- `mdmd config set <key> <value>`
- `mdmd config unset <key>`

**Behavior:**
- `--resolved` on `get collection` returns the effective value after full
  resolution (including Obsidian fallback). For all other keys (`ingest-dest`,
  `symlink-dir`) there is no resolution chain — `--resolved` returns the
  configured value or the hardcoded default, same as without the flag.
- `--json` returns machine-readable output suitable for scripts.

## Implementation Order

Implement commands in this order to minimize cross-command rework:
1. internal `refresh_index`
2. `link`
3. `ingest` (wraps `link`)
4. `sync`
5. `list`
6. `remove`
7. `doctor`
8. `config` (new keys)

## Future Considerations

- `mdmd move <symlink> --to <other-dir>`: reassign a note's path association
  (equivalent to `remove` + `link` in the target directory).
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
  design choice enabling `link`/`remove` and safe multi-project sharing.
  Replaced the prior scalar `path: string` design.
- **`git_sha` stamped at ingest**: `ingest` sets `git_sha` to the HEAD commit SHA
  if cwd is a git repo, but only if the property is not already present. It records
  the project state at the moment the note entered the collection — useful for
  research/reference notes that document "the situation as of this commit." It is
  never updated by mdmd after that point. Notes adopted via `link` do not get
  `git_sha` set (they already exist in the collection; their provenance predates
  mdmd management). Users can set or override `git_sha` freely.
- **`link` and remove are atoms**: `ingest` = move + link. `remove` = unlink-from-cwd
  (or unlink-all with `--all`) + optional delete. `sync` = reconcile reality to match
  what `paths` says. All commands compose from these two primitives.
- **Path representation**: absolute paths. Known limitation: associations break
  if the project directory is moved/renamed. `doctor` can detect and optionally
  clean stale path entries.
- **Collection path configuration priority**: CLI flag > env var > mdmd config >
  Obsidian active-vault fallback.
- **Frontmatter on ingest/link**: if the file has no frontmatter, create it from
  scratch with all required mdmd properties.
- **Open frontmatter model**: mdmd owns `mdmd_id` and `paths` (actively maintained).
  `created_at` and `git_sha` are stamped once and never overwritten. All other
  frontmatter keys are user territory — mdmd never reads or writes them. Users can
  add any properties they want (`tags`, `status`, custom keys). All properties are
  indexed in the JSON `frontmatter` column and queryable.
- **Index scope**: all collection markdown files are indexed, not just managed ones.
  This enables future collection-wide search/filtering.
- **Sync scope**: only managed notes (`mdmd_id` is not NULL) are eligible for sync.
- **Index table name**: `index_notes` (clarifies it's an index, not the source data).
- **Primary key**: `(collection_id, path_in_collection)` serves as the primary key.
  When files are moved within the collection, the old row is deleted and a new row
  is inserted. Note identity is preserved via `mdmd_id` in frontmatter.
- **Symlink directory**: `mdmd_notes/` by default (visible, not dot-prefixed).
  Configurable via `symlink-dir` config key. Contains only symlinks — never
  edit files there directly.
- **Ingest destination**: `inbox/` by default within the collection root.
  Configurable via `ingest-dest` config key, or overridden per-call with
  `--dest`. Intentionally different from `symlink-dir` to avoid visual
  confusion between physical collection files and per-project symlinks. Notes
  land in `inbox/` and can be reorganised inside Obsidian afterward.
- **`refresh_index` called by every command**: every user-facing command runs
  `refresh_index` before doing any work. This keeps the index cache always
  fresh and makes external frontmatter edits (e.g. in Obsidian) self-healing
  without any explicit sync step.
- **Frontmatter is truth, index is cache**: the SQLite index is derived from
  frontmatter on disk. Users can edit frontmatter directly (even `paths`) and
  mdmd will honour it on the next command run. There is an unavoidable gap
  between an external change and the next run (e.g. broken symlink after a
  note is moved in Obsidian) — this is accepted, same trade-off as git with
  untracked files.
- **Index format**: SQLite. Frontmatter stored as JSON column, queried via
  SQLite's native `json_extract()` and `json_each()`. No denormalized tables
  upfront; indexed generated columns can be added later if needed.
- **Config format**: YAML for comment support.
- **XDG compliance**:
  - mdmd config uses `$XDG_CONFIG_HOME/mdmd/config.yaml` fallback `~/.config/mdmd/config.yaml`
  - index db uses `$XDG_DATA_HOME/mdmd/index.db` fallback `~/.local/share/mdmd/index.db`
- **refresh_index operation**: Internal operation, not exposed as CLI command.
  Called automatically by every user-facing command before it does any work.
- **Removal behavior**: No confirmation by default. Interactive mode via `-i` flag.
  All safety checks must pass before any deletions occur.
- **Language/runtime**: TypeScript on Bun. TUI implemented with `@opentui/react`.

---

## TUI — `mdmd tui`

An interactive, keyboard-driven dashboard for browsing and acting on the note collection.
Targets power users: minimal mouse, vim-style navigation, contextual help.

### Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│  mdmd  │ / [___filter_________________________] │ created_at ↓  7/42 │
├──────────────────────────────┬───────────────────────────────────────┤
│ NOTE LIST                    │ NOTE PREVIEW (markdown)               │
│ ▶ ● architecture.md          │ # Architecture Decision Record        │
│   ● research.md              │                                       │
│     todo.md                  │ ## Context                            │
│     ideas.md                 │ We need to choose a storage backend   │
│     api-design.md            │ for the new API layer...              │
│     ...                      │                                       │
│                              │ ## Decision                           │
│                              │ Use SQLite for local-first storage.   │
│                              │                                       │
│                              │ (scrollable, rendered markdown)       │
├──────────────────────────────┴───────────────────────────────────────┤
│ j/k:nav  /:filter  s:sort  Enter:preview  o:edit  x:remove  ?:help   │
└──────────────────────────────────────────────────────────────────────┘
```

**Header bar**: filter input (always visible, `/` focuses it), active sort field + direction, count `filtered/total`.

**Note list** (left pane): scrollable. `●` marks notes linked to cwd. `▶` marks current cursor position. Multi-select marks shown inline. Respects active filter and sort.

**Note preview panel** (right pane): full note content rendered with OpenTUI's native `<markdown>` component (Tree-sitter syntax highlighting, scrollable). Updates live as navigation changes selection. The external viewer process is only used for the full-screen `Enter` action.

**Help bar** (bottom): single-line context-sensitive hint. `?` opens full help overlay.

### Entry point

```
mdmd tui [--collection <path>]
```

Runs collection-wide (all managed notes). cwd is used as context for `link`/`remove` actions and for the `●` indicator (notes linked to cwd).

### Modes

| Mode | Entry | Exit |
|------|-------|------|
| NORMAL | default | — |
| FILTER | `/` | `Esc` (clear) or `Enter`/`Tab` (lock) |
| BATCH | first `Space` | `Esc` or all deselected |
| HELP overlay | `?` | `?` / `Esc` / `q` |

### Keyboard shortcuts

#### NORMAL mode

| Key | Action |
|-----|--------|
| `j` / `↓` | Next note |
| `k` / `↑` | Previous note |
| `g` / `Home` | First note |
| `G` / `End` | Last note |
| `Ctrl+d` / `PageDown` | Page down |
| `Ctrl+u` / `PageUp` | Page up |
| `Enter` | Preview note in external viewer |
| `o` | Open note in `$EDITOR` |
| `l` | Link note to cwd |
| `x` | Remove note from cwd (auto-deletes file if last path) |
| `y` | Yank `path_in_collection` to clipboard (OSC 52) |
| `/` | Enter FILTER mode |
| `s` | Cycle sort field |
| `S` | Toggle sort direction (asc/desc) |
| `Space` | Toggle selection (enter BATCH mode) |
| `?` | Toggle help overlay |
| `q` / `Ctrl+C` | Quit |

#### FILTER mode

| Key | Action |
|-----|--------|
| Type | Update filter live (results narrow as you type) |
| `Enter` / `Tab` | Lock filter and return to NORMAL |
| `Esc` | Clear filter and return to NORMAL |

#### BATCH mode (selection active)

| Key | Action |
|-----|--------|
| `Space` | Toggle selection on current note |
| `*` | Select all / deselect all (filtered view) |
| `L` | Link all selected to cwd |
| `X` | Remove all selected from cwd (auto-deletes each if last path) |
| `Esc` | Clear selection |

### Filter syntax

A single input bar. Tokens separated by spaces are ANDed together.

| Token | Meaning |
|-------|---------|
| `word` (no colon) | Fuzzy match against `path_in_collection` + all frontmatter string values |
| `field:value` | Frontmatter field `field` contains `value` (substring, case-insensitive) |
| `paths:/my/proj` | Any element of the `paths` array contains `/my/proj` |
| `tags:design` | `tags` field (string or array) contains `design` |

Examples:
```
architecture                    # fuzzy filename/frontmatter match
tags:design paths:/proj/api     # structured: has tag 'design' AND linked to proj/api
tags:design api                 # structured + fuzzy combined
```

### Sort fields (cycle with `s`)

1. `path_in_collection` — alphabetical (default)
2. `created_at` — newest first
3. `paths count` — most-linked first

### External previewer

Config key `preview-cmd` (optional). Resolution order:

1. `MDMD_PREVIEW_CMD` env var
2. `preview-cmd` config value
3. Auto-detect at startup: `glow` → `bat --language markdown` → `cat`

`Enter` launches the previewer as `$PREVIEW_CMD <absolute-path>`, suspending the TUI until the process exits. TUI resumes without re-running `refresh_index` (previewer is read-only).

### External editor

Uses standard `$EDITOR`. `o` launches `$EDITOR <absolute-path>`, suspending the TUI. TUI re-runs `refresh_index` on return (edit may have changed frontmatter).

### Implementation notes

- New oclif command: `src/commands/tui.ts`
- TUI app lives in `src/tui/` — React (`@opentui/react`) components
- Dependencies: `@opentui/react`, `@opentui/core`, `react`
- State: `useReducer` with a single top-level reducer (mode, filter, sort, selection, notes list, cursor)
- Data: `refreshIndex` → `openIndexDb` → query all managed notes with frontmatter; re-run on return from editor
- The `preview-cmd` key is added to `config.schema.json` and `SUPPORTED_CONFIG_KEYS`
- TUI respects terminal resize via `useTerminalDimensions`
- Never calls `process.exit()` — always `renderer.destroy()`
