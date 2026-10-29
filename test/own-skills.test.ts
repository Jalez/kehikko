import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { moduleSkillSchema, skillPath, skillTextIssue } from 'kehikot-module-protocol'

import { ensureSettings, writeSettings } from '../server/agentSettings.ts'
import { syncOnce, tidySkills, type ModuleSeen } from '../server/agentSync.ts'
import { HOST_ID } from '../server/kehikot.ts'
import { ownSkillAt, ownSkillDeclarations, withHost } from '../server/ownSkills.ts'
import { claudeSkillsDir, everywhereFor } from '../server/skills.ts'
import { DEFAULT_SETTINGS } from '../src/host/agentSettings.ts'
import { BUILD_A_MODULE_GUIDE, OWN_SKILLS, OWN_SKILLS_MODULE } from '../src/host/skills.ts'

/** Kehikot's own skills: declared and served by the host, kept by the same sync as a module's. */

const ORIGIN = 'http://127.0.0.1:4180'
const text = (name: string) => ownSkillAt(skillPath(name))!

/** A fetcher that answers as this host's own route does. */
const fromTheHost = (async (url: string) => {
  const said = ownSkillAt(new URL(url).pathname)
  return said === null ? new Response('no', { status: 404 }) : new Response(said)
}) as unknown as typeof fetch

const host = (): ModuleSeen => ({
  id: HOST_ID,
  name: 'Kehikot',
  answering: true,
  version: '0.1.0',
  door: null,
  refusal: null,
  origin: ORIGIN,
  skills: ownSkillDeclarations(),
})

