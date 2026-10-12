import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installDesk } from '../server/installs.ts'
import { officialListFile } from '../server/machineDirs.ts'
import { meetsProtocol, OFFICIAL, readOfficial, type Official } from '../server/official.ts'
import {
  listUrl,
  MAX_BYTES,
  MAX_ENTRIES,
  mergeLists,
  officialSource,
  PUBLISHED_LIST,
  readFetched,
  REFRESH_EVERY_MS,
  RETRY_AFTER_MS,
} from '../server/officialSource.ts'
import type { Ran, Runner } from '../server/versions.ts'
import { staleLine } from '../src/host/official.ts'
import { rowsOf } from '../src/host/moduleMenu.ts'
import type { Presence } from '../src/host/registry.ts'

/*
 * The official list as it is learned at run time — against a fake fetch,
 * because the real one would ask GitHub. What matters: a fetched list can only
 * ADD to what the host was built with; every way a fetch can go wrong leaves
 * the host with what it had; the last good one survives a start with no
 * network; nobody is asked more often than every few minutes; and a changed
 * list never installs, refuses to install what this host cannot run, and never
 * repoints what is already here.
 */

const slides: Official = { id: 'kehikot.slides', name: 'Slides', repo: 'Jalez/kehikko-slides', port: 7990, summary: 'Decks.', tags: ['writing'] }
const notes: Official = { id: 'kehikot.notes', name: 'Notes', repo: 'Jalez/kehikko-notes', port: 7940, summary: 'Notes.', tags: ['reading'] }
const claude: Official = { id: 'kehikot.claude', name: 'Claude', repo: 'Jalez/kehikko-claude', port: 8010, summary: 'A terminal.', tags: ['agents', 'code'] }

const URL_ = 'https://lists.test/modules.json'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function cacheFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kehikot-official-'))
  scratch.push(dir)
  return join(dir, 'kept', 'official-modules.json')
}

type Answer = () => Response | Promise<Response>
const serving = (modules: unknown): Answer => () => new Response(JSON.stringify({ modules }))

function world(answer: Answer, over: { cache?: string; url?: string | null; builtIn?: Official[]; timeoutMs?: number } = {}) {
  const cache = over.cache ?? cacheFile()
  const clock = { at: 1_800_000_000_000 }
  const asked: string[] = []
  const logged: string[] = []
  let now = answer
  const source = officialSource({
    builtIn: over.builtIn ?? [slides, notes],
    url: over.url === undefined ? URL_ : over.url,
    cache,
    now: () => clock.at,
    timeoutMs: over.timeoutMs,
    log: (line) => logged.push(line),
    fetch: async (url, init) => {
      asked.push(url)
      expect(init.redirect).toBe('error')
      return now()
    },
  })
  const ids = () => source.current().map((one) => one.id)
  return { source, cache, clock, asked, logged, ids, answer: (next: Answer) => (now = next) }
}

describe('the merge', () => {
  test('a fetched entry wins, a new one is added, and one only built in stays', () => {
    const renamed = { ...slides, name: 'Decks', summary: 'Newer words.' }
    expect(mergeLists([slides, notes], [renamed, claude])).toEqual([renamed, notes, claude])
  })

  test('nothing fetched is the built-in list, and an empty fetched list takes nothing away', () => {
    expect(mergeLists([slides, notes], null)).toEqual([slides, notes])
    expect(mergeLists([slides, notes], [])).toEqual([slides, notes])
  })

  test('the pre-rename spelling of an id is the same module, not a second entry', () => {
    const old = { ...slides, id: 'roadmap.slides', name: 'Old spelling' }
    expect(mergeLists([slides], [old])).toEqual([old])
  })
})

