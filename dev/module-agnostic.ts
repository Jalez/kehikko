/**
 * The host names no module and no vendor (CLAUDE.md). This file holds WHICH
 * names count and HOW a name is found in a sentence, so the test that scans the
 * host's own sources (`test/module-agnostic-text.test.ts`) and the app's
 * release notes are judged by the same list.
 *
 * As a command it reads text (a file, or stdin) and fails on any line that
 * names a module or a vendor:
 *
 *   bun dev/module-agnostic.ts notes.md
 *   printf '%s\n' "$lines" | bun dev/module-agnostic.ts
 *
 * Kehikot's automatic app release (kehikko-desktop, `auto-release.yml`) runs it
 * over the release-note lines it collected from merged pull requests, with this
 * file as it is at the host commit being released.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

/** Agent vendors and their programs. Never a word in the host's own text. */
export const VENDORS = ['Claude', 'Codex', 'OpenAI', 'Anthropic', 'Gemini', 'Copilot']

/** Modules that are not on the official list but are known to exist; their names are no more the host's than the listed ones'. */
export const UNLISTED_MODULES = ['Flows', 'Screenplay', 'Journey']

/** The names of the modules in `modules.json`. */
export function officialNames(root = ROOT): string[] {
  const official = JSON.parse(readFileSync(join(root, 'modules.json'), 'utf8')) as { modules?: { name: string }[] } | { name: string }[]
  return (Array.isArray(official) ? official : (official.modules ?? [])).map((one) => one.name)
}

/** Every name the host's own words never say. */
export function namesOf(root = ROOT): string[] {
  return [...new Set([...officialNames(root), ...UNLISTED_MODULES, ...VENDORS])]
}

/** A name as a whole capitalised word: `Claude` in a sentence, never `kehikot.claude` or `~/.claude`. */
export const wordOf = (name: string) => new RegExp(`(?<![\\w.-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`)

/** The names one piece of text says. */
export function namesIn(text: string, names: readonly string[]): string[] {
  return names.filter((name) => wordOf(name).test(text))
}

if (import.meta.main) {
  const file = process.argv[2]
  const text = file && file !== '-' ? readFileSync(file, 'utf8') : await new Response(Bun.stdin.stream()).text()
  const names = namesOf()
  const found: string[] = []
  text.split('\n').forEach((line, i) => {
    for (const name of namesIn(line, names)) found.push(`${file && file !== '-' ? file : 'stdin'}:${i + 1}: "${name}" in ${JSON.stringify(line.trim())}`)
  })
  if (found.length) {
    console.error('The host names no module and no vendor (kehikko CLAUDE.md). Say "a module" or "an agent" instead:')
    for (const one of found) console.error(`  ${one}`)
    process.exit(1)
  }
  console.log(`No module or vendor name in ${text.split('\n').filter((line) => line.trim()).length} line(s).`)
}
