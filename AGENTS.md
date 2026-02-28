# Agent Instructions for `mdmd`

## Prototype status — breaking changes welcome

**This is a prototype with no production users.** Breaking changes to the CLI interface, config format, frontmatter schema, index schema, and file layout are explicitly welcome. When implementing new features or refactoring:

- Do **not** add backward-compatibility shims or legacy code paths.
- Do **not** preserve deprecated behavior "just in case".
- Remove old code outright. Clean is better than compatible.


- Install dependencies: `bun install` (from `README.md`).
- Build: `bun run build`  
  - Runs `shx rm -rf dist && tsc -b`.
- Test suite: `bun run test`  
  - Runs `bun --bun mocha --forbid-only "test/**/*.test.ts"`.
- Single test file: `bun --bun mocha --forbid-only "test/path/to/file.test.ts"`.
- Single test by name: `bun --bun mocha --forbid-only "test/**/*.test.ts" --grep "test name"`.
- Lint: `bun run lint` (runs `eslint`).

## High-level architecture

- This repository is an **oclif CLI** on **Bun + TypeScript**.
- Runtime entrypoints are `bin/run.js` and `bin/dev.js`; both call `@oclif/core` `execute(...)`.
- Command implementations live under `src/commands/**`; command IDs come from the folder structure (for example `src/commands/hello/world.ts` -> `mdmd hello world`).
- `mdmd ingest` is implemented in `src/commands/ingest.ts`, with supporting modules under `src/lib/` for collection-path config resolution, YAML frontmatter handling, and SQLite index upsert.
- `mdmd sync` is implemented in `src/commands/sync.ts` and reconciles `<symlink-dir>/` symlinks from indexed managed notes (`paths` array contains cwd).
- `mdmd remove` is implemented in `src/commands/remove.ts` with all-safety-checks-first semantics, `--force` for multi-path notes, plus `--dry-run` and `-i/--interactive`.
- `mdmd link` is implemented in `src/commands/link.ts` — associates an existing collection note with cwd; idempotent.
- `mdmd unlink` is implemented in `src/commands/unlink.ts` — removes cwd from a note's `paths`, removes the symlink, keeps the collection file.
- `mdmd list` is implemented in `src/commands/list.ts` — lists notes for cwd (default) or `--collection-wide`.
- `mdmd doctor` is implemented in `src/commands/doctor.ts` with read-only checks by default, optional `--fix`, and JSON/human reporting.
- `mdmd config` is implemented in `src/commands/config.ts` for `list/get/set/unset` of configuration keys.
- Internal `refresh_index` logic is implemented in `src/lib/refresh-index.ts` (not exposed as a standalone CLI command).
- Build output is `dist/**` (`tsconfig.json`: `rootDir: "src"`, `outDir: "dist"`), and oclif loads commands from `./dist/commands` (`package.json` `oclif.commands`).
- `SPEC.md` documents the full intended product design:
  - Canonical markdown collection (Obsidian vault or any directory).
  - SQLite metadata index at `$XDG_DATA_HOME/mdmd/index.db` (fallback `~/.local/share/mdmd/index.db`).
  - Frontmatter is truth, index is cache. Every user-facing command runs `refresh_index` first.
  - `paths: string[]` associates a note with zero or more project directories.
  - Lifecycle: `ingest` (move + link), `link`, `unlink`, `sync`, `remove`, `list`, `doctor`.

## Key repository conventions

- ESM-first setup (`"type": "module"` in `package.json`) with Bun shebangs in CLI binaries.
- oclif command classes follow the static metadata pattern (`description`, `examples`, `args`, `flags`) and parse via `await this.parse(CommandClass)`.
- Runtime/config overrides currently used by implementation and tests:
  - `MDMD_COLLECTION_PATH` for collection root
  - `MDMD_CONFIG_PATH` for config file path override
  - `MDMD_OBSIDIAN_CONFIG_PATH` for Obsidian config path override
  - `MDMD_INDEX_DB_PATH` for SQLite index DB path override
- Config follows XDG defaults:
  - mdmd config: `$XDG_CONFIG_HOME/mdmd/config.yaml` (fallback `~/.config/mdmd/config.yaml`)
  - Obsidian fallback source: `$XDG_CONFIG_HOME/obsidian/obsidian.json` (fallback `~/.config/obsidian/obsidian.json`)
  - index db: `$XDG_DATA_HOME/mdmd/index.db` (fallback `~/.local/share/mdmd/index.db`)
- Config schema is defined in `config.schema.json` at the repo root. Valid keys: `collection`, `ingest-dest`, `symlink-dir`. Unknown keys cause a runtime error in `readMdmdConfig`. The schema can be referenced by yaml-language-server for editor autocomplete.
- Test stack conventions are fixed in `package.json`: Mocha + Chai + `@oclif/test`, with test files expected at `test/**/*.test.ts`.
- Packaging scripts assume generated artifacts:
  - `prepack` runs `oclif manifest && oclif readme`.
  - `postpack` removes `oclif.manifest.json`.
  - `version` regenerates README via `oclif readme`.
