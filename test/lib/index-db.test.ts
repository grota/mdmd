import {Database} from 'bun:sqlite'
import {expect} from 'chai'
import {mkdir, mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'

import {getIndexDbPath, INDEX_DB_PATH_ENV_VAR, openIndexDb, XDG_DATA_HOME_ENV_VAR} from '../../src/lib/index-db'

describe('index db path resolution', () => {
  const originalHome = process.env.HOME
  const originalIndexDbPath = process.env[INDEX_DB_PATH_ENV_VAR]
  const originalXdgDataHome = process.env[XDG_DATA_HOME_ENV_VAR]

  let tempRoot = ''

  afterEach(async () => {
    process.env.HOME = originalHome
    restoreEnv(INDEX_DB_PATH_ENV_VAR, originalIndexDbPath)
    restoreEnv(XDG_DATA_HOME_ENV_VAR, originalXdgDataHome)

    if (tempRoot) {
      await rm(tempRoot, {force: true, recursive: true})
      tempRoot = ''
    }
  })

  it('uses XDG_DATA_HOME for default index location', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-indexdb-test-'))
    process.env.HOME = path.join(tempRoot, 'home')
    process.env[XDG_DATA_HOME_ENV_VAR] = path.join(tempRoot, 'xdg-data')
    delete process.env[INDEX_DB_PATH_ENV_VAR]

    const resolved = getIndexDbPath()
    expect(resolved).to.equal(path.join(tempRoot, 'xdg-data', 'mdmd', 'index.db'))
  })

  it('does not migrate from legacy cache path automatically', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-indexdb-test-'))
    const homeDir = path.join(tempRoot, 'home')
    const xdgDataHome = path.join(tempRoot, 'xdg-data')
    const xdgCacheHome = path.join(homeDir, '.cache')
    process.env.HOME = homeDir
    process.env[XDG_DATA_HOME_ENV_VAR] = xdgDataHome
    delete process.env[INDEX_DB_PATH_ENV_VAR]

    const legacyDbPath = path.join(xdgCacheHome, 'mdmd', 'index.db')
    await mkdir(path.dirname(legacyDbPath), {recursive: true})

    const legacyDb = new Database(legacyDbPath)
    legacyDb.exec(`
      CREATE TABLE index_notes (
        path_in_collection TEXT NOT NULL PRIMARY KEY,
        mdmd_id TEXT,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        frontmatter TEXT
      );
    `)
    legacyDb.query(`
      INSERT INTO index_notes (path_in_collection, mdmd_id, mtime, size, frontmatter)
      VALUES ('legacy.md', NULL, 1, 1, '{}');
    `).run()
    legacyDb.close()

    const db = openIndexDb()
    const row = db.query(`
      SELECT COUNT(*) AS count
      FROM index_notes
      WHERE path_in_collection = 'legacy.md';
    `).get() as {count: number}
    db.close()

    expect(row.count).to.equal(0)
    expect(getIndexDbPath()).to.equal(path.join(xdgDataHome, 'mdmd', 'index.db'))
  })
})

function restoreEnv(key: string, originalValue: string | undefined): void {
  if (originalValue === undefined) {
    delete process.env[key]
    return
  }

  process.env[key] = originalValue
}
