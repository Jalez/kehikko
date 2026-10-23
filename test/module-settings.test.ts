import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LIMITS, settingsDeclarationSchema, type SettingField } from 'kehikot-module-protocol'
import { hostVouches } from 'kehikot-module-protocol/serve'

import { createCanvas, open } from '../server/canvases.ts'
import { own, refusal } from '../server/guard.ts'
import { call, mcp, type Door } from '../server/mcp.ts'
import { inside, moduleSettingsDesk, Passes, relativeFile, type SettingsModule } from '../server/moduleSettings.ts'
import { Openness } from '../server/open.ts'
import { addProject } from '../server/projects.ts'
import { controlFor, linesOf, listOf, numberOf, savedSaid, settingsPlaceFor, settingsText, valueSaid } from '../src/host/moduleSettings.ts'

/**
 * A module's settings from the host's side (protocol 2.15.0): the person's pass — minted only on
 * the page's route, single-use, scoped to one module, key and project, gone after 30 s — the read
 * and the change at the module's door, the file shown read-only and only from the module's own
 * folder, the routes that are the page's alone, and the door's `module_settings`, which only reads.
 * All in scratch directories with a fake module; nothing here is the real machine.
 */

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-module-settings-')))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const FIELDS: SettingField[] = settingsDeclarationSchema.parse([
  { key: 'judgeMerges', label: 'Let the judge merge', type: 'boolean', default: false, personOnly: true },
  { key: 'defaultRule', label: 'Ready for another review', type: 'string', default: 'when they ask' },
  { key: 'hook', label: 'Report outside sessions', type: 'boolean', default: false, scope: 'machine' },
])
const FACTORY: SettingsModule = { id: 'kehikot.factory', name: 'Factory', origin: 'http://127.0.0.1:7920', fields: FIELDS }

/** A module's door in memory: answers `settings.get` and `settings.set`, and asks the host about a pass as a module would. */
function fakeModule(passes: Passes) {
  const kept: Record<string, unknown> = { judgeMerges: false }
  const asked: { url: string; body?: Record<string, unknown> }[] = []
  const fetching = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    asked.push({ url, ...(body ? { body } : {}) })
    if (!init?.method || init.method === 'GET') {
      return Response.json({ ok: true, values: { ...kept, unknown: 1 }, file: '.kehikot/factory/settings.json' })
    }
    /* The module's own check: a person-only setting needs a pass this host vouches for. */
    const field = FIELDS.find((one) => one.key === body!.key)!
    const vouched = await hostVouches(body!.pass as string, { module: 'kehikot.factory', key: String(body!.key), ...(body!.project ? { project: String(body!.project) } : {}) }, {
      env: { KEHIKOT_ORIGINS: 'http://127.0.0.1:4181' },
      fetch: (async (asking: string) => Response.json(desk.vouch(new URL(asking).searchParams))) as unknown as typeof fetch,
    })
    if (field.personOnly && !vouched) return Response.json({ ok: true, outcome: 'refused', why: 'Only the person.' })
    kept[field.key] = body!.value
    return Response.json({ ok: true, outcome: 'saved', why: '', values: { ...kept } })
  }) as unknown as typeof fetch
  const desk = moduleSettingsDesk({ passes, moduleOf: async (id) => (id === FACTORY.id ? FACTORY : null), fetch: fetching })
  return { desk, kept, asked }
}

