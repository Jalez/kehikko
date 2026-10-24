import { describe, expect, test } from 'bun:test'

import { LIMITS, SERVER_ASK_PATH, TRAFFIC_REDACTED, trafficReadResult } from 'kehikot-module-protocol'

import { answer, type Grants } from '../server/answers.ts'
import { githubGateway } from '../server/github.ts'
import { serverAskDesk } from '../server/serverAsk.ts'
import {
  because,
  noteFree,
  reasonNow,
  receivedRow,
  recordingFetch,
  recordingSpawn,
  tag,
  takeNotes,
  trafficDoor,
  TrafficRecord,
  untraced,
  type Unnumbered,
} from '../server/traffic.ts'
import { attribute, parseLsof, parseListeners, parseNettop, parsePs, ProcessSampler } from '../server/trafficProcesses.ts'
import { trackerReason } from '../server/trackers/reading.ts'

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'

const row = (more: Partial<Unnumbered> = {}): Unnumbered => ({
  at: 1,
  ms: 1,
  reason: null,
  kind: 'GET',
  host: 'api.example.com',
  path: '/',
  status: 200,
  ok: true,
  by: 'kehikko',
  via: 'server',
  side: 'out',
  reported: 'host',
  ...more,
})

describe('the record', () => {
  test('numbers from 1, keeps the newest, and reads after a cursor', () => {
    const record = new TrafficRecord(3, () => 100)
    for (let i = 0; i < 5; i++) record.add(row({ at: i }))
    expect(record.newest).toBe(5)
    expect(record.oldest).toBe(3)
    const all = record.read(0, 10)
    expect(all.calls.map((one) => one.seq)).toEqual([3, 4, 5])
    expect(all.gap).toBe(false)
    expect(record.read(4, 10).calls.map((one) => one.seq)).toEqual([5])
    expect(record.read(1, 10).gap).toBe(true)
    expect(record.read(0, 2).calls.map((one) => one.seq)).toEqual([3, 4])
    /* A cursor past the newest is a reader of an earlier run: it starts over. */
    expect(record.read(99, 10).calls).toHaveLength(3)
    expect(all.started).toBe(100)
    expect(trafficReadResult.safeParse({ ...all, budgets: [], processes: null }).success).toBe(true)
  })

  test('a row that does not fit the shape is dropped, not clipped', () => {
    const record = new TrafficRecord()
    expect(record.add(row({ reason: 'x'.repeat(LIMITS.TRAFFIC_REASON + 1) }))).toBeNull()
    expect(record.newest).toBe(0)
  })

  test('keeps LIMITS.TRAFFIC_KEPT by default', () => expect(new TrafficRecord().kept).toBe(LIMITS.TRAFFIC_KEPT))
})

describe('the reason', () => {
  test('travels across awaits, innermost first', async () => {
    expect(reasonNow()).toBeNull()
    await because('update check', async () => {
      await new Promise((done) => setTimeout(done, 1))
      expect(reasonNow()).toBe('update check')
      await because('release tags', async () => {
        await Promise.resolve()
        expect(reasonNow()).toBe('release tags')
      })
      expect(reasonNow()).toBe('update check')
    })
  })

  test('a tracker read says whose project and how much', () => {
    expect(trackerReason('/work/portal', { project: true })).toBe('tracker read: portal (whole project)')
    expect(trackerReason('/work/portal', { refs: ['gh#1'] })).toBe('tracker read: portal (1 ref)')
    expect(trackerReason('/work/portal', { epic: 'launch' })).toBe('tracker read: portal (epic launch)')
  })
})