describe('what a fetched list may be', () => {
  test('the entry another branch adds for Claude is accepted', () => {
    expect(readFetched({ modules: [...OFFICIAL.filter((one) => one.id !== claude.id), claude] }).some((one) => one.id === 'kehikot.claude')).toBe(true)
  })

  test('fields this host does not know are ignored, on the entry and on the list', () => {
    const read = readOfficial({ schema: 2, signedBy: 'somebody', modules: [{ ...slides, icon: 'deck', needs: { os: 'macos' } }] })
    expect(read).toEqual([slides])
  })

  test('the requirement is optional and kept as written', () => {
    expect(readOfficial({ modules: [slides] })[0]!.protocol).toBeUndefined()
    expect(readOfficial({ modules: [{ ...slides, protocol: '1.1.0' }] })[0]!.protocol).toBe('1.1.0')
    /* Written in a way this host cannot read: still a list, and a requirement it does not meet. */
    expect(readOfficial({ modules: [{ ...slides, protocol: '>=2' }] })[0]!.protocol).toBe('>=2')
    expect(() => readOfficial({ modules: [{ ...slides, protocol: 11 }] })).toThrow()
  })

  test('more entries than any real list has is refused, as is a repository that is not owner/name', () => {
    const many = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => ({ ...slides, id: `kehikot.m${i}` }))
    expect(() => readFetched({ modules: many })).toThrow('more than')
    expect(() => readFetched({ modules: [{ ...slides, repo: '--upload-pack=x/y' }] })).toThrow()
    expect(() => readFetched({ modules: [{ ...slides, repo: 'https://evil.test/a/b' }] })).toThrow()
  })
})

describe('whether this host can run what an entry asks for', () => {
  test('met, unmet, absent and unreadable', () => {
    expect(meetsProtocol(undefined, '1.0.0')).toBe(true)
    expect(meetsProtocol('1.0.0', '1.0.0')).toBe(true)
    expect(meetsProtocol('1.0.0', '1.1.0')).toBe(true)
    expect(meetsProtocol('1.9.0', '1.10.0')).toBe(true)
    expect(meetsProtocol('0.30.5', '1.0.0')).toBe(true)
    expect(meetsProtocol('1.1.0', '1.0.9')).toBe(false)
    expect(meetsProtocol('2.0.0', '1.99.99')).toBe(false)
    expect(meetsProtocol('1.0.1', '1.0.0')).toBe(false)
    for (const odd of ['>=1.0.0', '1.1', 'v1.1.0', '1.1.0-beta', 'latest', '']) expect(meetsProtocol(odd, '9.9.9')).toBe(false)
    /* A host that cannot say what it has meets no requirement either. */
    expect(meetsProtocol('1.0.0', 'unknown')).toBe(false)
  })

  test('the installed protocol package is what is compared when nothing is passed', () => {
    expect(meetsProtocol('0.0.1')).toBe(true)
    expect(meetsProtocol('999.0.0')).toBe(false)
  })
})

describe('where the list is read from', () => {
  test('the published one unless the environment says otherwise, and off is off', () => {
    expect(PUBLISHED_LIST).toBe('https://raw.githubusercontent.com/Jalez/kehikko/main/modules.json')
    expect(listUrl({})).toBe(PUBLISHED_LIST)
    expect(listUrl({ KEHIKOT_OFFICIAL_LIST: 'http://127.0.0.1:9904/modules.json' })).toBe('http://127.0.0.1:9904/modules.json')
    for (const off of ['off', 'OFF', '0', 'none', 'false']) expect(listUrl({ KEHIKOT_OFFICIAL_LIST: off })).toBeNull()
    /* Not a URL a list is fetched from: off, rather than a guess. */
    expect(listUrl({ KEHIKOT_OFFICIAL_LIST: 'file:///etc/passwd' })).toBeNull()
    expect(listUrl({ KEHIKOT_OFFICIAL_LIST: 'modules.json' })).toBeNull()
  })

  test('the suite itself asks nobody and keeps its cache in scratch', () => {
    expect(listUrl()).toBeNull()
    expect(officialListFile()).toBe(process.env.KEHIKOT_OFFICIAL_CACHE!)
    expect(officialListFile({ HOME: '/h' })).toMatch(/official-modules\.json$/)
  })
})

