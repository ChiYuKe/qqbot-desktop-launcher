import { openExternal } from './bot.js'

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const UNORDERED_LIST_RE = /^[-*+]\s+(.+)$/
const ORDERED_LIST_RE = /^\d+\.\s+(.+)$/
const TABLE_DIVIDER_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/
const INLINE_TOKEN_RE = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^\s)]+)\)/g

function isSafeExternalUrl(value) {
  return /^(https?:|mailto:)/i.test(value)
}

function renderInline(value, keyPrefix) {
  const text = String(value || '')
  const nodes = []
  const tokenRe = new RegExp(INLINE_TOKEN_RE.source, 'g')
  let cursor = 0
  let index = 0
  let match
  while ((match = tokenRe.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
    const key = `${keyPrefix}-${index++}`
    if (match[1] !== undefined) {
      nodes.push(<code key={key}>{match[1]}</code>)
    } else if (match[2] !== undefined) {
      nodes.push(<strong key={key}>{match[2]}</strong>)
    } else if (match[3] !== undefined) {
      nodes.push(<em key={key}>{match[3]}</em>)
    } else {
      const label = match[4]
      const url = match[5]
      nodes.push(isSafeExternalUrl(url)
        ? <a href={url} key={key} onClick={(event) => { event.preventDefault(); openExternal(url) }}>{renderInline(label, `${key}-label`)}</a>
        : <span key={key}>{label}</span>)
    }
    cursor = tokenRe.lastIndex
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

function isHorizontalRule(line) {
  return /^(?:\*\s*){3,}$|^(?:-\s*){3,}$|^(?:_\s*){3,}$/.test(line.trim())
}

function isBlockStart(lines, index) {
  const line = lines[index] || ''
  return line.startsWith('```') || HEADING_RE.test(line) || isHorizontalRule(line)
    || line.startsWith('>') || UNORDERED_LIST_RE.test(line) || ORDERED_LIST_RE.test(line)
    || (line.includes('|') && TABLE_DIVIDER_RE.test(lines[index + 1] || ''))
}

function renderBlocks(markdown, keyPrefix = 'block') {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let index = 0
  let blockIndex = 0

  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }

    if (line.startsWith('```')) {
      const language = line.slice(3).trim()
      const codeLines = []
      index += 1
      while (index < lines.length && !lines[index].startsWith('```')) {
        codeLines.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push(<pre key={`${keyPrefix}-${blockIndex++}`}><code className={language ? `language-${language}` : undefined}>{codeLines.join('\n')}</code></pre>)
      continue
    }

    const heading = line.match(HEADING_RE)
    if (heading) {
      const Tag = `h${heading[1].length}`
      blocks.push(<Tag key={`${keyPrefix}-${blockIndex++}`}>{renderInline(heading[2], `${keyPrefix}-heading-${blockIndex}`)}</Tag>)
      index += 1
      continue
    }

    if (isHorizontalRule(line)) {
      blocks.push(<hr key={`${keyPrefix}-${blockIndex++}`} />)
      index += 1
      continue
    }

    if (line.startsWith('>')) {
      const quoteLines = []
      while (index < lines.length && lines[index].startsWith('>')) {
        quoteLines.push(lines[index].replace(/^>\s?/, ''))
        index += 1
      }
      blocks.push(<blockquote key={`${keyPrefix}-${blockIndex++}`}>{renderBlocks(quoteLines.join('\n'), `${keyPrefix}-quote-${blockIndex}`)}</blockquote>)
      continue
    }

    if (line.includes('|') && TABLE_DIVIDER_RE.test(lines[index + 1] || '')) {
      const headers = splitTableRow(line)
      const rows = []
      index += 2
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(splitTableRow(lines[index]))
        index += 1
      }
      blocks.push(<div className="plugin-markdown-table-wrap" key={`${keyPrefix}-${blockIndex++}`}><table><thead><tr>{headers.map((header, column) => <th key={column}>{renderInline(header, `${keyPrefix}-th-${blockIndex}-${column}`)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, column) => <td key={column}>{renderInline(row[column] || '', `${keyPrefix}-td-${blockIndex}-${rowIndex}-${column}`)}</td>)}</tr>)}</tbody></table></div>)
      continue
    }

    const unordered = line.match(UNORDERED_LIST_RE)
    const ordered = line.match(ORDERED_LIST_RE)
    if (unordered || ordered) {
      const Tag = ordered ? 'ol' : 'ul'
      const items = []
      const itemPattern = ordered ? ORDERED_LIST_RE : UNORDERED_LIST_RE
      while (index < lines.length) {
        const item = lines[index].match(itemPattern)
        if (!item) break
        items.push(item[1])
        index += 1
      }
      blocks.push(<Tag key={`${keyPrefix}-${blockIndex++}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, `${keyPrefix}-li-${blockIndex}-${itemIndex}`)}</li>)}</Tag>)
      continue
    }

    const paragraph = [line]
    index += 1
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
      paragraph.push(lines[index])
      index += 1
    }
    blocks.push(<p key={`${keyPrefix}-${blockIndex++}`}>{paragraph.map((part, paragraphIndex) => <span key={paragraphIndex}>{paragraphIndex ? <br /> : null}{renderInline(part, `${keyPrefix}-p-${blockIndex}-${paragraphIndex}`)}</span>)}</p>)
  }

  return blocks
}

/** Render trusted plugin documentation without interpreting embedded HTML. */
export function MarkdownDocument({ markdown }) {
  return <div className="plugin-markdown">{renderBlocks(markdown)}</div>
}
