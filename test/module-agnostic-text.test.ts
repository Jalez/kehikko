import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import ts from 'typescript'

/**
 * The app is module agnostic and vendor agnostic: the host's own words — what
 * a person reads and what an agent is told — never name a specific module or
 * an agent vendor. Modules come and go, and there will be agent modules from
 * more vendors than today's. CLAUDE.md says it ("The host names no module and
 * no vendor"); this is what keeps it said.
 *
 * What is scanned: every string literal, template and JSX text in the host's
 * person- and agent-facing sources — the MCP door (its instructions and every
 * tool description), the skills the host ships, the intro and the tour,
 * settings, the canvas, and every sentence in `src/host/*` and `server/*` —
 * plus the full text of `skills/*\/SKILL.md`. Comments are not scanned (a
 * comment may document why code handles one module, such as the Journeys
 * fallback in `server/plans.ts`); they are kept generic by review.
 *
 * What counts: an official module's name from `modules.json`, a few more
 * module names that are not on that list, and the vendor names below, as a
 * whole capitalised word. Lowercase ids (`kehikot.claude`, `~/.claude`,
 * `claude mcp add`) are code, not words, and pass. A module's name read from
 * data (a registration, `modules.json`, a manifest) is never in the source and
 * passes too: that is how the host says a module's name.
 *
 * The allowlist is exact: a file, the word, and why. A new entry needs a reason
 * a reviewer would accept; "the module does it" is not one — say "a module".
 */

const ROOT = join(import.meta.dir, '..')

/** Agent vendors and their programs. Never a word in the host's own text. */
const VENDORS = ['Claude', 'Codex', 'OpenAI', 'Anthropic', 'Gemini', 'Copilot']

/** Modules that are not on the official list but are known to exist; their names are no more the host's than the listed ones'. */
const UNLISTED_MODULES = ['Flows', 'Screenplay', 'Journey']

const official = (JSON.parse(readFileSync(join(ROOT, 'modules.json'), 'utf8')) as { modules?: { name: string }[] } | { name: string }[])
const officialNames = (Array.isArray(official) ? official : (official.modules ?? [])).map((one) => one.name)

const NAMES = [...new Set([...officialNames, ...UNLISTED_MODULES, ...VENDORS])]

/**
 * Words that are a module's name and also an ordinary word the host uses for
 * itself. Matched per file, with the reason. Everything not here fails.
 */
const ALLOWED: readonly { file: RegExp; word: string; why: string }[] = [
  /* Data that names a program, read where a person needs to know which one; never a sentence. */
  { file: /^src\/host\/agentSettings\.ts$/, word: 'Claude', why: 'PROVIDERS: the one place Settings says which agent program is set up' },
  { file: /^server\/callers\.ts$/, word: 'Claude', why: 'AGENTS: how the traffic monitor names a running executable, as it names curl' },
  { file: /^server\/callers\.ts$/, word: 'Codex', why: 'AGENTS: how the traffic monitor names a running executable, as it names curl' },
  { file: /^src\/canvas\/brandMarks\.ts$/, word: 'Claude', why: 'the title of a trademark icon a module names as its own (`brand:claude`)' },
  /* The built-in layouts are named for ways of working; two share a word with a module. */
  { file: /^src\/host\/layouts\.ts$/, word: 'Review', why: 'the layout called Review, a way of working' },
  { file: /^src\/host\/layouts\.ts$/, word: 'Learning', why: 'the layout called Learning, a way of working' },
  { file: /^src\/host\/tour\.ts$/, word: 'Review', why: 'names the Review and Learning layouts' },
  { file: /^src\/host\/tour\.ts$/, word: 'Learning', why: 'names the Review and Learning layouts' },
]

/** Sources whose words a person or an agent reads. Tests, fixtures and the module list are not scanned. */
function sources(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) out.push(path)
    }
  }
  for (const dir of ['server', 'src/host', 'src/canvas']) walk(dir)
  out.push('src/App.tsx')
  return out.sort()
}

/** Every piece of text in a source file: string literals, template parts and JSX text. Imports are skipped. */
function textsOf(file: string): { text: string; line: number }[] {
  const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: { text: string; line: number }[] = []
  const add = (node: ts.Node, text: string) => out.push({ text, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 })
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text)
    else if (ts.isTemplateExpression(node)) {
      add(node.head, node.head.text)
      for (const span of node.templateSpans) add(span.literal, span.literal.text)
    } else if (ts.isJsxText(node)) add(node, node.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

const wordOf = (name: string) => new RegExp(`(?<![\\w.-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`)

function slips(file: string, texts: { text: string; line: number }[]): string[] {
  const found: string[] = []
  for (const { text, line } of texts) {
    for (const name of NAMES) {
      if (!wordOf(name).test(text)) continue
      if (ALLOWED.some((one) => one.word === name && one.file.test(file))) continue
      found.push(`${file}:${line}: "${name}" in ${JSON.stringify(text.length > 120 ? text.slice(0, 120) + '…' : text)}`)
    }
  }
  return found
}

describe('the host names no module and no vendor', () => {
  test('the list of names is read from modules.json', () => {
    expect(officialNames.length).toBeGreaterThan(10)
    expect(NAMES).toContain('Claude')
    expect(NAMES).toContain('Test runs')
  })

  test('the matcher finds a name as a word, and leaves ids and paths alone', () => {
    expect(wordOf('Claude').test('Put Claude on a kehikko')).toBe(true)
    expect(wordOf('Claude').test('kehikot.claude')).toBe(false)
    expect(wordOf('Claude').test('~/.claude/skills')).toBe(false)
    expect(wordOf('Test runs').test('Test runs belong to this computer')).toBe(true)
  })

  test('no string, template or JSX text in the host sources', () => {
    const found = sources().flatMap((file) => slips(file, textsOf(file)))
    expect(found).toEqual([])
  })

  test('no skill the host ships', () => {
    const found: string[] = []
    for (const name of readdirSync(join(ROOT, 'skills'))) {
      const file = join('skills', name, 'SKILL.md')
      const lines = readFileSync(join(ROOT, file), 'utf8').split('\n').map((text, i) => ({ text, line: i + 1 }))
      found.push(...slips(relative(ROOT, join(ROOT, file)), lines))
    }
    expect(found).toEqual([])
  })

  test('every allowlist entry is still needed', () => {
    const files = sources()
    for (const one of ALLOWED) {
      const used = files.filter((file) => one.file.test(file)).some((file) => textsOf(file).some(({ text }) => wordOf(one.word).test(text)))
      expect({ entry: `${one.file} ${one.word}`, used }).toEqual({ entry: `${one.file} ${one.word}`, used: true })
    }
  })
})