describe('learning the list', () => {
  test('before anything is fetched it is the built-in list, and a fetch adds to it', async () => {
    const { source, ids, asked } = world(serving([claude]))
    expect(ids()).toEqual(['kehikot.slides', 'kehikot.notes'])
    expect(source.standing()).toEqual({ fetched: null, stale: false })
    await source.refresh()
    expect(asked).toEqual([URL_])
    expect(ids()).toEqual(['kehikot.slides', 'kehikot.notes', 'kehikot.claude'])
    expect(source.standing()).toEqual({ fetched: new Date(1_800_000_000_000).toISOString(), stale: false })
  })

  test('turned off: nobody is asked, nothing is read and nothing is written', async () => {
    const cache = cacheFile()
    const seeded = world(serving([claude]), { cache })
    await seeded.source.refresh()
    expect(existsSync(cache)).toBe(true)

    const off = world(serving([claude]), { cache, url: null })
    await off.source.refresh()
    expect(off.asked).toEqual([])
    expect(off.ids()).toEqual(['kehikot.slides', 'kehikot.notes'])
  })

  const wrong: [string, Answer][] = [
    ['unreachable', () => Promise.reject(new Error('could not resolve host'))],
    ['an error answer', () => new Response('nope', { status: 503 })],
    ['not JSON', () => new Response('<html>a captive portal</html>')],
    ['not a list', () => new Response(JSON.stringify({ modules: 'all of them' }))],
    ['one bad entry', serving([claude, { ...slides, repo: '../../etc' }])],
    ['a module twice', serving([claude, claude])],
    ['too many entries', serving(Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => ({ ...slides, id: `kehikot.m${i}` })))],
    ['too large, and saying so', () => new Response('x', { headers: { 'content-length': String(MAX_BYTES + 1) } })],
    ['too large, without saying so', () => new Response(JSON.stringify({ modules: [claude], padding: 'x'.repeat(MAX_BYTES) }))],
  ]
  for (const [what, answer] of wrong) {
    test(`a list that is ${what} is ignored whole, and the host keeps what it had`, async () => {
      const { source, ids, cache, logged } = world(answer)
      await source.refresh()
      expect(ids()).toEqual(['kehikot.slides', 'kehikot.notes'])
      expect(source.standing()).toEqual({ fetched: null, stale: true })
      expect(existsSync(cache)).toBe(false)
      expect(logged).toHaveLength(1)
    })
  }

  test('a list that never arrives is given up on', async () => {
    const { source, ids } = world(() => new Promise<Response>(() => {}), { timeoutMs: 20 })
    const began = Date.now()
    await source.refresh()
    expect(Date.now() - began).toBeLessThan(2000)
    expect(ids()).toEqual(['kehikot.slides', 'kehikot.notes'])
    expect(source.standing().stale).toBe(true)
  })

  test('a body that never ends is given up on too', async () => {
    const endless = () => new Response(new ReadableStream({ start() {} }))
    const { source, ids } = world(endless, { timeoutMs: 20 })
    await source.refresh()
    expect(ids()).toEqual(['kehikot.slides', 'kehikot.notes'])
  })

  test('a bad list after a good one leaves the good one in place', async () => {
    const { source, ids, clock, answer } = world(serving([claude]))
    await source.refresh()
    answer(() => new Response('{'))
    clock.at += REFRESH_EVERY_MS
    await source.refresh()
    expect(ids()).toEqual(['kehikot.slides', 'kehikot.notes', 'kehikot.claude'])
    expect(source.standing()).toEqual({ fetched: new Date(1_800_000_000_000).toISOString(), stale: true })
  })
})

describe('the last good list, kept', () => {
  test('it is written beside the machine state and read by a start with no network', async () => {
    const cache = cacheFile()
    const online = world(serving([claude]), { cache })
    await online.source.refresh()
    const kept = JSON.parse(readFileSync(cache, 'utf8'))
    expect(kept).toEqual({ from: URL_, fetched: new Date(1_800_000_000_000).toISOString(), modules: [claude] })
    /* Written beside the target and renamed: nothing half-written is left. */
    expect(readdirSync(join(cache, '..'))).toEqual(['official-modules.json'])

    const offline = world(() => Promise.reject(new Error('offline')), { cache })
    expect(offline.ids()).toEqual(['kehikot.slides', 'kehikot.notes', 'kehikot.claude'])
    await offline.source.refresh()
    expect(offline.ids()).toEqual(['kehikot.slides', 'kehikot.notes', 'kehikot.claude'])
    expect(offline.source.standing()).toEqual({ fetched: kept.fetched, stale: true })
  })

  test('an entry taken off the published list: built in stays, only-fetched stops being offered', async () => {
    const cache = cacheFile()
    const first = world(serving([slides, notes, claude]), { cache })
    await first.source.refresh()
    const later = world(serving([notes]), { cache })
    expect(later.ids()).toContain('kehikot.claude')
    await later.source.refresh()
    expect(later.ids()).toEqual(['kehikot.slides', 'kehikot.notes'])
  })

  test('a cache that is damaged, or was read from somewhere else, is as if it were not there', () => {
    const cache = cacheFile()
    const write = (text: string) => {
      rmSync(join(cache, '..'), { recursive: true, force: true })
      const dir = join(cache, '..')
      mkdirSync(dir, { recursive: true })
      writeFileSync(cache, text)
    }
    const good = { from: URL_, fetched: '2026-10-01T00:00:00.000Z', modules: [claude] }
    write(JSON.stringify(good))
    expect(world(serving([]), { cache }).ids()).toContain('kehikot.claude')

    for (const bad of [
      '{ not json',
      JSON.stringify({ ...good, from: 'https://elsewhere.test/modules.json' }),
      JSON.stringify({ ...good, fetched: 'yesterday' }),
      JSON.stringify({ ...good, modules: [{ ...claude, repo: 'git@evil:x/y' }] }),
    ]) {
      write(bad)
      expect(world(serving([]), { cache }).ids()).toEqual(['kehikot.slides', 'kehikot.notes'])
    }
  })
})

