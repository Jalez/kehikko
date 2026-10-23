import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { skillPath, type ModuleSkill } from 'kehikot-module-protocol'

import { readKeepRunning } from '../server/keepRunning.ts'
import { claudeSettingsFile, ensureSettings, madeEntries, readSettings, recordMade, settingsRoute, startHook, writeSettings } from '../server/agentSettings.ts'
import { AgentSync, fingerprintOf, settingsInbox, syncOnce, tidySkills, type ModuleSeen, type SyncDeps } from '../server/agentSync.ts'
import { open } from '../server/canvases.ts'
import { PAGE_ONLY, refusal, type Own } from '../server/guard.ts'
import { Inbox } from '../server/inbox.ts'
import { addProject } from '../server/projects.ts'
import type { Runner } from '../server/register.ts'
import { claudeSkillsDir, isMachineRegistry, MARKER, sha256, thisRegistry } from '../server/skills.ts'
import {
  DEFAULT_SETTINGS,
  SETTINGS_INBOX_MODULE,
  settingsPatched,
  skillsSaid,
  SYNC_TROUBLE_ID,
  toolSays,
  toolsSaid,
  type AgentSettings,
} from '../src/host/agentSettings.ts'

/**
 * The app-wide agent settings and the sync that keeps every module's tools and
 * skills set up. The `claude` command is a fake that edits an in-memory MCP
 * list; skills go under the suite's scratch CLAUDE_CONFIG.
 */

const ON: AgentSettings = { ...DEFAULT_SETTINGS, asked: true }

/** A fake `claude mcp add|remove` over a map, recording every call. */
function fakeClaude(start: Record<string, { url: string }> = {}) {
  const known = new Map<string, unknown>(Object.entries(start).map(([name, value]) => [name, { type: 'http', ...value }]))
  const calls: string[][] = []
  let running = 0
  let overlapped = false
  const run: Runner = async (args) => {
    calls.push(args)
    running += 1
    if (running > 1) overlapped = true
    await Promise.resolve()
    running -= 1
    if (args[1] === 'add') {
      const name = args[6]!
      if (known.has(name)) return { ok: false, said: `MCP server ${name} already exists` }
      known.set(name, { type: args[5], url: args[7] })
      return { ok: true, said: `Added ${name}` }
    }
    if (args[1] === 'remove') {
      const name = args[2]!
      if (!known.delete(name)) return { ok: false, said: `No MCP server named ${name}` }
      return { ok: true, said: `Removed ${name}` }
    }
    return { ok: false, said: 'unknown' }
  }
  return { known, calls, run, overlapped: () => overlapped }
}

const door = (id: string, port: number) => ({ module: id, as: id.split('.').pop()!, url: `http://127.0.0.1:${port}/mcp`, transport: 'http' })

function mod(id: string, port: number, more: Partial<ModuleSeen> = {}): ModuleSeen {
  return {
    id,
    name: id.split('.').pop()!.replace(/^./, (c) => c.toUpperCase()),
    answering: true,
    version: '1.0.0',
    door: door(id, port),
    refusal: null,
    origin: `http://127.0.0.1:${port}`,
    skills: [],
    ...more,
  }
}

const skillText = (name: string, body = 'Do the thing.') => `---\nname: ${name}\ndescription: A skill.\n---\n\n${body}\n`
const skill = (name: string, version = '1'): ModuleSkill => ({ name, summary: `About ${name}.`, version })

function serving(table: Record<string, string>) {
  return (async (url: string) => {
    const path = new URL(url).pathname
    const name = Object.keys(table).find((one) => skillPath(one) === path)
    return name === undefined ? new Response('no', { status: 404 }) : new Response(table[name], { status: 200 })
  }) as unknown as typeof fetch
}

