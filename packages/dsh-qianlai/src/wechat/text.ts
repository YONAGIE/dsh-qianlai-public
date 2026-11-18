// A conservative message budget. Tables are paragraphs so records can stay together.
const MAX_WECHAT_CHARS = 1500

function inlineText(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`]+)`/g, '$1')
}

function tableCells(line: string): string[] | undefined {
  const text = line.trim()
  if (/^(?:#{1,6}|[-+*]|\d{1,9}[.)])\s|^>/.test(text)) return undefined
  const cells: string[] = []
  let start = 0
  // Match escaped backslashes as well as escaped pipes so `\\|` still splits the cells.
  for (const match of text.matchAll(/\\[\\|]|\|/g)) {
    if (match[0] !== '|') continue
    cells.push(text.slice(start, match.index))
    start = match.index + 1
  }
  if (!cells.length) return undefined
  cells.push(text.slice(start))
  if (cells[0] === '') cells.shift()
  if (cells.at(-1) === '') cells.pop()
  return cells.length ? cells.map(cell => cell.trim().replace(/\\([\\|])/g, '$1')) : undefined
}

/**
 * Use a record per paragraph for tables. ClawBot renders a subset of Markdown,
 * and plain paragraphs keep wide financial rows readable even in a narrow bubble.
 */
export function toWechatText(markdown: string): string {
  const source = markdown.split(/\r\n|\n|\r/)
  const output: string[] = []
  const separate = () => {
    if (output.length && output.at(-1) !== '') output.push('')
  }
  let fence: string | undefined
  for (let index = 0; index < source.length; index++) {
    const line = source[index]!
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      output.push(line)
      if (fenceMatch?.[1]?.startsWith(fence) && !fenceMatch[2]?.trim()) fence = undefined
      continue
    }
    if (fenceMatch) {
      fence = fenceMatch[1]
      output.push(line)
      continue
    }
    const headers = tableCells(line)
    const divider = headers && tableCells(source[index + 1] ?? '')
    if (headers && divider?.length === headers.length && divider.every(cell => /^:?-+:?$/.test(cell))) {
      const labels = headers.map(inlineText)
      separate()
      index += 2
      let hasRows = false
      for (; index < source.length; index++) {
        const cells = tableCells(source[index]!)
        if (!cells) break
        const fields = cells.map((cell, column) => {
          const value = inlineText(cell)
          const label = labels[column]
          return label && value ? `${label} ${value}` : value
        }).filter(Boolean)
        if (fields.length) {
          output.push('• ' + fields.join(' · '))
          separate()
          hasRows = true
        }
      }
      if (!hasRows) {
        output.push(labels.filter(Boolean).join(' · '))
        separate()
      }
      index--
      continue
    }
    const heading = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line)
    if (heading?.[1]) {
      separate()
      output.push(inlineText(heading[1]))
      separate()
    } else if (line.trim()) {
      output.push(inlineText(line))
    } else separate()
  }
  return output.join('\n').trim()
}

/** Split on paragraph boundaries first, then on line breaks within an oversized paragraph. */
export function splitForWechat(text: string, limit = MAX_WECHAT_CHARS): string[] {
  const chunks: string[] = []
  let current = ''
  for (const paragraph of text.split('\n\n')) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph
    if (next.length <= limit) {
      current = next
      continue
    }
    if (current) chunks.push(current)
    current = paragraph
    while (current.length > limit) {
      let end = current.lastIndexOf('\n', limit - 1) + 1 || limit
      // Keep a UTF-16 surrogate pair together when a line must be cut.
      if (end > 1 && (current.codePointAt(end - 1) ?? 0) > 0xffff) end--
      chunks.push(current.slice(0, end))
      current = current.slice(end)
    }
  }
  if (current) chunks.push(current)
  return chunks
}