describe('the pass', () => {
  test('is single-use and scoped to its module, key and project', () => {
    const passes = new Passes()
    const about = { module: 'kehikot.factory', key: 'judgeMerges', project: '/p' }
    const pass = passes.issue(about)
    expect(pass).toMatch(/^[A-Za-z0-9_-]{22,64}$/)
    expect(passes.take(pass, about)).toBe(true)
    expect(passes.take(pass, about)).toBe(false)
    for (const wrong of [{ ...about, module: 'kehikot.claude' }, { ...about, key: 'defaultRule' }, { ...about, project: '/q' }, { ...about, project: null }]) {
      const one = passes.issue(about)
      expect(passes.take(one, wrong)).toBe(false)
      /* Shown once, even to the wrong question. */
      expect(passes.take(one, about)).toBe(false)
    }
    expect(passes.take('not-a-pass', about)).toBe(false)
    expect(passes.take(null, about)).toBe(false)
  })

  test('expires after 30 seconds, and an expired one is forgotten', () => {
    let now = 1_000_000
    const passes = new Passes(() => now)
    const about = { module: 'kehikot.factory', key: 'judgeMerges', project: null }
    const fresh = passes.issue(about)
    now += LIMITS.SETTINGS_PASS_MS
    expect(LIMITS.SETTINGS_PASS_MS).toBe(30_000)
    expect(passes.take(fresh, about)).toBe(true)
    const late = passes.issue(about)
    now += LIMITS.SETTINGS_PASS_MS + 1
    expect(passes.take(late, about)).toBe(false)
    passes.issue(about)
    now += LIMITS.SETTINGS_PASS_MS + 1
    passes.issue(about)
    expect(passes.size).toBe(1)
  })

  test('is minted only by a change, and a change is reached only by the page’s route', () => {
    const server = readFileSync(join(import.meta.dir, '..', 'server', 'server.ts'), 'utf8')
    const desk = readFileSync(join(import.meta.dir, '..', 'server', 'moduleSettings.ts'), 'utf8')
    /* One mint, in the desk's `set`; nothing in the server mints one itself. */
    expect(desk.match(/passes\.issue\(/g)?.length).toBe(1)
    expect(server.includes('settingsPasses.issue')).toBe(false)
    /* `set` is called on one route only, the page's alone. */
    expect(server.match(/moduleSettings\.set\(/g)?.length).toBe(1)
    const at = server.indexOf('moduleSettings.set(')
    const route = server.indexOf("url.pathname === '/host/module-settings/set'")
    expect(at - route).toBeGreaterThan(0)
    expect(at - route).toBeLessThan(400)
    /* And the door is never handed a way to change one. */
    const mcpSource = readFileSync(join(import.meta.dir, '..', 'server', 'mcp.ts'), 'utf8')
    expect(mcpSource.includes('moduleSettings.set')).toBe(false)
  })
})

describe('the routes that are the page’s alone', () => {
  const PAGE = 'http://127.0.0.1:4181'
  const SELF = own({}, 4180, [PAGE])
  const ask = (pathname: string, headers: Record<string, string>) =>
    refusal({ method: 'POST', pathname, headers: new Headers({ host: '127.0.0.1:4180', 'content-type': 'application/json', 'content-length': '2', ...headers }) }, SELF)

  test('answer the page, and refuse a program, another page, and anything not JSON', () => {
    for (const path of ['/host/module-settings', '/host/module-settings/list', '/host/module-settings/set', '/host/module-settings/file']) {
      expect(ask(path, { origin: PAGE })).toBeNull()
      expect(ask(path, {})?.status).toBe(403)
      expect(ask(path, { origin: 'http://127.0.0.1:7920' })?.status).toBe(403)
      expect(ask(path, { origin: PAGE, 'content-type': 'text/plain' })?.status).toBe(403)
    }
  })

  test('the pass is asked about by a program, with a GET', () => {
    expect(refusal({ method: 'GET', pathname: '/host/settings-pass', headers: new Headers({ host: '127.0.0.1:4180' }) }, SELF)).toBeNull()
    expect(refusal({ method: 'GET', pathname: '/host/settings-pass', headers: new Headers({ host: '127.0.0.1:4180', origin: 'http://127.0.0.1:7920' }) }, SELF)?.status).toBe(403)
  })
})

describe('reading and changing at the module’s door', () => {
  test('reads only what it declared, each value of its type, and the file it named', async () => {
    const { desk } = fakeModule(new Passes())
    const read = await desk.read('kehikot.factory', '/p')
    expect(read).toEqual({
      ok: true,
      module: 'kehikot.factory',
      name: 'Factory',
      fields: FIELDS,
      values: { judgeMerges: false, defaultRule: 'when they ask', hook: false },
      file: '.kehikot/factory/settings.json',
      problem: null,
    })
    expect(await desk.read('kehikot.nobody', '/p')).toEqual({ ok: false, why: expect.stringContaining('is not running') })
  })

  test('a person’s change goes with a pass the module can check, once, and is saved', async () => {
    const passes = new Passes()
    const { desk, kept, asked } = fakeModule(passes)
    const came = await desk.set('kehikot.factory', '/p', 'judgeMerges', true)
    expect(came).toEqual({ outcome: 'saved', why: '', values: { judgeMerges: true, defaultRule: 'when they ask', hook: false } })
    expect(kept.judgeMerges).toBe(true)
    const sent = asked.at(-1)!.body!
    expect(sent).toMatchObject({ project: '/p', key: 'judgeMerges', value: true, by: 'person' })
    /* Spent: the same pass shown again is nobody's. */
    expect(passes.take(sent.pass as string, { module: 'kehikot.factory', key: 'judgeMerges', project: '/p' })).toBe(false)
  })

  test('a machine setting goes without a project, and its pass is for no project', async () => {
    const { desk, asked } = fakeModule(new Passes())
    expect((await desk.set('kehikot.factory', '/p', 'hook', true)) as { outcome: string }).toMatchObject({ outcome: 'saved' })
    expect(asked.at(-1)!.body!.project).toBeUndefined()
  })

  test('refused here before anything is sent: no such key, a value of another type, a project setting with no project', async () => {
    const { desk, asked } = fakeModule(new Passes())
    expect(await desk.set('kehikot.factory', '/p', 'nope', 1)).toEqual({ ok: false, why: expect.stringContaining('no setting called') })
    expect(await desk.set('kehikot.factory', '/p', 'judgeMerges', 'yes')).toEqual({ outcome: 'refused', why: expect.stringContaining('true or false') })
    expect(await desk.set('kehikot.factory', null, 'defaultRule', 'x')).toEqual({ ok: false, why: expect.stringContaining('Open a project') })
    expect(asked.length).toBe(0)
  })

  test("the module's refusal is said as it said it", async () => {
    const passes = new Passes()
    const refusing = moduleSettingsDesk({
      passes,
      moduleOf: async () => FACTORY,
      fetch: (async () => Response.json({ ok: true, outcome: 'refused', why: 'Not in a read-only project.' })) as unknown as typeof fetch,
    })
    expect(await refusing.set('kehikot.factory', '/p', 'defaultRule', 'x')).toEqual({ outcome: 'refused', why: 'Not in a read-only project.' })
  })
})

describe('the file, read-only', () => {
  const project = join(ROOT, 'project')
  const own = join(project, '.kehikot', 'factory')
  mkdirSync(own, { recursive: true })
  writeFileSync(join(own, 'settings.json'), '{\n  "judgeMerges": true\n}\n')
  writeFileSync(join(project, 'secret.txt'), 'not yours')
  symlinkSync(join(project, 'secret.txt'), join(own, 'link.json'))

  test('is shown only from the module’s own folder, symlinks resolved', () => {
    expect(inside(project, 'kehikot.factory', '.kehikot/factory/settings.json')).toBe(join(own, 'settings.json'))
    expect(inside(project, 'kehikot.factory', '.kehikot/claude/settings.json')).toBeNull()
    expect(inside(project, 'kehikot.factory', '.kehikot/factory/../../secret.txt')).toBeNull()
    expect(inside(project, 'kehikot.factory', '.kehikot/factory/link.json')).toBeNull()
    expect(inside(project, 'not an id', '.kehikot/factory/settings.json')).toBeNull()
    expect(relativeFile('/etc/passwd')).toBeNull()
    expect(relativeFile('../x')).toBeNull()
  })

  test('reads the text the module named, and writes nothing', async () => {
    const desk = moduleSettingsDesk({
      passes: new Passes(),
      moduleOf: async () => FACTORY,
      fetch: (async () => Response.json({ ok: true, values: {}, file: '.kehikot/factory/settings.json' })) as unknown as typeof fetch,
    })
    const before = readFileSync(join(own, 'settings.json'), 'utf8')
    expect(await desk.file('kehikot.factory', project)).toEqual({ ok: true, path: join(own, 'settings.json'), file: '.kehikot/factory/settings.json', text: before })
    expect(readFileSync(join(own, 'settings.json'), 'utf8')).toBe(before)
    const elsewhere = moduleSettingsDesk({
      passes: new Passes(),
      moduleOf: async () => FACTORY,
      fetch: (async () => Response.json({ ok: true, values: {}, file: 'secret.txt' })) as unknown as typeof fetch,
    })
    expect(await elsewhere.file('kehikot.factory', project)).toEqual({ ok: false, why: expect.stringContaining('not in Factory') })
  })
})

describe('module_settings at the door', () => {
  let db: Database
  let folder: string
  beforeEach(() => {
    db = open(':memory:')
    folder = mkdtempSync(join(tmpdir(), 'kehikko-module-settings-door-'))
  })
  afterEach(() => {
    db.close()
    rmSync(folder, { recursive: true, force: true })
  })

  const door = (reads: string[]): Door => {
    const openness = new Openness()
    const added = addProject(db, folder, 'thesis')
    const made = createCanvas(db, 'k', added.ok ? added.project.id : null)
    openness.reported('page', made.id)
    return {
      db,
      which: () => openness.open(),
      wake: () => {},
      epicsChanged: () => {},
      dispositionsChanged: () => {},
      seen: async () => [],
      moduleSettings: {
        list: async () => [
          { id: 'kehikot.factory', name: 'Factory', icon: null, ready: true, fields: FIELDS },
          { id: 'kehikot.notes', name: 'Notes', icon: null, ready: true, fields: [] },
        ],
        read: async (module, project) => {
          reads.push(`${module} ${project}`)
          return { ok: true, module, name: 'Factory', fields: FIELDS, values: { judgeMerges: true, defaultRule: 'when they ask', hook: false }, file: '.kehikot/factory/settings.json', problem: null }
        },
      },
    }
  }

  test('is read-only, and says each value and who may change it', async () => {
    const reads: string[] = []
    const listed = await mcp({ id: 1, method: 'tools/list' }, door(reads), { name: 'k', version: '0' })
    const tool = (listed.body as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } }).result.tools.find((one) => one.name === 'module_settings')!
    expect(tool.annotations?.readOnlyHint).toBe(true)
    const said = await call('module_settings', {}, door(reads))
    expect(said.failed).toBe(false)
    expect(said.text).toContain('Let the judge merge [judgeMerges, boolean, project]: on — only the person may change it.')
    expect(said.text).toContain('Ready for another review [defaultRule, string, project]: "when they ask" — an agent may change it')
    expect(said.text).not.toContain('Notes')
    expect(reads).toEqual([`kehikot.factory ${realpathSync(folder)}`])
    expect((await call('module_settings', { module: 'kehikot.notes' }, door(reads))).text).toContain('has no settings')
    expect((await call('module_settings', { module: 'kehikot.none' }, door(reads))).failed).toBe(true)
  })
})