describe('the host’s own calls', () => {
  const answering = (status: number, headers: Record<string, string> = {}) =>
    (async () => new Response('the body is never read', { status, headers })) as unknown as typeof fetch

  test('fetch is recorded with its reason, sanitized, and the body left alone', async () => {
    const record = new TrafficRecord()
    let clock = 0
    const traced = recordingFetch(record, answering(200, { 'content-length': '22' }), () => (clock += 10))
    const response = await because('the official module list', () => traced(`https://user:${TOKEN}@raw.githubusercontent.com/Jalez/kehikko/main/modules.json?token=${TOKEN}`))
    expect(await response.text()).toBe('the body is never read')
    const [one] = record.read(0, 10).calls
    expect(one).toMatchObject({
      by: 'kehikko',
      via: 'server',
      side: 'out',
      reported: 'host',
      reason: 'the official module list',
      kind: 'GET',
      host: 'raw.githubusercontent.com',
      path: `/Jalez/kehikko/main/modules.json?token=${TRAFFIC_REDACTED}`,
      status: 200,
      ok: true,
      ms: 10,
      bytesIn: 22,
    })
    expect(JSON.stringify(record.read(0, 10))).not.toContain('ghp_')
  })

  test('a 304 is not-modified; a failure is recorded and still thrown; untraced is not recorded', async () => {
    const record = new TrafficRecord()
    await recordingFetch(record, answering(304))('https://api.github.com/repos/a/b/releases')
    const failing = recordingFetch(record, (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch)
    await expect(failing('https://api.github.com/x', { method: 'POST', body: 'abc' })).rejects.toThrow('offline')
    await untraced(() => recordingFetch(record, answering(200))('http://127.0.0.1:8070/api/kehikot/server-pass?pass=x'))
    const calls = record.read(0, 10).calls
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ status: 304, ok: true, cache: 'not-modified' })
    expect(calls[1]).toMatchObject({ kind: 'POST', ok: false, status: null, bytesOut: 3 })
  })

  test('a program run is recorded when it went over the network, with its exit code', async () => {
    const record = new TrafficRecord()
    const spawned = recordingSpawn(record, { spawn: Bun.spawn, spawnSync: Bun.spawnSync })
    const fake = (code: number) => ({ exited: Promise.resolve(code), exitCode: code }) as unknown as ReturnType<typeof Bun.spawn>
    const inner = { spawn: ((argv: string[]) => fake(argv.includes('broken') ? 128 : 0)) as unknown as typeof Bun.spawn, spawnSync: Bun.spawnSync }
    const traced = recordingSpawn(record, inner)
    await because('release tags', async () => {
      await traced.spawn(['git', 'ls-remote', '--tags', `https://x:${TOKEN}@github.com/a/b.git`]).exited
      await traced.spawn(['git', '-C', '/p', 'rev-parse', 'HEAD']).exited
      await traced.spawn(['gh', 'api', 'repos/a/b/releases', 'broken']).exited
    })
    await new Promise((done) => setTimeout(done, 1))
    const calls = record.read(0, 10).calls
    expect(calls.map((one) => [one.kind, one.host, one.path, one.status, one.reason])).toEqual([
      ['git ls-remote', 'github.com', '/a/b.git', 0, 'release tags'],
      ['gh api', 'api.github.com', '/repos/a/b/releases', 128, 'release tags'],
    ])
    expect(typeof spawned.spawn).toBe('function')
  })

  test('the GitHub gateway’s held-back call is recorded as refused, and nothing is sent', async () => {
    const record = new TrafficRecord()
    let sent = 0
    const gateway = githubGateway({
      budget: 0,
      fetch: (async () => {
        sent++
        return Response.json([])
      }) as unknown as typeof fetch,
      held: (url) => noteFree(record, url, 'refused'),
    })
    const got = await gateway.api('/repos/a/b/releases', 3)
    expect(got.ok).toBe(false)
    expect(sent).toBe(0)
    expect(record.read(0, 10).calls[0]).toMatchObject({ cache: 'refused', host: 'api.github.com', path: '/repos/a/b/releases', ms: 0 })
    expect(gateway.stats().frees).toBeNull()
  })
})

describe('what modules note', () => {
  test('sanitized again, and filed under the module as its own report', () => {
    const record = new TrafficRecord()
    const said = takeNotes(record, 'kehikot.paper', 'server', [
      { at: 1, ms: 3, reason: 'compile', kind: 'POST', host: 'Latex.Example.com', path: `/run/${TOKEN}?key=abc`, status: 200, ok: true },
      { at: 2, ms: null, reason: null, kind: 'GET', host: 'not a host/at all', path: '/', status: null, ok: null },
    ])
    expect(said).toEqual({ outcome: 'taken', taken: 2, why: '' })
    const [first, second] = record.read(0, 10).calls
    expect(first).toMatchObject({ by: 'kehikot.paper', via: 'server', side: 'out', reported: 'module', host: 'latex.example.com', path: `/run/${TRAFFIC_REDACTED}?key=${TRAFFIC_REDACTED}` })
    expect(second!.host).toBe('')
  })
})

