/**
 * A small, safe subset of markdown, for release notes.
 *
 * Release notes come from GitHub, written by whoever can publish a release.
 * They are not a module's strings, but they are just as untrusted, so they are
 * read the same way: as TEXT. This turns them into a tree of plain values —
 * headings, list items, paragraphs, code blocks, and inside them text, bold,
 * italics, code spans and links — and `canvas/Markdown.tsx` draws that tree
 * with React elements whose children are strings. Nothing here, or there,
 * ever hands a string to the DOM as markup, so a `<script>` or an `<img
 * onerror>` in the notes is shown as the characters it is made of and does
 * nothing.
 *
 * Two allowances, both still text:
 *
 * - A link is a link only when its address is `https:`. Any other
 *   (`javascript:`, `data:`, `http:`, a relative path) is drawn as its words alone.
 * - A line that is wholly `<sub>…</sub>` — our releases end on
 *   `<sub>Built from …</sub>` — becomes a `small` block whose inside is read as
 *   markdown again. No other tag is recognised; the rest of any HTML stays
 *   literal text.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: Inline[] }

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'code'; text: string }
  | { kind: 'small'; children: Inline[] }
  | { kind: 'rule' }

/** Whether an address may be a link: `https:`, and nothing else. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim()
  if (!/^https:\/\//i.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

const SUB = /^<sub>([\s\S]*)<\/sub>$/i
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*\d{1,9}[.)]\s+(.*)$/
const FENCE = /^\s*(```|~~~)/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/

/** The blocks of a document. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join(' ')) })
    paragraph = []
  }
  const flushList = () => {
    if (list) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items.map(parseInline) })
    list = null
  }
  const flush = () => {
    flushParagraph()
    flushList()
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) code.push(lines[i++]!)
      blocks.push({ kind: 'code', text: code.join('\n') })
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    const sub = SUB.exec(line.trim())
    if (sub) {
      flush()
      blocks.push({ kind: 'small', children: parseInline(sub[1]!) })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6, children: parseInline(heading[2]!) })
      continue
    }
    if (RULE.test(line)) {
      flush()
      blocks.push({ kind: 'rule' })
      continue
    }
    const bullet = BULLET.exec(line)
    const numbered = bullet ? null : NUMBERED.exec(line)
    if (bullet || numbered) {
      flushParagraph()
      const ordered = numbered !== null
      if (list && list.ordered !== ordered) flushList()
      list ??= { ordered, items: [] }
      list.items.push((bullet ?? numbered)![1]!)
      continue
    }
    if (list && /^\s+\S/.test(line)) {
      /* A continuation of the last item. */
      list.items[list.items.length - 1] += ` ${line.trim()}`
      continue
    }
    flushList()
    paragraph.push(line.trim())
  }
  flush()
  return blocks
}

