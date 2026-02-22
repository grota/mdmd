# Agent Instructions for `mdmd`

## Build, test, and lint commands

- Install dependencies: `bun install` (from `README.md`).
- Build: `bun run build`  
  - Runs `shx rm -rf dist && tsc -b`.
- Test suite: `bun run test`  
  - Runs `mocha --forbid-only "test/**/*.test.ts"`.
- Single test file: `bunx mocha --forbid-only "test/path/to/file.test.ts"`.
- Single test by name: `bunx mocha --forbid-only "test/**/*.test.ts" --grep "test name"`.
- Lint: `bun run lint` (runs `eslint`).

## High-level architecture

- This repository is an **oclif CLI** on **Bun + TypeScript**.
- Runtime entrypoints are `bin/run.js` and `bin/dev.js`; both call `@oclif/core` `execute(...)`.
- Command implementations live under `src/commands/**`; command IDs come from the folder structure (for example `src/commands/hello/world.ts` -> `mdmd hello world`).
- Build output is `dist/**` (`tsconfig.json`: `rootDir: "src"`, `outDir: "dist"`), and oclif loads commands from `./dist/commands` (`package.json` `oclif.commands`).
- `SPEC.md` documents the intended product architecture beyond the current scaffold:
  - Canonical markdown collection (currently planned as an Obsidian vault path).
  - SQLite metadata index at `~/.cache/mdmd/index.db` (`index_notes` table with frontmatter stored as JSON).
  - Planned command flow centered on `ingest`, `sync`, and `remove`, with internal `refresh_index`.

## Key repository conventions

- ESM-first setup (`"type": "module"` in `package.json`) with Bun shebangs in CLI binaries.
- oclif command classes follow the static metadata pattern (`description`, `examples`, `args`, `flags`) and parse via `await this.parse(CommandClass)`.
- Test stack conventions are fixed in `package.json`: Mocha + Chai + `@oclif/test`, with test files expected at `test/**/*.test.ts`.
- Packaging scripts assume generated artifacts:
  - `prepack` runs `oclif manifest && oclif readme`.
  - `postpack` removes `oclif.manifest.json`.
  - `version` regenerates README via `oclif readme`.