describe('what this host receives', () => {
  const from = { pageOrigins: ['http://127.0.0.1:4181'], portOwner: (port: number) => (port === 51000 ? 'kehikot.kanban' : null) }
  const ok = new Response('{}', { status: 200, headers: { 'content-length': '2' } })

  test('the page by its origin, with the route’s reason and no query values', () => {
    const request = new Request('http://127.0.0.1:4180/host/quiet?project=12&kehikko=3', { headers: { origin: 'http://127.0.0.1:4181' } })
    expect(receivedRow(request, ok, 5, 2.4, from, null)).toMatchObject({
      by: 'kehikko',
      via: 'page',
      side: 'in',
      reported: 'host',
      reason: 'the page asks whether modules are quiet',
      kind: 'GET',
      host: '127.0.0.1:4180',
      path: `/host/quiet?project=${TRAFFIC_REDACTED}&kehikko=${TRAFFIC_REDACTED}`,
      ms: 2,
      bytesOut: 2,
    })
  })

  test('a module’s call relayed by the page is the module’s, with its method', () => {
    const request = new Request('http://127.0.0.1:4180/host/call', { method: 'POST', headers: { origin: 'http://127.0.0.1:4181' } })
    tag(request, { by: 'kehikot.kanban', via: 'page', reason: 'tracker.get' })
    expect(receivedRow(request, ok, 5, 1, from, null)).toMatchObject({ by: 'kehikot.kanban', via: 'page', reason: 'tracker.get', path: '/host/call' })
    const reading = new Request('http://127.0.0.1:4180/host/call', { method: 'POST' })
    tag(reading, { by: 'kehikot.monitor', skip: true })
    expect(receivedRow(reading, ok, 5, 1, from, null)).toBeNull()
  })

  test('a program: named in the query, else by the port the sampler saw, else nobody', () => {
    const named = new Request('http://127.0.0.1:4180/host/settings-pass?module=kehikot.kanban&pass=secret')
    expect(receivedRow(named, ok, 5, 1, from, null)).toMatchObject({ by: 'kehikot.kanban', via: 'server', path: `/host/settings-pass?module=${TRAFFIC_REDACTED}&pass=${TRAFFIC_REDACTED}` })
    const byPort = new Request('http://127.0.0.1:4180/host/is-project?path=/Users/me/secret-project')
    expect(receivedRow(byPort, ok, 5, 1, from, { port: 51000 })).toMatchObject({ by: 'kehikot.kanban', via: 'server', reason: 'a module asks whether a folder is a project' })
    expect(JSON.stringify(receivedRow(byPort, ok, 5, 1, from, { port: 51000 }))).not.toContain('secret-project')
    expect(receivedRow(byPort, ok, 5, 1, from, { port: 1 })!.by).toBe('')
  })
})

describe('traffic.read and traffic.note, held to the manifest', () => {
  const ME = 'kehikot.monitor'
  const known = (id: string) => id === ME || id === 'kehikot.kanban'
  const grants = (uses: string[]): Grants => ({ may: (_module, capability) => uses.includes(capability) })
  const record = new TrafficRecord()
  record.add(row())
  let wanted = 0
  const door = trafficDoor({
    record,
    budgets: () => [{ name: 'GitHub API without an account', used: 2, limit: 30, left: 28, resets: null, note: '' }],
    processes: (want) => {
      if (want) wanted++
      return { on: want, bytes: true, at: 1, why: '', connections: [] }
    },
  })
  const ask = (module: string, method: string, params: unknown, uses: string[]) =>
    answer(module, method, params, known, undefined, null, undefined, null, null, null, grants(uses), { door, via: 'page' })

  test('a module that did not ask for traffic:read is refused, and nothing is read', () => {
    const said = ask('kehikot.kanban', 'traffic.read', {}, ['trackers:read'])
    expect(said.ok).toBe(false)
    if (!said.ok) expect(said.error).toContain('traffic:read')
  })

  test('the Monitor reads the rows, the budgets, and the processes only when it samples', () => {
    const plain = ask(ME, 'traffic.read', {}, ['traffic:read'])
    expect(plain.ok && (plain.data as { calls: unknown[]; processes: unknown }).calls).toHaveLength(1)
    expect(plain.ok && (plain.data as { processes: unknown }).processes).toBeNull()
    expect(wanted).toBe(0)
    const sampled = ask(ME, 'traffic.read', { sample: true, since: 0 }, ['traffic:read'])
    expect(sampled.ok && (sampled.data as { processes: { on: boolean } }).processes.on).toBe(true)
    expect(wanted).toBe(1)
  })

  test('noting needs traffic:report, and is filed as the module’s', () => {
    const calls = [{ at: 1, kind: 'GET', host: 'api.example.com', path: '/x' }]
    expect(ask('kehikot.kanban', 'traffic.note', { calls }, []).ok).toBe(false)
    const said = ask('kehikot.kanban', 'traffic.note', { calls }, ['traffic:report'])
    expect(said.ok && said.data).toEqual({ outcome: 'taken', taken: 1, why: '' })
    expect(record.read(1, 10).calls[0]).toMatchObject({ by: 'kehikot.kanban', via: 'page', reported: 'module' })
  })
})

