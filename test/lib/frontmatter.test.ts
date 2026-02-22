import {expect} from 'chai'

import {parseFrontmatter, stringifyFrontmatter} from '../../src/lib/frontmatter'

describe('frontmatter helpers', () => {
  it('parses YAML frontmatter and preserves markdown body', () => {
    const markdown = `---
title: Example
tags:
  - a
  - b
---
# Heading
`

    const parsed = parseFrontmatter(markdown)
    expect(parsed.frontmatter).to.deep.equal({tags: ['a', 'b'], title: 'Example'})
    expect(parsed.body).to.equal('# Heading\n')
  })

  it('returns empty frontmatter when no header is present', () => {
    const markdown = '# Heading\n\nBody\n'
    const parsed = parseFrontmatter(markdown)

    expect(parsed.frontmatter).to.deep.equal({})
    expect(parsed.body).to.equal(markdown)
  })

  it('roundtrips frontmatter and body through stringify', () => {
    const sourceBody = 'Hello world\n'
    const sourceFrontmatter = {'mdmd_id': '123', path: '/tmp/example'}
    const markdown = stringifyFrontmatter(sourceFrontmatter, sourceBody)
    const parsed = parseFrontmatter(markdown)

    expect(parsed.frontmatter).to.deep.equal(sourceFrontmatter)
    expect(parsed.body).to.equal(sourceBody)
  })
})
