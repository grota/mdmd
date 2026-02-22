import {parse, stringify} from 'yaml'

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export type FrontmatterData = Record<string, unknown>

type ParsedFrontmatter = {
  body: string
  frontmatter: FrontmatterData
}

export function parseFrontmatter(contents: string): ParsedFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents)
  if (!match) {
    return {
      body: contents,
      frontmatter: {},
    }
  }

  const frontmatterBlock = match[1]?.trim()
  const body = contents.slice(match[0].length)

  if (!frontmatterBlock) {
    return {
      body,
      frontmatter: {},
    }
  }

  const parsed = parse(frontmatterBlock) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid frontmatter: expected a YAML object')
  }

  return {
    body,
    frontmatter: parsed as FrontmatterData,
  }
}

export function stringifyFrontmatter(frontmatter: FrontmatterData, body: string): string {
  const serialized = stringify(frontmatter).trimEnd()
  return `---\n${serialized}\n---\n${body}`
}