describe('the process sampler', () => {
  const PS = [
    '  1     0     1 launchd',
    '  500   1   500 bun',
    '  600 500   600 bash',
    '  601 600   600 bun',
    '  700 601   700 Google Chrome',
    '  800   1   800 zen',
    '  900 500   500 git',
  ].join('\n')

  test('a module’s group and everything under it is the module’s; the rest under the host is the host’s', () => {
    const owner = attribute(parsePs(PS), [['kehikot.browser', 600]], 500)
    expect(owner.get(600)).toBe('kehikot.browser')
    expect(owner.get(601)).toBe('kehikot.browser')
    expect(owner.get(700)).toBe('kehikot.browser')
    expect(owner.get(500)).toBe('kehikko')
    expect(owner.get(900)).toBe('kehikko')
    expect(owner.has(800)).toBe(false)
  })

  const NETTOP = [
    ',bytes_in,bytes_out,',
    'bun.601,1000,2000,',
    'tcp4 127.0.0.1:8020<->*:*,,,',
    'tcp4 127.0.0.1:8020<->127.0.0.1:55001,10,20,',
    'tcp4 127.0.0.1:51000<->127.0.0.1:4180,300,400,',
    'Google Chrome.700,5000,600,',
    'tcp4 192.168.1.2:52000<->140.82.112.6:443,4000,500,',
    'tcp6 fe80::1%en0.52001<->2606:4700::6810.443,7,8,',
    'udp4 *:63738<->*:*,,,',
    'bun.500,10,10,',
    'tcp4 127.0.0.1:52100<->127.0.0.1:8020,10,10,',
  ].join('\n')

  test('nettop’s lines are read', () => {
    const sockets = parseNettop(NETTOP)
    expect(sockets).toHaveLength(7)
    expect(sockets[3]).toEqual({ pid: 700, process: 'Google Chrome', proto: 'tcp', localHost: '192.168.1.2', localPort: 52000, remoteHost: '140.82.112.6', remotePort: 443, bytesIn: 4000, bytesOut: 500 })
    expect(sockets[4]).toMatchObject({ remoteHost: '2606:4700::6810', remotePort: 443 })
  })

  test('lsof’s fields are read, listeners included; listeners by port', () => {
    const sockets = parseLsof(['p601', 'cbun', 'PTCP', 'n127.0.0.1:8020', 'n127.0.0.1:51000->127.0.0.1:4180'].join('\n'))
    expect(sockets.map((one) => [one.localPort, one.remoteHost, one.remotePort])).toEqual([
      [8020, '*', 0],
      [51000, '127.0.0.1', 4180],
    ])
    expect(parseListeners(['p601', 'f10', 'n127.0.0.1:8020', 'p500', 'n*:4180'].join('\n'))).toEqual(
      new Map([
        [8020, 601],
        [4180, 500],
      ]),
    )
  })

  test('a look attributes each outgoing connection to its module, once, with no reason; the host’s own on this computer are already recorded', async () => {
    const record = new TrafficRecord()
    const sampler = new ProcessSampler({
      record,
      self: 500,
      now: () => 1000,
      roots: async () => [['kehikot.browser', 600]],
      run: async (argv) => (argv[0] === 'ps' ? PS : argv[0] === 'nettop' ? NETTOP : null),
      name: async (address) => (address === '140.82.112.6' ? 'lb-140-82-112-6-iad.github.com' : null),
    })
    sampler.want()
    sampler.stop()
    const seen = await sampler.look()
    expect(seen.bytes).toBe(true)
    expect(seen.connections.map((one) => [one.by, one.process, one.remote, one.port, one.local])).toEqual([
      ['kehikot.browser', 'bun', '127.0.0.1', 4180, true],
      ['kehikot.browser', 'Google Chrome', 'lb-140-82-112-6-iad.github.com', 443, false],
      ['kehikot.browser', 'Google Chrome', '2606:4700::6810', 443, false],
    ])
    const rows = record.read(0, 10).calls
    expect(rows).toHaveLength(3)
    expect(rows[1]).toMatchObject({ by: 'kehikot.browser', via: 'process', side: 'seen', reported: 'sampled', reason: null, kind: 'tcp', host: 'lb-140-82-112-6-iad.github.com:443', bytesIn: 4000 })
    /* The same connections at the next look are not new. */
    await sampler.look()
    expect(record.newest).toBe(3)
  })

  test('without nettop it lists connections without bytes, and says so', async () => {
    const sampler = new ProcessSampler({
      record: new TrafficRecord(),
      self: 500,
      roots: async () => [['kehikot.browser', 600]],
      run: async (argv) => (argv[0] === 'ps' ? PS : argv[0] === 'lsof' ? ['p700', 'cGoogle Chrome', 'PTCP', 'n192.168.1.2:52000->140.82.112.6:443'].join('\n') : null),
      name: async () => null,
    })
    const seen = await sampler.look()
    expect(seen.bytes).toBe(false)
    expect(seen.why).toContain('without the bytes')
    expect(seen.connections).toHaveLength(1)
    expect(seen.connections[0]!.bytesIn).toBeUndefined()
  })
})

