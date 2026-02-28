import {SyntaxStyle} from '@opentui/core'
import {useMemo} from 'react'

// Tokyo Night colour palette for Tree-sitter scopes
const TOKYO_NIGHT_THEME = [
  {scope: ['keyword', 'keyword.control', 'storage.type', 'storage.modifier'], style: {bold: true, foreground: '#bb9af7'}},
  {scope: ['string', 'string.quoted', 'string.template'], style: {foreground: '#9ece6a'}},
  {scope: ['comment', 'comment.line', 'comment.block'], style: {foreground: '#565f89', italic: true}},
  {scope: ['entity.name.function', 'support.function', 'meta.function-call'], style: {foreground: '#7aa2f7'}},
  {scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'], style: {foreground: '#2ac3de'}},
  {scope: ['constant.numeric', 'constant.language', 'constant.character'], style: {foreground: '#ff9e64'}},
  {scope: ['variable', 'variable.other'], style: {foreground: '#c0caf5'}},
  {scope: ['markup.heading', 'entity.name.section'], style: {bold: true, foreground: '#7aa2f7'}},
  {scope: ['markup.bold'], style: {bold: true}},
  {scope: ['markup.italic'], style: {italic: true}},
  {scope: ['markup.inline.raw', 'markup.fenced_code', 'markup.raw'], style: {foreground: '#9ece6a'}},
  {scope: ['markup.link', 'meta.link'], style: {foreground: '#7dcfff', underline: true}},
  {scope: ['punctuation', 'punctuation.definition'], style: {foreground: '#7aa2f7'}},
  {scope: ['operator', 'keyword.operator'], style: {foreground: '#89ddff'}},
]

// Wrap YAML frontmatter in a fenced code block so the markdown renderer
// shows the closing --- instead of consuming it as a frontmatter delimiter.
function preprocessForMarkdown(raw: string): string {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!match) return raw
  return `\`\`\`yaml\n${match[1]}\n\`\`\`\n${raw.slice(match[0].length)}`
}

type NotePreviewProps = {
  content: string
}

export function NotePreview({content}: NotePreviewProps) {
  const syntaxStyle = useMemo(() => SyntaxStyle.fromTheme(TOKYO_NIGHT_THEME), [])
  const processed = useMemo(() => preprocessForMarkdown(content || ' '), [content])
  return (
    <scrollbox border borderStyle="single" flexGrow={1}>
      <markdown content={processed} syntaxStyle={syntaxStyle} />
    </scrollbox>
  )
}
