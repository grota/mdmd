# Agent Instructions for `mdmd`

## Prototype status — breaking changes welcome

**This is a prototype with no production users.** Breaking changes to the CLI interface, config format, frontmatter schema, index schema, and file layout are explicitly welcome. When implementing new features or refactoring:

- Do **not** add backward-compatibility shims or legacy code paths.
- Do **not** preserve deprecated behavior "just in case".
- Remove old code outright. Clean is better than compatible.

---

- Install dependencies: `bun install` (from `README.md`).
- Build: `bun run build`  
  - Runs `shx rm -rf dist && tsc -b`.
- Test suite: `bun run test`  
  - Runs `bun --bun mocha --forbid-only "test/**/*.test.ts"`.
- Single test file: `bun --bun mocha --forbid-only "test/path/to/file.test.ts"`.
- Single test by name: `bun --bun mocha --forbid-only "test/**/*.test.ts" --grep "test name"`.
- Lint: `bun run lint` (runs `eslint`).

`bun run test` runs lint as a `posttest` hook. Run the bare mocha command above when
you want fast iteration without lint.

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
---

## Code style

### TypeScript

- **strict mode** + `noFallthroughCasesInSwitch`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`. Fix all type errors; do not use `any` or `@ts-ignore`.
- Use `type` imports (`import type {Foo}`) for type-only imports (`verbatimModuleSyntax`).
- Prefer `const`; use `let` only when mutation is unavoidable.
- Use ternary chains or `const`-declared intermediate values instead of reassigned `let`
  where the linter's `prefer-destructuring` / `prefer-const` rules apply.
- Return types on exported functions are encouraged but not mandatory.
- `switch` statements are preferred over `if/else if` chains (`unicorn/prefer-switch`).

### Imports

- Import order: external packages first, then `node:` built-ins, then local modules.
- Use `node:` prefix for all Node/Bun built-ins: `node:fs/promises`, `node:path`, etc.
- Local imports use `.js` extension (ESM, bundler resolution): `import {foo} from '../lib/foo.js'`.
- Test files import from `../../src/...` without the `.js` extension (Bun resolves `.ts`).

### Naming conventions

- **Files**: `kebab-case.ts` for all source files.
- **Types / interfaces**: `PascalCase`.
- **Functions and variables**: `camelCase`.
- **Constants**: `SCREAMING_SNAKE_CASE` for module-level env var names and fixed string
  constants (e.g. `INDEX_DB_PATH_ENV_VAR`); `camelCase` for derived runtime values.
- **oclif command classes**: `PascalCase`, default export, extend `Command`.
- **SQLite column names**: `snake_case` in SQL; mapped to `camelCase` in TS at the
  query result boundary.

### Formatting

- Prettier via `@oclif/prettier-config`. Do not configure additional Prettier options.
- ESLint config: `eslint-config-oclif` + `eslint-config-prettier` + `.gitignore` ignore
  file. No additional ESLint rule overrides beyond what's in `eslint.config.mjs`.
- JSX: `@opentui/react` as `jsxImportSource` (set in `tsconfig.json`). TSX files in
  `src/tui/` only.
- Max function complexity is 20 (warning, not error); the main keyboard handler in
  `app.tsx` and the reducer in `types.ts` exceed this — that is pre-existing and accepted.

### Error handling

- In oclif commands, use `this.error(message, {exit: N})` to surface user-facing errors
  and exit with a non-zero code. Do not throw raw errors from `run()`.
- In lib modules, throw `new Error(message)` with descriptive messages. Callers (commands)
  are responsible for catching and presenting errors.
- In async flows, prefer `await`-based error propagation over `.catch()` chains, except
  when fire-and-forget is intentional (e.g. `reloadNotes().catch(() => {})`).
- Error type narrowing pattern: `error instanceof Error ? error.message : String(error)`.

### TUI (`src/tui/`)

- State lives entirely in `useReducer` (`types.ts`). Add new state fields there; do not
  use `useState` in `app.tsx` for app-level state.
- Add new action types to the `Action` union in `types.ts` with `| {type: 'NEW_ACTION'}`.
- All keyboard handling is in the single `useKeyboard` callback in `app.tsx`. Mode guards
  at the top (`help`, `filter`) must `return` early to prevent normal-mode keys from firing.
- Component props: favour explicit typed prop objects (`type FooProps = {...}`) over
  inline destructuring signatures.
- JSX prop ordering: alphabetical (`perfectionist/sort-jsx-props`).
- Focus is controlled via the `focusTarget: 'list' | 'preview' | 'filter'` state field,
  not by `mode` alone. Cycle order: `list → preview → filter → list` (Tab).

### Testing

- Test framework: Mocha + Chai (`expect` style). No Jest, no Vitest.
- Tests invoke the CLI as a subprocess via `spawnSync('bun', [cliEntrypoint, ...])` with
  isolated temp directories and the env override vars above.
- Each `it` block creates its own `tempRoot` via `mkdtemp`; `afterEach` removes it.
- Helper functions for filesystem assertions live at the bottom of each test file
  (`expectPathExists`, `expectPathMissing`, etc.) — replicate this pattern in new test files.
- Do not use `@oclif/test` wrappers; plain `spawnSync` subprocess tests are the convention.
- `--forbid-only` is always passed; do not use `.only` in committed tests.

