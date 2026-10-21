import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/*
 * Only `server/projectRoot.ts` makes folders under a project.
 *
 * A project's folder is made again by exactly one kind of call: one that makes
 * folders (`mkdirSync(…, { recursive: true })`, `cpSync`, `fs/promises`'
 * `mkdir`) with a path under a root that is gone. A write of a file cannot — it
 * fails when its folder is not there. So every call of that kind in the
 * server is either `makeUnderRoot` (which never makes the root and refuses a
 * ghost) or one of the machine-level writers below, each with where it writes.
 * A new one fails here until it goes through `makeUnderRoot` or is listed.
 */

const SERVER = join(import.meta.dir, '..', 'server')
const MAKES_FOLDERS = /\b(?:mkdirSync|cpSync|mkdir|mkdirp|ensureDir)\s*\(/

/** `file: the line's code` → where it writes, which is never a project. */
const MACHINE_LEVEL: Record<string, string> = {
  'formerName.ts: mkdirSync(dirname(dest), { recursive: true })': 'the module registry (writeLike, registrations)',
  'formerName.ts: cpSync(before, tmp, { recursive: true, force: true })':
    'a temporary folder inside .kehikot/host/, made by makeUnderRoot on the line above',
  'versionRuns.ts: mkdirSync(home, { recursive: true })': 'the versions directory',
  'versionRuns.ts: mkdirSync(join(this.#root, id), { recursive: true })': 'the versions directory',
  'moduleLog.ts: mkdirSync(dirname(file), { recursive: true })': 'the logs directory',
  'installs.ts: mkdirSync(deps.root, { recursive: true })': 'the installed-modules directory',
  'installs.ts: mkdirSync(deps.registry, { recursive: true })': 'the module registry',
  "canvases.ts: if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })": 'frame.sqlite',
  'officialSource.ts: mkdirSync(dirname(deps.cache), { recursive: true })': 'the official list cache',
  'appProtocols.ts: mkdirSync(dirname(deps.cache), { recursive: true })': 'the app version → protocol cache',
  'myModules.ts: mkdirSync(dirname(file), { recursive: true })': 'the My modules list, in the machine directory',
  'server.ts: mkdirSync(registry, { recursive: true })': 'the module registry',
  'skills.ts: mkdirSync(root, { recursive: true })': "Claude Code's skills directory (~/.claude/skills)",
  'skills.ts: mkdirSync(tmp)': "a temporary folder inside Claude Code's skills directory",
}

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(path))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(path)
  }
  return out
}

describe('folders under a project', () => {
  test('are made only by makeUnderRoot, or by a listed machine-level writer', () => {
    const found: string[] = []
    for (const file of sources(SERVER)) {
      const name = relative(SERVER, file)
      if (name === 'projectRoot.ts') continue
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const code = line.trim()
        if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) continue
        if (MAKES_FOLDERS.test(code)) found.push(`${name}: ${code}`)
      }
    }
    expect(found.filter((one) => !(one in MACHINE_LEVEL))).toEqual([])
    /* And the list holds nothing that is no longer there. */
    expect(Object.keys(MACHINE_LEVEL).filter((one) => !found.includes(one))).toEqual([])
  })
})