function freshRoot(): string {
  const root = join(claudeSkillsDir(), `sync-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  return root
}

function setup(seen: ModuleSeen[], settings: AgentSettings = ON, claude = fakeClaude(), table: Record<string, string> = {}) {
  const db = new Database(':memory:')
  ensureSettings(db)
  writeSettings(db, settings)
  const told: string[] = []
  const troubles: string[][] = []
  const root = freshRoot()
  const state = { seen }
  const deps: SyncDeps = {
    db,
    modules: async () => state.seen,
    known: () => claude.known,
    run: claude.run,
    skillsRoot: () => root,
    fetcher: serving(table),
    tell: (line) => told.push(line),
    trouble: (problems) => troubles.push(problems),
  }
  return { db, deps, told, troubles, root, claude, state, table }
}

describe('tools, kept connected', () => {
  test('nothing happens before the one-time question is answered', async () => {
    const at = setup([mod('kehikot.browser', 7801)], DEFAULT_SETTINGS)
    const ran = await syncOnce(at.deps)
    expect(at.claude.calls).toEqual([])
    expect(at.told).toEqual([])
    expect(ran.status.modules.find((one) => one.id === 'kehikot.browser')?.tools).toBe('missing')
  })

  test('nothing happens with the toggle off, or with Claude Code switched off', async () => {
    for (const settings of [
      { ...ON, tools: { auto: false, except: [] } },
      { ...ON, providers: { claudeCode: { enabled: false } } },
    ]) {
      const at = setup([mod('kehikot.browser', 7801)], settings)
      await syncOnce(at.deps)
      expect(at.claude.calls).toEqual([])
    }
  })

  test('connects every answering module with a door, at user scope, one Inbox line each, and records it as Kehikot’s', async () => {
    const at = setup([mod('kehikot.browser', 7801), mod('kehikot.notes', 7802), mod('kehikot.plain', 7803, { door: null }), mod('kehikot.asleep', 7804, { answering: false, door: null })])
    const ran = await syncOnce(at.deps)
    expect(at.claude.calls).toEqual([
      ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'browser', 'http://127.0.0.1:7801/mcp'],
      ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'notes', 'http://127.0.0.1:7802/mcp'],
    ])
    expect(at.told).toEqual(['Connected Browser’s tools for Claude Code', 'Connected Notes’s tools for Claude Code'])
    expect(madeEntries(at.db).map((one) => one.module)).toEqual(['kehikot.browser', 'kehikot.notes'])
    expect(ran.status.modules.map((one) => one.tools)).toEqual(['connected', 'connected', null, 'asleep'])
    expect(toolsSaid(ran.status)).toBe('2 connected, 1 not running')
    expect(ran.transient).toBe(false)

    /* A second run changes nothing and says nothing. */
    at.told.length = 0
    await syncOnce(at.deps)
    expect(at.claude.calls).toHaveLength(2)
    expect(at.told).toEqual([])
  })

  test('honours exceptions', async () => {
    const at = setup([mod('kehikot.browser', 7801), mod('kehikot.notes', 7802)], { ...ON, tools: { auto: true, except: ['kehikot.notes'] } })
    const ran = await syncOnce(at.deps)
    expect(at.claude.calls.map((args) => args[6])).toEqual(['browser'])
    expect(ran.status.modules.map((one) => one.tools)).toEqual(['connected', 'excepted'])
    expect(toolsSaid(ran.status)).toBe('1 connected, 1 left to you')
  })

  test('re-points an entry Kehikot made when the door moved', async () => {
    const at = setup([mod('kehikot.browser', 7811)], ON, fakeClaude({ browser: { url: 'http://127.0.0.1:7801/mcp' } }))
    recordMade(at.db, { module: 'kehikot.browser', name: 'browser', url: 'http://127.0.0.1:7801/mcp', title: 'Browser' })
    await syncOnce(at.deps)
    expect(at.claude.calls).toEqual([
      ['mcp', 'remove', 'browser'],
      ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'browser', 'http://127.0.0.1:7811/mcp'],
    ])
    expect(at.told).toEqual(['Re-pointed Browser’s tools for Claude Code to its new address'])
    expect(madeEntries(at.db)[0]!.url).toBe('http://127.0.0.1:7811/mcp')
  })

  test('never touches an entry it did not make: a taken name is a quiet problem, not a press', async () => {
    const at = setup([mod('kehikot.browser', 7801)], ON, fakeClaude({ browser: { url: 'https://example.org/mcp' } }))
    const ran = await syncOnce(at.deps)
    expect(at.claude.calls).toEqual([])
    expect(ran.status.modules[0]!.tools).toBe('conflict')
    expect(at.troubles.at(-1)![0]).toContain('Kehikot did not add it')
  })

  test('adopts an entry already pointing at a door, then follows it when the door moves', async () => {
    const at = setup([mod('kehikot.browser', 7801)], ON, fakeClaude({ mine: { url: 'http://127.0.0.1:7801/mcp' } }))
    await syncOnce(at.deps)
    expect(at.claude.calls).toEqual([])
    expect(madeEntries(at.db)).toEqual([{ module: 'kehikot.browser', name: 'mine', url: 'http://127.0.0.1:7801/mcp', title: 'Browser' }])
    at.state.seen = [mod('kehikot.browser', 7821)]
    await syncOnce(at.deps)
    expect(at.claude.calls.map((args) => args.slice(0, 3))).toEqual([['mcp', 'remove', 'mine'], ['mcp', 'add', '--scope']])
    expect([...at.claude.known.keys()]).toEqual(['browser'])
  })

  test('removes an uninstalled module’s entry only when Kehikot made it and it still points where it was made to', async () => {
    const claude = fakeClaude({
      gone: { url: 'http://127.0.0.1:7850/mcp' },
      moved: { url: 'https://elsewhere.example/mcp' },
      theirs: { url: 'http://127.0.0.1:7860/mcp' },
    })
    const at = setup([], ON, claude)
    recordMade(at.db, { module: 'kehikot.gone', name: 'gone', url: 'http://127.0.0.1:7850/mcp', title: 'Gone' })
    recordMade(at.db, { module: 'kehikot.moved', name: 'moved', url: 'http://127.0.0.1:7851/mcp', title: 'Moved' })
    await syncOnce(at.deps)
    expect(at.claude.calls).toEqual([['mcp', 'remove', 'gone']])
    expect(at.told).toEqual(['Removed Gone’s tools from Claude Code: the module is no longer installed'])
    expect([...claude.known.keys()].sort()).toEqual(['moved', 'theirs'])
    expect(madeEntries(at.db)).toEqual([])
  })

  test('a failed claude is said once as the quiet item and retried', async () => {
    const at = setup([mod('kehikot.browser', 7801)])
    at.deps.run = async () => ({ ok: false, said: 'claude: command not found' })
    const ran = await syncOnce(at.deps)
    expect(ran.transient).toBe(true)
    expect(ran.status.modules[0]!.tools).toBe('failed')
    expect(at.troubles.at(-1)).toEqual(['Could not connect Browser’s tools for Claude Code: claude: command not found'])
  })

  test('a refused door name is not connected', async () => {
    const at = setup([mod('kehikot.browser', 7801, { door: null, refusal: 'kehikot.browser asks for “notes”, which is taken.' })])
    const ran = await syncOnce(at.deps)
    expect(at.claude.calls).toEqual([])
    expect(ran.status.modules[0]!.tools).toBe('refused')
  })
})

describe('skills, kept installed and up to date', () => {
  test('installs every declared skill, then updates an untouched one when the module’s text changes', async () => {
    const table = { 'kehikot-here': skillText('kehikot-here') }
    const at = setup([mod('kehikot.claude', 7830, { door: null, skills: [skill('kehikot-here')] })], ON, fakeClaude(), table)
    await syncOnce(at.deps)
    expect(readFileSync(join(at.root, 'kehikot-here', 'SKILL.md'), 'utf8')).toBe(table['kehikot-here'])
    expect(at.told).toEqual(['Installed the /kehikot-here skill (Claude)'])

    at.table['kehikot-here'] = skillText('kehikot-here', 'Do it better.')
    at.deps.fetcher = serving(at.table)
    const ran = await syncOnce(at.deps)
    expect(readFileSync(join(at.root, 'kehikot-here', 'SKILL.md'), 'utf8')).toContain('Do it better.')
    expect(at.told).toEqual(['Installed the /kehikot-here skill (Claude)', 'Updated the /kehikot-here skill (Claude)'])
    expect(ran.status.modules[0]!.skills).toEqual([{ name: 'kehikot-here', state: 'installed' }])
  })

  test('leaves an edited skill and a taken name alone, and says so', async () => {
    const table = { mine: skillText('mine'), taken: skillText('taken') }
    const at = setup([mod('kehikot.claude', 7830, { door: null, skills: [skill('mine'), skill('taken')] })], ON, fakeClaude(), table)
    await syncOnce(at.deps)
    writeFileSync(join(at.root, 'mine', 'SKILL.md'), 'my own words\n')
    /* `taken`: a folder Kehikot did not install. */
    const takenAt = join(at.root, 'taken')
    writeFileSync(join(takenAt, MARKER), JSON.stringify({ module: 'kehikot.other', name: 'taken', version: '1', sha256: sha256('x') }))
    at.told.length = 0
    at.table.mine = skillText('mine', 'Newer.')
    at.deps.fetcher = serving(at.table)
    const ran = await syncOnce(at.deps)
    expect(readFileSync(join(at.root, 'mine', 'SKILL.md'), 'utf8')).toBe('my own words\n')
    expect(at.told).toEqual([])
    expect(ran.status.modules[0]!.skills).toEqual([
      { name: 'mine', state: 'edited' },
      { name: 'taken', state: 'taken' },
    ])
    expect(skillsSaid(ran.status)).toBe('0 installed, 1 changed by you, 1 name taken')
    expect(at.troubles.at(-1)!.join(' ')).toContain('changed by you')
  })

  test('nothing is installed before the question, or for a module left out', async () => {
    const table = { a: skillText('a') }
    for (const settings of [DEFAULT_SETTINGS, { ...ON, skills: { auto: true, except: ['kehikot.claude'] } }]) {
      const at = setup([mod('kehikot.claude', 7830, { door: null, skills: [skill('a')] })], settings, fakeClaude(), table)
      const ran = await syncOnce(at.deps)
      expect(at.told).toEqual([])
      expect(ran.status.modules[0]!.skills[0]!.state).toBe(settings.asked ? 'excepted' : 'absent')
    }
  })
})

describe('kehikko-bound skills (protocol 2.12.0)', () => {
  const bound = (name: string): ModuleSkill => ({ ...skill(name), needs: ['kehikot.review'] })
  const factory = (skills: ModuleSkill[]) => mod('kehikot.factory', 7840, { door: null, skills })
  const where = 'Available in conversations on a kehikko that also has Review and Factory'

  test('is never installed for every conversation, whatever the settings', async () => {
    const table = { 'review-factory': skillText('review-factory'), factory: skillText('factory') }
    const at = setup([factory([skill('factory'), bound('review-factory')])], ON, fakeClaude(), table)
    const ran = await syncOnce(at.deps)
    expect(existsSync(join(at.root, 'review-factory'))).toBe(false)
    expect(existsSync(join(at.root, 'factory', 'SKILL.md'))).toBe(true)
    expect(at.told).toEqual(['Installed the /factory skill (Claude)'])
    expect(ran.status.modules[0]!.skills).toEqual([
      { name: 'factory', state: 'installed' },
      { name: 'review-factory', state: 'bound', bound: where },
    ])
    expect(skillsSaid(ran.status)).toBe('1 installed, 1 only on a kehikko')
  })

  test('names a needed module the sweep saw by its own name', async () => {
    const at = setup([mod('kehikot.review', 7850, { door: null, name: 'Code Review' }), factory([bound('review-factory')])])
    const ran = await syncOnce(at.deps)
    expect(ran.status.modules[1]!.skills[0]!.bound).toBe('Available in conversations on a kehikko that also has Code Review and Factory')
  })

  test('one Kehikot installed earlier is removed with one Inbox line, settings off or on', async () => {
    const table = { 'review-factory': skillText('review-factory') }
    const at = setup([factory([skill('review-factory')])], ON, fakeClaude(), table)
    await syncOnce(at.deps)
    expect(existsSync(join(at.root, 'review-factory', 'SKILL.md'))).toBe(true)
    at.told.length = 0
    writeSettings(at.db, { ...ON, skills: { auto: false, except: [] } })
    at.state.seen = [factory([bound('review-factory')])]
    const ran = await syncOnce(at.deps)
    expect(existsSync(join(at.root, 'review-factory'))).toBe(false)
    expect(at.told).toEqual([`Removed the /review-factory skill from every conversation. ${where}, where the Claude module loads it`])
    expect(ran.status.modules[0]!.skills).toEqual([{ name: 'review-factory', state: 'bound', bound: where }])
    at.told.length = 0
    await syncOnce(at.deps)
    expect(at.told).toEqual([])
  })

  test('an edited one is left, said once, and said again only after it stopped being edited', async () => {
    const table = { 'review-factory': skillText('review-factory') }
    const at = setup([factory([skill('review-factory')])], ON, fakeClaude(), table)
    await syncOnce(at.deps)
    writeFileSync(join(at.root, 'review-factory', 'SKILL.md'), 'my own words\n')
    at.told.length = 0
    at.state.seen = [factory([bound('review-factory')])]
    const ran = await syncOnce(at.deps)
    expect(readFileSync(join(at.root, 'review-factory', 'SKILL.md'), 'utf8')).toBe('my own words\n')
    expect(at.told).toEqual([
      `Left the /review-factory skill (${at.root}/review-factory) in every conversation because you changed it. ${where}; delete that folder to have it only there`,
    ])
    expect(ran.status.modules[0]!.skills).toEqual([{ name: 'review-factory', state: 'edited', bound: where }])
    at.told.length = 0
    await syncOnce(at.deps)
    expect(at.told).toEqual([])
  })

  test('a folder of that name Kehikot did not install is left alone and not counted as a problem', async () => {
    const at = setup([factory([bound('review-factory')])])
    mkdirSync(join(at.root, 'review-factory'))
    writeFileSync(join(at.root, 'review-factory', 'SKILL.md'), 'theirs\n')
    const ran = await syncOnce(at.deps)
    expect(readFileSync(join(at.root, 'review-factory', 'SKILL.md'), 'utf8')).toBe('theirs\n')
    expect(ran.status.modules[0]!.skills[0]!.state).toBe('bound')
    expect(ran.status.problems).toEqual([])
  })
})

describe('a module that is not running', () => {
  test('is connected from the door it had when it last ran, and says so', async () => {
    const at = setup([mod('kehikot.notes', 7802, { answering: false, version: null })])
    const ran = await syncOnce(at.deps)
    expect(at.claude.calls).toEqual([['mcp', 'add', '--scope', 'user', '--transport', 'http', 'notes', 'http://127.0.0.1:7802/mcp']])
    expect(at.told).toEqual(['Connected Notes’s tools for Claude Code'])
    expect(madeEntries(at.db).map((one) => one.url)).toEqual(['http://127.0.0.1:7802/mcp'])
    const row = ran.status.modules[0]!
    expect(row).toMatchObject({ tools: 'connected', answering: false })
    expect(toolSays(row)).toBe('Connected (not running now)')
    expect(toolsSaid(ran.status)).toBe('1 connected (1 not running now)')
  })

  test('when it starts with its door somewhere else, Kehikot’s entry is re-pointed', async () => {
    const at = setup([mod('kehikot.notes', 7802, { answering: false, version: null })])
    await syncOnce(at.deps)
    at.state.seen = [mod('kehikot.notes', 7812)]
    const ran = await syncOnce(at.deps)
    expect(at.claude.calls.slice(1)).toEqual([
      ['mcp', 'remove', 'notes'],
      ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'notes', 'http://127.0.0.1:7812/mcp'],
    ])
    expect(toolSays(ran.status.modules[0]!)).toBe('Connected')
  })

  test('one never seen running has no door to connect: still “not running”', async () => {
    const at = setup([mod('kehikot.notes', 7802, { answering: false, door: null, version: null })])
    const ran = await syncOnce(at.deps)
    expect(at.claude.calls).toEqual([])
    expect(toolSays(ran.status.modules[0]!)).toBe('Not running')
  })
})

describe('skills of an uninstalled module', () => {
  async function installed(names: string[], module = 'kehikot.notes') {
    const table = Object.fromEntries(names.map((name) => [name, skillText(name)]))
    const at = setup([mod(module, 7830, { door: null, skills: names.map((name) => skill(name)) })], ON, fakeClaude(), table)
    await syncOnce(at.deps)
    at.told.length = 0
    return at
  }

  test('untouched installs are removed, an edited one is left and said once, whatever the settings', async () => {
    const at = await installed(['tidy', 'kept'])
    writeFileSync(join(at.root, 'kept', 'SKILL.md'), 'my own words\n')
    /* The person's own skill with no marker, and another registered module's. */
    mkdirSync(join(at.root, 'own'))
    writeFileSync(join(at.root, 'own', 'SKILL.md'), 'mine\n')
    writeSettings(at.db, { ...DEFAULT_SETTINGS, skills: { auto: false, except: [] } })
    at.state.seen = []
    at.deps.registry = () => new Set(['kehikot.other'])
    await syncOnce(at.deps)
    expect(existsSync(join(at.root, 'tidy'))).toBe(false)
    expect(readFileSync(join(at.root, 'kept', 'SKILL.md'), 'utf8')).toBe('my own words\n')
    expect(existsSync(join(at.root, 'own', 'SKILL.md'))).toBe(true)
    expect(at.told).toEqual([
      `Left the /kept skill (${at.root}/kept): kehikot.notes, which installed it, is no longer installed, and you changed it`,
      'Removed the /tidy skill: kehikot.notes, which installed it, is no longer installed',
    ])
    at.told.length = 0
    await syncOnce(at.deps)
    expect(at.told).toEqual([])
  })

  test('a registered module’s skills, and every skill when the registry could not be read, stay', async () => {
    const at = await installed(['stay'])
    at.deps.registry = () => new Set(['kehikot.notes'])
    await syncOnce(at.deps)
    at.deps.registry = () => null
    at.state.seen = []
    await syncOnce(at.deps)
    expect(existsSync(join(at.root, 'stay', 'SKILL.md'))).toBe(true)
    expect(at.told).toEqual([])
  })

  function placed(root: string, name: string, module: string, registry?: string) {
    mkdirSync(join(root, name))
    const text = skillText(name)
    writeFileSync(join(root, name, 'SKILL.md'), text)
    writeFileSync(join(root, name, MARKER), JSON.stringify({ module, name, version: '1', sha256: sha256(text), ...(registry ? { registry } : {}) }))
  }

  test('a marker names the registry of the host that wrote it', async () => {
    const at = await installed(['named'])
    const marker = JSON.parse(readFileSync(join(at.root, 'named', MARKER), 'utf8'))
    expect(marker.registry).toBe(thisRegistry())
    expect(marker.registry).toBe(resolve(process.env.KEHIKOT_MODULES_DIR!))
  })

  test('only this host’s registry tidies: another registry’s install stays, however gone its module is here', () => {
    const db = new Database(':memory:')
    ensureSettings(db)
    const root = freshRoot()
    placed(root, 'mine', 'kehikot.gone', '/registry/here')
    placed(root, 'theirs', 'kehikot.gone', '/registry/elsewhere')
    const lines: string[] = []
    const here = { registry: '/registry/here', machine: false }
    expect(tidySkills(db, root, new Set(['kehikot.gone']), (line) => lines.push(line), here).removed).toEqual([])
    expect(tidySkills(db, root, new Set(), (line) => lines.push(line), here).removed).toEqual(['mine'])
    expect(existsSync(join(root, 'theirs', 'SKILL.md'))).toBe(true)
    expect(lines).toEqual(['Removed the /mine skill: kehikot.gone, which installed it, is no longer installed'])
  })

  test('a marker from before the registry was recorded is tidied only by a host on the machine’s own registry', () => {
    const db = new Database(':memory:')
    ensureSettings(db)
    const root = freshRoot()
    placed(root, 'older', 'kehikot.gone')
    expect(tidySkills(db, root, new Set(), () => {}, { registry: '/scratch/modules', machine: false }).removed).toEqual([])
    expect(existsSync(join(root, 'older', 'SKILL.md'))).toBe(true)
    expect(tidySkills(db, root, new Set(), () => {}, { registry: '/machine/modules', machine: true }).removed).toEqual(['older'])
  })

  test('which registry is the machine’s own', () => {
    const home = '/Users/someone'
    expect(isMachineRegistry({ HOME: home })).toBe(true)
    expect(isMachineRegistry({ HOME: home, KEHIKOT_MODULES_DIR: '/tmp/scratch-modules' })).toBe(false)
    expect(isMachineRegistry({ HOME: home, KEHIKOT_MODULES_DIR: thisRegistry({ HOME: home }) })).toBe(true)
  })
})

describe('the Inbox', () => {
  function inboxed() {
    const db = open(':memory:')
    const one = addProject(db, mkdtempSync(join(tmpdir(), 'kehikko-sync-')), 'a')
    const two = addProject(db, mkdtempSync(join(tmpdir(), 'kehikko-sync-')), 'b')
    if (!one.ok || !two.ok) throw new Error('no projects')
    const inbox = new Inbox(db)
    const where = { now: [one.project.id] }
    const changed: number[] = []
    const say = settingsInbox(inbox, () => where.now, (project) => changed.push(project))
    return { inbox, say, where, one: one.project.id, two: two.project.id, changed }
  }

  test('each change is one notice line, born done, by Kehikot', () => {
    const at = inboxed()
    at.say.tell('Connected Browser’s tools for Claude Code')
    const all = at.inbox.all(at.one)
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ module: SETTINGS_INBOX_MODULE, name: 'Kehikot', label: 'Connected Browser’s tools for Claude Code', state: 'done' })
    expect(at.inbox.all(at.two)).toEqual([])
  })

  test('problems are one quiet item, cleared when nothing is wrong, also where it was put before', () => {
    const at = inboxed()
    at.say.trouble(['one', 'two'])
    expect(at.inbox.open(at.one).map((one) => [one.id, one.priority, one.label])).toEqual([
      [SYNC_TROUBLE_ID, 'low', '2 things in your agent’s setup were left alone'],
    ])
    at.changed.length = 0
    at.say.trouble(['one', 'two'])
    expect(at.changed).toEqual([])
    at.where.now = [at.two]
    at.say.trouble([])
    expect(at.inbox.open(at.one)).toEqual([])
    expect(at.inbox.open(at.two)).toEqual([])
  })
})

describe('the loop', () => {
  test('debounced and one run at a time: claude never runs alongside itself', async () => {
    const at = setup([mod('kehikot.a', 7801), mod('kehikot.b', 7802), mod('kehikot.c', 7803)])
    let runs = 0
    const modules = at.deps.modules
    at.deps.modules = async () => {
      runs += 1
      return modules()
    }
    const loop = new AgentSync(at.deps, { debounceMs: 5, retryMs: 10_000 })
    loop.poke()
    loop.poke()
    loop.poke()
    await Bun.sleep(30)
    const first = loop.now()
    void loop.now()
    await first
    await Bun.sleep(30)
    loop.stop()
    expect(at.claude.overlapped()).toBe(false)
    expect(at.claude.calls).toHaveLength(3)
    expect(runs).toBeLessThanOrEqual(3)
    expect(loop.status().modules.every((one) => one.tools === 'connected')).toBe(true)
  })

  test('a sweep that saw nothing new is not a run', () => {
    const at = setup([])
    const loop = new AgentSync(at.deps, { debounceMs: 60_000 })
    const seen = [mod('kehikot.a', 7801)]
    loop.saw(seen)
    expect(fingerprintOf(seen)).toBe(fingerprintOf([mod('kehikot.a', 7801)]))
    expect(fingerprintOf(seen)).not.toBe(fingerprintOf([mod('kehikot.a', 7801, { version: '1.1.0' })]))
    expect(fingerprintOf(seen)).not.toBe(fingerprintOf([mod('kehikot.a', 7801, { skills: [skill('x')] })]))
    loop.stop()
  })

  test('a failure is retried later', async () => {
    const at = setup([mod('kehikot.a', 7801)])
    let tries = 0
    at.deps.run = async (args) => {
      tries += 1
      return tries === 1 ? { ok: false, said: 'busy' } : at.claude.run(args)
    }
    const loop = new AgentSync(at.deps, { debounceMs: 1, retryMs: 10 })
    await loop.now()
    expect(loop.status().modules[0]!.tools).toBe('failed')
    await Bun.sleep(80)
    loop.stop()
    expect(loop.status().modules[0]!.tools).toBe('connected')
  })
})

describe('the settings', () => {
  test('stored in frame.sqlite, defaulting to not asked, and read strictly', () => {
    const db = new Database(':memory:')
    ensureSettings(db)
    expect(readSettings(db)).toEqual(DEFAULT_SETTINGS)
    expect(readSettings(db).asked).toBe(false)
    expect(settingsPatched(DEFAULT_SETTINGS, { tools: { auto: false } })).toMatchObject({ tools: { auto: false, except: [] } })
    expect(settingsPatched(DEFAULT_SETTINGS, { codex: {} })).toBeNull()
    expect(settingsPatched(DEFAULT_SETTINGS, { providers: { codex: { enabled: true } } })).toBeNull()
    expect(settingsPatched(DEFAULT_SETTINGS, { tools: { auto: 'yes' } })).toBeNull()
  })

  test('the route reads, changes, and takes one exception at a time', async () => {
    const db = new Database(':memory:')
    ensureSettings(db)
    let pokes = 0
    const route = settingsRoute({ db, status: () => ({ at: null, running: false, modules: [], problems: [] }), changed: () => (pokes += 1), skillsAt: () => '/s', hook: () => ({ file: '/x', on: false }) })
    const post = (body: unknown) => route(new Request('http://127.0.0.1/host/settings', { method: 'POST', body: JSON.stringify(body) }), new URL('http://127.0.0.1/host/settings'))
    const got = await (await route(new Request('http://127.0.0.1/host/settings'), new URL('http://127.0.0.1/host/settings')))!.json()
    expect(got).toMatchObject({ ok: true, settings: DEFAULT_SETTINGS, skillsAt: '/s', hook: { on: false } })
    expect((await post({ settings: { asked: true, skills: { auto: false } } }))!.status).toBe(200)
    expect(readSettings(db)).toMatchObject({ asked: true, skills: { auto: false }, tools: { auto: true } })
    await post({ except: { kind: 'tools', module: 'kehikot.notes', out: true } })
    await post({ except: { kind: 'tools', module: 'kehikot.browser', out: true } })
    await post({ except: { kind: 'tools', module: 'kehikot.notes', out: false } })
    expect(readSettings(db).tools.except).toEqual(['kehikot.browser'])
    expect((await post({ settings: { nope: 1 } }))!.status).toBe(400)
    expect(pokes).toBe(4)
  })

  test('“Keep this project’s modules running”: on by default, changed with { modules: { keep } }, told once per change', async () => {
    const db = new Database(':memory:')
    ensureSettings(db)
    const told: boolean[] = []
    const route = settingsRoute({
      db,
      status: () => ({ at: null, running: false, modules: [], problems: [] }),
      changed: () => {},
      modulesChanged: (keep) => told.push(keep),
      skillsAt: () => '/s',
      hook: () => ({ file: '/x', on: false }),
    })
    const at = new URL('http://127.0.0.1/host/settings')
    const post = (body: unknown) => route(new Request(at, { method: 'POST', body: JSON.stringify(body) }), at)
    expect((await (await route(new Request(at), at))!.json()).modules).toEqual({ keep: true })
    expect(readKeepRunning(db)).toBe(true)
    const off = await (await post({ modules: { keep: false } }))!.json()
    expect(off.modules).toEqual({ keep: false })
    expect(readKeepRunning(db)).toBe(false)
    /* The same again is no change and tells nobody. */
    await post({ modules: { keep: false } })
    expect(told).toEqual([false])
    expect((await post({ modules: { keep: 'yes' } }))!.status).toBe(400)
    await post({ modules: { keep: true } })
    expect(told).toEqual([false, true])
    expect(readSettings(db)).toEqual(DEFAULT_SETTINGS)
  })

  test('the POST is the page’s alone', () => {
    expect(PAGE_ONLY).toContain('/host/settings')
    const self: Own = { origins: ['http://127.0.0.1:4181'], hosts: new Set(['127.0.0.1:4180']) }
    const asked = (headers: Record<string, string>) =>
      refusal({ method: 'POST', pathname: '/host/settings', headers: new Headers({ host: '127.0.0.1:4180', ...headers }) }, self)
    expect(asked({ 'content-type': 'application/json', 'content-length': '2' })?.status).toBe(403)
    expect(asked({ origin: 'http://127.0.0.1:4181', 'content-type': 'application/json', 'content-length': '2' })).toBeNull()
  })

  test('the start hook is read from Claude Code’s settings beside the scratch config, never written', () => {
    const file = claudeSettingsFile()
    expect(file.startsWith(join(process.env.CLAUDE_CONFIG!.replace(/\/[^/]+$/, ''), '.claude'))).toBe(true)
    expect(claudeSettingsFile({ CLAUDE_CONFIG_DIR: '/c' })).toBe('/c/settings.json')
    const dir = join(claudeSkillsDir(), '..', `hook-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    const at = join(dir, 'settings.json')
    expect(startHook(at)).toEqual({ file: at, on: false })
    writeFileSync(at, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: "/bin/sh '/m/started.sh' '/r/kehikot.claude.json'" }] }] } }))
    const before = readFileSync(at, 'utf8')
    expect(startHook(at).on).toBe(true)
    expect(readFileSync(at, 'utf8')).toBe(before)
    writeFileSync(at, '{ not json')
    expect(startHook(at).on).toBeNull()
  })
})
