import {expect} from 'chai'
import {mkdir, mkdtemp, rm, unlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'

import {INDEX_DB_PATH_ENV_VAR, openIndexDb} from '../../src/lib/index-db'
import {refreshIndex} from '../../src/lib/refresh-index'

describe('refreshIndex', () => {
  const originalHome = process.env.HOME
  const originalIndexDbPath = process.env[INDEX_DB_PATH_ENV_VAR]
  let tempRoot = ''

  afterEach(async () => {
    process.env.HOME = originalHome
    if (originalIndexDbPath === undefined) {
      delete process.env[INDEX_DB_PATH_ENV_VAR]
    } else {
      process.env[INDEX_DB_PATH_ENV_VAR] = originalIndexDbPath
    }

    if (tempRoot) {
      await rm(tempRoot, {force: true, recursive: true})
      tempRoot = ''
    }
  })

  it('indexes new files, skips unchanged files, and removes deleted files', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-refresh-test-'))
    const collectionRoot = path.join(tempRoot, 'collection')
    const nestedDir = path.join(collectionRoot, 'sub')
    const tempHome = path.join(tempRoot, 'home')
    const indexDbPath = path.join(tempRoot, 'index.db')

    await mkdir(nestedDir, {recursive: true})
    await mkdir(tempHome, {recursive: true})
    process.env.HOME = tempHome
    process.env[INDEX_DB_PATH_ENV_VAR] = indexDbPath

    await writeFile(
      path.join(nestedDir, 'one.md'),
      `---
mdmd_id: 11111111-1111-4111-8111-111111111111
path: /tmp/project
---
# one
`,
      'utf8',
    )
    await writeFile(path.join(collectionRoot, 'two.md'), '# two\n', 'utf8')

    const firstRun = await refreshIndex(collectionRoot)
    expect(firstRun).to.deep.equal({deleted: 0, refreshed: 2, scanned: 2, unchanged: 0})

    const db = openIndexDb()
    const rows = db.query(`
      SELECT path_in_collection AS pathInCollection, mdmd_id AS mdmdId
      FROM index_notes
      ORDER BY path_in_collection ASC
    `).all() as Array<{mdmdId: null | string; pathInCollection: string}>
    db.close()

    expect(rows).to.deep.equal([
      {mdmdId: '11111111-1111-4111-8111-111111111111', pathInCollection: 'sub/one.md'},
      {mdmdId: null, pathInCollection: 'two.md'},
    ])

    const secondRun = await refreshIndex(collectionRoot)
    expect(secondRun).to.deep.equal({deleted: 0, refreshed: 0, scanned: 2, unchanged: 2})

    await writeFile(path.join(nestedDir, 'one.md'), '# changed and bigger\n', 'utf8')
    const thirdRun = await refreshIndex(collectionRoot)
    expect(thirdRun.refreshed).to.equal(1)
    expect(thirdRun.deleted).to.equal(0)

    await unlink(path.join(collectionRoot, 'two.md'))
    const fourthRun = await refreshIndex(collectionRoot)
    expect(fourthRun.deleted).to.equal(1)
    expect(fourthRun.scanned).to.equal(1)
  })

  it('isolates index rows by collection root', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mdmd-refresh-test-'))
    const collectionA = path.join(tempRoot, 'collection-a')
    const collectionB = path.join(tempRoot, 'collection-b')
    const tempHome = path.join(tempRoot, 'home')
    const indexDbPath = path.join(tempRoot, 'index.db')
    const sharedMdmdId = '33333333-3333-4333-8333-333333333333'

    await mkdir(collectionA, {recursive: true})
    await mkdir(collectionB, {recursive: true})
    await mkdir(tempHome, {recursive: true})
    process.env.HOME = tempHome
    process.env[INDEX_DB_PATH_ENV_VAR] = indexDbPath

    await writeFile(
      path.join(collectionA, 'shared.md'),
      `---
mdmd_id: ${sharedMdmdId}
path: /tmp/a
---
# a
`,
      'utf8',
    )
    await writeFile(
      path.join(collectionB, 'shared.md'),
      `---
mdmd_id: ${sharedMdmdId}
path: /tmp/b
---
# b
`,
      'utf8',
    )

    await refreshIndex(collectionA)
    await refreshIndex(collectionB)

    const db = openIndexDb()
    const rows = db.query(`
      SELECT c.root AS root, n.path_in_collection AS pathInCollection, n.mdmd_id AS mdmdId
      FROM index_notes n
      INNER JOIN collections c ON c.collection_id = n.collection_id
      ORDER BY c.root ASC
    `).all() as Array<{mdmdId: string; pathInCollection: string; root: string}>
    db.close()

    expect(rows).to.deep.equal([
      {mdmdId: sharedMdmdId, pathInCollection: 'shared.md', root: path.resolve(collectionA)},
      {mdmdId: sharedMdmdId, pathInCollection: 'shared.md', root: path.resolve(collectionB)},
    ])
  })
})