describe('a module’s server asking about traffic (/host/server-ask, protocol 2.20.0)', () => {
  const PASS = 'p'.repeat(40)
  const record = new TrafficRecord()
  record.add(row())
  const door = trafficDoor({ record, budgets: () => [], processes: () => null })
  const desk = (uses: Record<string, string[]>) => {
    const vouched: string[] = []
    const route = serverAskDesk({
      known: (id) => id in uses,
      originOf: async (id) => (id in uses ? 'http://127.0.0.1:8070' : null),
      may: (module, capability) => (uses[module] ?? []).includes(capability),
      projectAt: () => null,
      answer: (module, method, params, root) => answer(module, method, params, (id) => id in uses, undefined, root, undefined, null, null, null, { may: (m, c) => (uses[m] ?? []).includes(c) }, { door, via: 'server' }),
      fetch: (async (url: string) => {
        vouched.push(url)
        return Response.json({ ok: true, minted: new URL(url).searchParams.get('pass') === PASS })
      }) as unknown as typeof fetch,
    }).route
    return { route, vouched }
  }
  const ask = async (route: ReturnType<typeof desk>['route'], body: unknown) => {
    const request = new Request(`http://127.0.0.1:4170${SERVER_ASK_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const response = await route(request, new URL(request.url))
    return { request, body: (await response!.json()) as Record<string, unknown> }
  }

  test('the Monitor reads the record with no project; the read is not itself recorded', async () => {
    const { route } = desk({ 'kehikot.monitor': ['traffic:read'] })
    const said = await ask(route, { module: 'kehikot.monitor', pass: PASS, method: 'traffic.read', params: {} })
    expect(said.body.ok).toBe(true)
    expect((said.body.data as { calls: unknown[] }).calls).toHaveLength(1)
    expect(receivedRow(said.request, new Response('{}'), 1, 1, { pageOrigins: [] }, null)).toBeNull()
  })

  test('a module that did not declare traffic:read is refused, and reads nothing', async () => {
    const { route } = desk({ 'kehikot.kanban': ['trackers:read'] })
    const said = await ask(route, { module: 'kehikot.kanban', pass: PASS, method: 'traffic.read', params: {} })
    expect(said.body).toMatchObject({ ok: false, refused: 'grant' })
    expect(String(said.body.error)).toContain('traffic:read')
  })

  test('a module notes its own calls from its server, filed as its own', async () => {
    const { route } = desk({ 'kehikot.paper': ['traffic:report'] })
    const said = await ask(route, { module: 'kehikot.paper', pass: PASS, method: 'traffic.note', params: { calls: [{ at: 5, kind: 'POST', host: 'latex.example.com', path: `/compile?token=${TOKEN}`, reason: 'compile' }] } })
    expect(said.body).toEqual({ ok: true, data: { outcome: 'taken', taken: 1, why: '' } })
    expect(record.read(1, 10).calls[0]).toMatchObject({ by: 'kehikot.paper', via: 'server', reported: 'module', path: `/compile?token=${TRAFFIC_REDACTED}` })
  })

  test('a tracker question still has to name its project', async () => {
    const { route } = desk({ 'kehikot.kanban': ['trackers:read'] })
    const request = new Request(`http://127.0.0.1:4170${SERVER_ASK_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ module: 'kehikot.kanban', pass: PASS, method: 'tracker.get', params: { project: true } }) })
    expect((await route(request, new URL(request.url)))!.status).toBe(400)
  })
})

describe('a call answered from a cache', () => {
  test('is a hit with nothing sent, and a git remote is cut to its host and path', () => {
    const record = new TrafficRecord()
    noteFree(record, `https://x:${TOKEN}@github.com/a/b.git`, 'hit', 'git ls-remote')
    expect(record.read(0, 1).calls[0]).toMatchObject({ cache: 'hit', ok: true, ms: 0, kind: 'git ls-remote', host: 'github.com', path: '/a/b.git' })
  })
})