/** The inline pieces of one block's text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let plain = ''
  const push = (one: Inline) => {
    if (plain) out.push({ kind: 'text', text: plain })
    plain = ''
    out.push(one)
  }
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    const char = text[i]!
    if (char === '\\' && i + 1 < text.length && /[\\`*_[\]()#+\-.!<>]/.test(text[i + 1]!)) {
      plain += text[i + 1]
      i += 2
      continue
    }
    if (char === '`') {
      const run = /^`+/.exec(rest)![0]
      const end = text.indexOf(run, i + run.length)
      if (end > 0) {
        push({ kind: 'code', text: text.slice(i + run.length, end).trim() || text.slice(i + run.length, end) })
        i = end + run.length
        continue
      }
    }
    if ((char === '*' || char === '_') && text[i + 1] === char) {
      const mark = char + char
      const end = text.indexOf(mark, i + 2)
      if (end > i + 2) {
        push({ kind: 'strong', children: parseInline(text.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }
    if (char === '*' || (char === '_' && !/\w/.test(text[i - 1] ?? ''))) {
      const end = text.indexOf(char, i + 1)
      if (end > i + 1 && text[i + 1] !== ' ' && (char === '*' || !/\w/.test(text[end + 1] ?? ''))) {
        push({ kind: 'em', children: parseInline(text.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }
    if (char === '[') {
      const link = /^\[((?:[^\]\\]|\\.)*)\]\(\s*((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\s*\)/.exec(rest)
      if (link) {
        const href = safeHref(link[2]!)
        const children = parseInline(link[1]!)
        if (href) push({ kind: 'link', href, children })
        else for (const child of children) push(child)
        i += link[0].length
        continue
      }
    }
    if (char === '<') {
      const auto = /^<(https:\/\/[^>\s]+)>/.exec(rest)
      const href = auto ? safeHref(auto[1]!) : null
      if (auto && href) {
        push({ kind: 'link', href, children: [{ kind: 'text', text: auto[1]! }] })
        i += auto[0].length
        continue
      }
    }
    plain += char
    i++
  }
  if (plain) out.push({ kind: 'text', text: plain })
  return out
}

/** The words of a piece of the tree, for tests and for a label. */
export function plainText(nodes: readonly Inline[]): string {
  return nodes.map((one) => ('children' in one ? plainText(one.children) : one.text)).join('')
}

const FOOTER = /^<sub>[\s\S]*<\/sub>$/i
const WHATS_NEW = /^what[’']s new$/i

/** The body without trailing blank lines and `<sub>…</sub>` footer lines. */
function withoutFooter(lines: string[]): string[] {
  const out = [...lines]
  while (out.length) {
    const last = out[out.length - 1]!.trim()
    if (last === '' || FOOTER.test(last)) out.pop()
    else break
  }
  return out
}

/**
 * What the release-notes modal shows of a release body: the "What's new"
 * section (heading of any level, either apostrophe) up to the next heading of
 * the same or a higher level, without its own heading — the modal's title says
 * it — and without the `<sub>` footer. A body with no such heading, or whose
 * section is empty, is shown whole, minus a trailing `<sub>Built from …</sub>`.
 */
export function whatsNew(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const whole = withoutFooter(lines).join('\n').trim()
  let fence: string | null = null
  let start = -1
  let level = 0
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const f = FENCE.exec(line)
    if (f) {
      fence = fence === null ? f[1]! : fence === f[1] ? null : fence
      continue
    }
    if (fence) continue
    const h = HEADING.exec(line)
    if (!h) continue
    if (start < 0) {
      if (WHATS_NEW.test(h[2]!.trim())) {
        start = i
        level = h[1]!.length
      }
    } else if (h[1]!.length <= level) {
      end = i
      break
    }
  }
  if (start < 0) return whole
  const section = withoutFooter(lines.slice(start + 1, end)).join('\n').trim()
  return section || whole
}

/**
 * Whether a paragraph's text is wholly one of the sentences `worksWithSaid`
 * (`host/worksWith.ts`) writes: "Works with Kehikot 0.1.65 and later.", "Works
 * with Kehikot 0.1.15 to 0.1.21 (0.1.22 moved to protocol 2).", "Needs a Kehikot
 * newer than 0.1.41 (protocol 2.11 or later).". A dialog that draws that
 * sentence as its own label leaves it out of the body, where the release
 * workflow wrote it too. A whole paragraph only; a sentence inside other text
 * is never touched.
 */
export function isBuiltFrom(text: string): boolean {
  return /^Built from\b/i.test(text.trim())
}

export function isWorksWithSentence(text: string): boolean {
  return /^(Works with (Kehikot \d+\.\d+\.\d+( and later| to \d+\.\d+\.\d+ \(\d+\.\d+\.\d+ moved to protocol \d+\))|this Kehikot and later)|Needs a Kehikot newer than \d+\.\d+\.\d+ \(protocol [\d.]+ or later\))\.?$/.test(text.trim())
}