describe('how often it asks', () => {
  test('once every few minutes after a good answer, however often it is opened', async () => {
    const { source, asked, clock, answer, ids } = world(serving([]))
    await source.refresh()
    answer(serving([claude]))
    await source.refresh()
    clock.at += REFRESH_EVERY_MS - 1
    await source.refresh()
    expect(asked).toHaveLength(1)
    expect(ids()).not.toContain('kehikot.claude')
    clock.at += 1
    await source.refresh()
    expect(asked).toHaveLength(2)
    /* The list changed where it is published, and the host has it without a restart. */
    expect(ids()).toContain('kehikot.claude')
  })

  test('sooner after a failure, but still not at once', async () => {
    const { source, asked, clock } = world(() => Promise.reject(new Error('offline')))
    await source.refresh()
    await source.refresh()
    expect(asked).toHaveLength(1)
    clock.at += RETRY_AFTER_MS
    await source.refresh()
    expect(asked).toHaveLength(2)
    expect(RETRY_AFTER_MS).toBeLessThan(REFRESH_EVERY_MS)
    expect(REFRESH_EVERY_MS).toBeGreaterThanOrEqual(2 * 60_000)
  })

  test('two openings at the same moment are one ask', async () => {
    let release: (r: Response) => void = () => {}
    const { source, asked } = world(() => new Promise<Response>((done) => (release = done)))
    const both = [source.refresh(), source.refresh()]
    await new Promise((done) => setTimeout(done, 5))
    release(new Response(JSON.stringify({ modules: [claude] })))
    await Promise.all(both)
    expect(asked).toHaveLength(1)
  })
})

