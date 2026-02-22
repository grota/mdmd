# Agent Instructions for `mdmd`

## Build, test, and lint commands

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
- `mdmd sync` is implemented in `src/commands/sync.ts` and reconciles `mdmd_notes/` symlinks from indexed managed notes (`frontmatter.path === cwd`).
- `mdmd remove` is implemented in `src/commands/remove.ts` with all-safety-checks-first semantics, plus `--dry-run` and `-i/--interactive`.
- `mdmd doctor` is implemented in `src/commands/doctor.ts` with read-only checks by default, optional `--fix`, and JSON/human reporting.
- `mdmd config` is implemented in `src/commands/config.ts` for `list/get/set/unset` of configuration keys.
- Internal `refresh_index` logic is implemented in `src/lib/refresh-index.ts` (not exposed as a standalone CLI command).
- Build output is `dist/**` (`tsconfig.json`: `rootDir: "src"`, `outDir: "dist"`), and oclif loads commands from `./dist/commands` (`package.json` `oclif.commands`).
- `SPEC.md` documents the intended product architecture beyond the current scaffold:
  - Canonical markdown collection (currently planned as an Obsidian vault path).
  - SQLite metadata index at `$XDG_DATA_HOME/mdmd/index.db` (fallback `~/.local/share/mdmd/index.db`) with `index_notes` table and frontmatter stored as JSON.
  - Planned command flow centered on `ingest`, `sync`, and `remove`, with internal `refresh_index`.

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
- Test stack conventions are fixed in `package.json`: Mocha + Chai + `@oclif/test`, with test files expected at `test/**/*.test.ts`.
- Packaging scripts assume generated artifacts:
  - `prepack` runs `oclif manifest && oclif readme`.
  - `postpack` removes `oclif.manifest.json`.
  - `version` regenerates README via `oclif readme`.