function freshRoot(): string {
  const root = join(claudeSkillsDir(), `own-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  return root
}

describe('Kehikot’s own skills', () => {
  test('are filed under the host’s own id', () => {
    expect(OWN_SKILLS_MODULE).toBe(HOST_ID)
  })

  test('are declared as a module declares skills, with a version that is the text’s', () => {
    const declared = ownSkillDeclarations()
    expect(declared.map((one) => one.name)).toEqual(OWN_SKILLS.map((one) => one.name))
    for (const one of declared) {
      expect(moduleSkillSchema.safeParse(one).success).toBe(true)
      expect(one.version).toMatch(/^[0-9a-f]{12}$/)
    }
    expect(ownSkillDeclarations()).toEqual(declared)
  })

  test('are served at skillPath(name), as a text a host accepts, and nothing else is', () => {
    for (const one of OWN_SKILLS) expect(skillTextIssue(text(one.name), one.name)).toBeNull()
    expect(ownSkillAt('/kehikot/skills/nothing.md')).toBeNull()
    expect(ownSkillAt('/host/skills')).toBeNull()
  })

  test('/kehikot-module is the person’s to run, pre-approves only what it reads and checks, and follows the guide', () => {
    const skill = text('kehikot-module')
    const front = skill.split('---')[1]!
    expect(front).toContain('disable-model-invocation: true')
    const allowed = /allowed-tools: (.*)/.exec(front)![1]!.split(/,\s*/)
    expect(allowed.every((one) => /^Bash\((?:curl -fsSL https:\/\/raw\.githubusercontent\.com\/Jalez\/kehikko-protocol\/main\/docs\/building-a-module\.md|bun test|bun run (?:typecheck|check:door|check:parts))\)$/.test(one))).toBe(true)
    expect(skill).toContain('docs/building-a-module.md')
    expect(BUILD_A_MODULE_GUIDE).toContain('docs/building-a-module.md')
    for (const rule of ['Storage boundary', 'Header widths', 'Text-only labels', 'Page-only writes', 'Agents never press person-only items', "The Inbox's one record", 'Plain-language copy', 'Releases']) {
      expect(skill).toContain(`**${rule}`)
    }
    expect(skill).toContain('--template Jalez/kehikko-module-template')
    expect(skill).toContain('Install from repository…')
  })

  test('the Settings sync installs them like a module’s, and leaves one the person changed alone', async () => {
    const db = new Database(':memory:')
    ensureSettings(db)
    writeSettings(db, { ...DEFAULT_SETTINGS, asked: true })
    const root = freshRoot()
    const told: string[] = []
    const deps = { db, modules: async () => [host()], known: () => new Map(), skillsRoot: () => root, fetcher: fromTheHost, tell: (line: string) => told.push(line), trouble: () => {} }
    const ran = await syncOnce(deps)
    expect(ran.status.modules[0]!.skills).toEqual([
      { name: 'kehikot-module', state: 'installed' },
      { name: 'kehikko-jump', state: 'installed' },
    ])
    expect(readFileSync(join(root, 'kehikot-module', 'SKILL.md'), 'utf8')).toBe(text('kehikot-module'))
    expect(readFileSync(join(root, 'kehikko-jump', 'SKILL.md'), 'utf8')).toBe(text('kehikko-jump'))
    expect(told).toEqual(['Installed the /kehikot-module skill for your agent', 'Installed the /kehikko-jump skill for your agent'])
  })

  test('/kehikko-jump names the jump tool, pre-approves it and the read tools only, and says when to jump', () => {
    const skill = text('kehikko-jump')
    const front = skill.split('---')[1]!
    const allowed = /allowed-tools: (.*)/.exec(front)![1]!.split(/,\s*/)
    expect(allowed).toContain('mcp__kehikko__jump')
    expect(allowed.every((one) => /^mcp__kehikko__(jump|read_canvas|my_place|read_inbox)$/.test(one))).toBe(true)
    expect(skill).toContain('Go back')
    expect(skill).toContain('Resolve names first')
    expect(skill).toContain('Never otherwise')
    expect(skill).toContain('set_my_place')
  })

  test('are never tidied away as a gone module’s: the host is always in the registry the sync reads', async () => {
    const db = new Database(':memory:')
    ensureSettings(db)
    writeSettings(db, { ...DEFAULT_SETTINGS, asked: true })
    const root = freshRoot()
    await syncOnce({ db, modules: async () => [host()], known: () => new Map(), skillsRoot: () => root, fetcher: fromTheHost, tell: () => {}, trouble: () => {} })
    const registry = withHost(new Set(['kehikot.browser']))!
    expect(tidySkills(db, root, registry, () => {}).removed).toEqual([])
    expect(existsSync(join(root, 'kehikot-module', 'SKILL.md'))).toBe(true)
    expect(withHost(null)).toBeNull()
  })
})

/*
 * The host's own skills reach EVERY agent module that installs skills for its own agent (protocol
 * 2.23.0, `agentSessions.installsSkills`), by that declaration and no id: they are in the
 * `everywhere` a module is told at `POST /host/place` (`everywhereFor`). Stand-in ids, so no
 * program is named.
 */
describe('the host’s own skills, to any agent module that installs skills', () => {
  const seen = [
    { id: HOST_ID, origin: ORIGIN, skills: ownSkillDeclarations(), agent: false },
    { id: 'kehikot.someagent', origin: 'http://127.0.0.1:9101', skills: [{ name: 'someagent-here', summary: 'x', version: '1' }], agent: true },
    { id: 'kehikot.otheragent', origin: 'http://127.0.0.1:9102', skills: [{ name: 'otheragent-here', summary: 'x', version: '1' }], agent: true },
  ]

  test('each agent module is told every one of them, filed under the host, with the host’s origin', () => {
    for (const asker of ['kehikot.someagent', 'kehikot.otheragent']) {
      const told = everywhereFor(asker, seen, () => true)
      const own = told.filter((one) => one.module === HOST_ID)
      expect(own.map((one) => one.name)).toEqual(OWN_SKILLS.map((one) => one.name))
      expect(own.every((one) => one.origin === ORIGIN)).toBe(true)
      /* Its own skills are its agent's; another agent module's are written for that one. */
      expect(told.map((one) => one.name)).toContain(`${asker.slice('kehikot.'.length)}-here`)
      expect(told.some((one) => one.module !== HOST_ID && one.module !== asker)).toBe(false)
    }
  })

  test('not when the person keeps the host’s skills out of every conversation', () => {
    const told = everywhereFor('kehikot.someagent', seen, (module) => module !== HOST_ID)
    expect(told.some((one) => one.module === HOST_ID)).toBe(false)
  })
})