describe('the page’s rules and words', () => {
  test('each type has its control, and a list and a number read back', () => {
    expect(['boolean', 'string', 'number', 'choice', 'list'].map((type) => controlFor({ type: type as SettingField['type'] }))).toEqual(['switch', 'text', 'number', 'select', 'lines'])
    expect(listOf(' a \n\n b ')).toEqual(['a', 'b'])
    expect(linesOf(['a', 2, 'b'])).toBe('a\nb')
    expect(numberOf('4.5')).toBe(4.5)
    expect(numberOf('four')).toBeNull()
    expect(valueSaid(FIELDS[0]!, false)).toBe('off')
  })

  test('"Saved", or the refusal’s sentence', () => {
    expect(savedSaid({ outcome: 'saved', why: '' })).toEqual({ tone: 'saved', text: 'Saved' })
    expect(savedSaid({ outcome: 'refused', why: 'No.' })).toEqual({ tone: 'refused', text: 'No.' })
    expect(savedSaid({ ok: false, why: 'Not running.' })).toEqual({ tone: 'refused', text: 'Not running.' })
  })

  test('the gear is a button at 220 and wider; under it, in "⋯" when the menus are drawn, else the Frame menu', () => {
    expect(settingsPlaceFor('words', true)).toBe('button')
    expect(settingsPlaceFor('icons', false)).toBe('button')
    expect(settingsPlaceFor('merged', true)).toBe('more')
    expect(settingsPlaceFor('merged', false)).toBe('frame')
  })

  test('the door’s text names the file, and that the module writes it', () => {
    const text = settingsText({ ok: true, module: 'kehikot.factory', name: 'Factory', fields: FIELDS, values: {}, file: '.kehikot/factory/settings.json', problem: null }, '/p')
    expect(text).toContain('Kept in .kehikot/factory/settings.json, which Factory writes; this host never does.')
  })
})