describe('what a changed list does to this machine', () => {
  function desk(list: () => readonly Official[], registered: { id: string; port: number | null; dir?: string }[], origin: (dir: string) => string, protocol = '1.0.0') {
    const calls: string[] = []
    const run: Runner = async (argv): Promise<Ran> => {
      calls.push(argv.join(' '))
      if (argv.includes('get-url')) return { ok: true, out: origin(argv[2]!) }
      return { ok: true, out: '' }
    }
    const base = mkdtempSync(join(tmpdir(), 'kehikot-official-desk-'))
    scratch.push(base)
    return {
      calls,
      registry: join(base, 'modules'),
      desk: installDesk({ list, protocol, run, root: join(base, 'installed'), registry: join(base, 'modules'), registered: async () => registered }),
    }
  }

  test('a new entry is listed and offered, and nothing is installed because it appeared', async () => {
    let list: readonly Official[] = [slides]
    const { desk: d, calls, registry } = desk(() => list, [], () => '')
    expect((await d.list()).map((one) => one.id)).toEqual(['kehikot.slides'])
    list = [slides, claude]
    expect((await d.list()).find((one) => one.id === 'kehikot.claude')).toEqual({ ...claude, installed: false })
    expect(calls).toEqual([])
    expect(existsSync(registry)).toBe(false)
  })

  test('an entry that needs a newer protocol says so and cannot be installed, by the page or by a request', async () => {
    const needs = { ...claude, protocol: '1.1.0' }
    const { desk: d, calls } = desk(() => [slides, needs], [], () => '', '1.0.0')
    const row = (await d.list()).find((one) => one.id === 'kehikot.claude')!
    expect(row.newer).toEqual({ protocol: '1.1.0', has: '1.0.0' })
    expect((await d.list()).find((one) => one.id === 'kehikot.slides')!.newer).toBeUndefined()
    expect(await d.install('kehikot.claude')).toEqual({
      ok: false,
      status: 409,
      why: 'Claude needs a newer Kehikot than this one (protocol 1.1.0; this one has 1.0.0).',
    })
    expect(calls).toEqual([])

    /* The same entry on a host that has what it asks for is an ordinary one. */
    const met = desk(() => [needs], [], () => '', '1.1.0')
    expect((await met.desk.list())[0]!.newer).toBeUndefined()
    expect(await met.desk.install('kehikot.claude')).toMatchObject({ ok: true })
  })

  test('a requirement this host cannot read is one it does not meet', async () => {
    const { desk: d } = desk(() => [{ ...claude, protocol: '>=1.0.0' }], [], () => '', '9.0.0')
    expect((await d.list())[0]!.newer).toEqual({ protocol: '>=1.0.0', has: '9.0.0' })
    expect(await d.install('kehikot.claude')).toMatchObject({ ok: false, status: 409 })
  })

  test('an installed module whose entry now names another repository is not repointed; the list says where it comes from', async () => {
    const dir = '/somewhere/installed/kehikot.slides'
    const moved = { ...slides, repo: 'Somebody/else-entirely' }
    const { desk: d, calls } = desk(() => [moved, notes], [{ id: 'kehikot.slides', port: 7990, dir }, { id: 'kehikot.notes', port: 7940, dir: '/n' }], (at) =>
      at === dir ? 'https://github.com/Jalez/kehikko-slides.git' : 'git@github.com:jalez/Kehikko-Notes.git',
    )
    const rows = await d.list()
    expect(rows.find((one) => one.id === 'kehikot.slides')).toMatchObject({ installed: true, repo: 'Somebody/else-entirely', from: 'Jalez/kehikko-slides' })
    /* The same repository in another spelling is the same repository. */
    expect(rows.find((one) => one.id === 'kehikot.notes')!.from).toBeUndefined()
    expect(await d.install('kehikot.slides')).toMatchObject({ ok: false, status: 409 })
    await d.list()
    /* Read, once per checkout, and nothing else: no clone, no fetch, no remote set. */
    expect(calls).toEqual([`git -C ${dir} remote get-url origin`, 'git -C /n remote get-url origin'])
  })

  test('a clone left in the way from the old repository is never cloned over or pulled into for the new one', async () => {
    const moved = { ...slides, repo: 'Somebody/else-entirely' }
    const w = desk(() => [moved], [], () => 'https://github.com/Jalez/kehikko-slides.git')
    mkdirSync(join(w.registry, '..', 'installed', 'kehikot.slides'), { recursive: true })
    await w.desk.install('kehikot.slides')
    let row = (await w.desk.list())[0]!
    for (let i = 0; i < 100 && row.install?.state !== 'failed'; i++) {
      await new Promise((done) => setTimeout(done, 5))
      row = (await w.desk.list())[0]!
    }
    expect(row.install).toMatchObject({ state: 'failed' })
    expect(w.calls.some((call) => /clone|pull|bun install|set-url/.test(call))).toBe(false)
  })

  test('the page: a line on the installed row, and one quiet line when the list could not be refreshed', () => {
    const presence = { id: 'kehikot.slides', at: 'http://127.0.0.1:7990', condition: 'answering' } as unknown as Presence
    const entry = { id: 'kehikot.slides', name: 'Slides', repo: 'Somebody/else-entirely', summary: '', tags: [], installed: true, from: 'Jalez/kehikko-slides' }
    const [row] = rowsOf([presence], new Set(), [entry])
    expect(row).toMatchObject({ kind: 'registered', elsewhere: { listed: 'Somebody/else-entirely', from: 'Jalez/kehikko-slides' } })
    const [plain] = rowsOf([presence], new Set(), [{ ...entry, from: undefined }])
    expect(plain!.kind === 'registered' && plain!.elsewhere).toBeUndefined()

    expect(staleLine(null)).toBeNull()
    expect(staleLine({ fetched: '2026-10-01T00:00:00.000Z', stale: false })).toBeNull()
    expect(staleLine({ fetched: null, stale: true })).toBe('The official module list could not be refreshed. Showing the one this app came with.')
    expect(staleLine({ fetched: '2026-10-01T12:00:00.000Z', stale: true })).toMatch(/^The official module list could not be refreshed\. Showing the one read on .*2026\.$/)
  })
})
