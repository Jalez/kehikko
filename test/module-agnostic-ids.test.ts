import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import ts from 'typescript'

/**
 * The sibling of `module-agnostic-text.test.ts`, for CODE: the host decides nothing by a module's
 * id. What a module is to the host — that it opens files, holds live sessions, picks an event's
 * sound, installs skills for its agent, shows steps — it says in its manifest (protocol
 * declarations), and the host reads that. A suggested layout naming modules is data, in
 * `modules.json`, not code.
 *
 * What is scanned: every string literal and template part in `server/` and `src/` (tests and type
 * declarations aside). What counts: an official module's id from `modules.json`, or one of the
 * known modules that are not on it, in either spelling (`kehikot.<name>`, the pre-rename
 * `roadmap.<name>`). An extension name (`kehikot.notifications@1`) is not a module id and passes.
 * Comments are not scanned: one may say which module a fallback is for.
 *
 * The allowlist is exact: a file, the id, and why. Each entry is a compatibility fallback with the
 * condition for removing it, or a fact that is genuinely about one module's data; never a rule.
 */

const ROOT = join(import.meta.dir, '..')

const listed = JSON.parse(readFileSync(join(ROOT, 'modules.json'), 'utf8')) as { modules: { id: string }[] }
/** Known modules that are not on the official list; their ids are no more the host's than the listed ones'. */
const UNLISTED = ['kehikot.flows', 'kehikot.screenplay']
const TAILS = [...new Set([...listed.modules.map((one) => one.id), ...UNLISTED].map((id) => id.replace(/^kehikot\./, '')))]

const ALLOWED: readonly { file: RegExp; id: string; why: string }[] = [
  /* Compatibility, each removed when its condition is met (said at the code). */
  { file: /^src\/host\/autoUpdates\.ts$/, id: 'kehikot.terminal', why: 'HELD_SESSIONS_BEFORE_2_33: copies released before `holds` (protocol 2.33.0)' },
  { file: /^src\/host\/autoUpdates\.ts$/, id: 'kehikot.claude', why: 'HELD_SESSIONS_BEFORE_2_33: copies released before `holds` (protocol 2.33.0)' },
  { file: /^src\/host\/autoUpdates\.ts$/, id: 'kehikot.codex', why: 'HELD_SESSIONS_BEFORE_2_33: copies released before `holds` (protocol 2.33.0)' },
  { file: /^src\/host\/providers\.ts$/, id: 'kehikot.claude', why: 'SESSIONS_BEFORE_2_21: the agent module released before `agentSessions` (protocol 2.21.0)' },
  /* Examples in MCP tool descriptions: an id shaped as read_canvas prints one, for an agent to copy the shape. */
  { file: /^server\/mcp\.ts$/, id: 'kehikot.notes', why: 'an example id in a tool description' },
  { file: /^server\/mcp\.ts$/, id: 'kehikot.learning', why: 'an example id in a tool description' },
  { file: /^server\/mcp\.ts$/, id: 'kehikot.journeys', why: 'an example id in a tool description' },
  { file: /^server\/mcp\.ts$/, id: 'kehikot.paper', why: 'an example id in a tool description' },
  { file: /^server\/mcp\.ts$/, id: 'kehikot.factory', why: 'an example id in a tool description' },
]

function sources(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) out.push(path)
    }
  }
  for (const dir of ['server', 'src']) walk(dir)
  return out.sort()
}

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

const ID = new RegExp(`(?<![\\w.-])(?:kehikot|roadmap)\\.(${TAILS.map((one) => one.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w.@-])`, 'g')

/** Each official id a text names, in the spelling it has now. */
const idsIn = (text: string): string[] => [...text.matchAll(ID)].map((match) => `kehikot.${match[1]}`)

describe('the host decides nothing by a module’s id', () => {
  test('the ids are read from modules.json', () => {
    expect(TAILS.length).toBeGreaterThan(10)
    expect(TAILS).toContain('editor')
  })

  test('the matcher finds an id in either spelling, and leaves extensions, folders and longer ids alone', () => {
    expect(idsIn("const EDITOR_ID = 'kehikot.editor'")).toEqual(['kehikot.editor'])
    expect(idsIn('roadmap.terminal')).toEqual(['kehikot.terminal'])
    expect(idsIn('kehikot.notifications@1')).toEqual([])
    expect(idsIn('kehikot.editorial')).toEqual([])
    expect(idsIn('.kehikot.editor')).toEqual([])
  })

  test('no official module id in a string of the host’s code', () => {
    const found: string[] = []
    for (const file of sources()) {
      for (const { text, line } of textsOf(file)) {
        for (const id of idsIn(text)) {
          if (ALLOWED.some((one) => one.id === id && one.file.test(file))) continue
          found.push(`${file}:${line}: ${id} in ${JSON.stringify(text.length > 100 ? `${text.slice(0, 100)}…` : text)}`)
        }
      }
    }
    expect(found).toEqual([])
  })

  test('every allowlist entry is still needed', () => {
    const files = sources()
    for (const one of ALLOWED) {
      const used = files.filter((file) => one.file.test(file)).some((file) => textsOf(file).some(({ text }) => idsIn(text).includes(one.id)))
      expect({ entry: `${one.file} ${one.id}`, used }).toEqual({ entry: `${one.file} ${one.id}`, used: true })
    }
  })
})
