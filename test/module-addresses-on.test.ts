import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import { manifestSchema, WELL_KNOWN } from 'kehikot-module-protocol'
import { doorsFetch, establishBuild } from 'kehikot-module-protocol/serve'

import { addressesUsable, checkAddresses, framedOn, onAddresses, resetAddressCheck } from '@/host/addressCheck.ts'
import {
  ADDRESS_CHECK_PATH,
  frameOfHost,
  frameOriginFor,
  labelFor,
  machineBaseFor,
  routeOf,
  sameVersion,
  stableDoorUrl,
  stableEntry,
  versionSlug,
} from '@/host/moduleAddress.ts'
import { ModuleProxy, moduleSockets, SOCKET_BUFFER_MOST, type ClientSocket, type ProxyTarget, type SocketData } from '../server/moduleProxy.ts'
import { moduleAddresses } from '../server/moduleAddresses.ts'
import { own, PAGE_ONLY, refusal } from '../server/guard.ts'

/** Phase 3: pinned versions' addresses, agents' doors, the page's self-check, and bounded sockets. */

const ID = 'kehikot.example'
const TAG = 'v1.2.0'

function aModule(token: string | null = null) {
  const seen: Array<{ path: string; origin: string | null }> = []
  const manifest = manifestSchema.parse({
    kind: 'kehikot.module',
    protocol: 2,
    id: ID,
    name: 'Example',
    version: '1.2.0',
    entry: '/app',
    modes: [{ id: 'main', label: 'Main' }],
    partless: 'An example with nothing in it that belongs to a part.',
  })
  const doors = doorsFetch({
    manifest,
    build: establishBuild({ version: '1.2.0', commit: null, start: token }),
    page: { title: 'Example' },
    answer: async (method, path) => (path === '/api/echo' ? { status: 200, body: { ok: true } } : null),
  })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      seen.push({ path: new URL(request.url).pathname, origin: request.headers.get('origin') })
      return (await doors(request)) ?? new Response('Not found', { status: 404 })
    },
  })
  return { origin: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) }
}

describe('a pinned version has addresses of its own', () => {
  test('at--<tag>.<label> for a frame, /m/<id>@<tag> for a program', () => {
    expect(versionSlug('v1.2.0')).toBe('v1-2-0')
    expect(versionSlug('...')).toBeNull()
    expect(frameOriginFor(ID, 4170, TAG)).toBe('http://at--v1-2-0.example.kehikot.localhost:4170')
    expect(frameOriginFor(ID, 4170, TAG)).not.toBe(frameOriginFor(ID, 4170))
    expect(frameOfHost('at--v1-2-0.example.kehikot.localhost:4170')).toEqual({ id: ID, version: 'v1-2-0' })
    expect(frameOfHost('at--v1-2-0.someone.tool.kehikot.localhost:4170')).toEqual({ id: 'someone.tool', version: 'v1-2-0' })
    expect(frameOfHost('at--.example.kehikot.localhost:4170')).toBeNull()
    expect(frameOfHost('at--v1.kehikot.localhost:4170')).toBeNull()
    expect(labelFor('someone.at--x')).toBeNull()
    expect(machineBaseFor(ID, 4170, TAG)).toBe('http://127.0.0.1:4170/m/kehikot.example@v1.2.0')
    expect(routeOf('127.0.0.1:4170', '/m/kehikot.example@v1.2.0/mcp')).toEqual({ kind: 'machine', id: ID, version: TAG, path: '/mcp' })
    expect(routeOf('127.0.0.1:4170', '/m/kehikot.example@/mcp')).toBeNull()
    expect(sameVersion('v1-2-0', TAG)).toBe(true)
    expect(sameVersion(TAG, TAG)).toBe(true)
    expect(sameVersion('v1-3-0', TAG)).toBe(false)
  })

  test("an agent's door is its path under the program address; an entry moves onto the frame address", () => {
    expect(stableDoorUrl(ID, 'http://127.0.0.1:7920/mcp?x=1', 4170)).toBe('http://127.0.0.1:4170/m/kehikot.example/mcp?x=1')
    expect(stableDoorUrl(ID, 'not a url', 4170)).toBeNull()
    expect(stableEntry('http://127.0.0.1:7920/app?theme=dark#top', 'http://example.kehikot.localhost:4170')).toBe('http://example.kehikot.localhost:4170/app?theme=dark#top')
  })
})

describe('through the proxy', () => {
  const targets = new Map<string, ProxyTarget>()
  let stale: ProxyTarget | null = null
  const deps = {
    port: 0,
    check: 'this-start',
    target: (wanted: { id: string; version?: string }, fresh: boolean): ProxyTarget | null => {
      if (wanted.version) return sameVersion(wanted.version, TAG) ? (targets.get(`${wanted.id}@${TAG}`) ?? null) : null
      if (!fresh && stale) return stale
      return targets.get(wanted.id) ?? null
    },
  }
  const proxy = new ModuleProxy(deps)
  let host: ReturnType<typeof Bun.serve>
  let ownHosts: ReadonlySet<string> = new Set()
  beforeAll(() => {
    host = Bun.serve<SocketData>({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request, srv) {
        const answered = await proxy.handle(request, srv, ownHosts)
        if (answered === 'upgraded') return undefined
        return answered ?? new Response('the host itself')
      },
      websocket: { message() {} },
    })
    deps.port = host.port!
    ownHosts = own({}, host.port!, []).hosts
  })
  afterEach(() => {
    targets.clear()
    stale = null
    proxy.forget()
  })
  afterAll(() => host.stop(true))

  const at = (name: string, path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    fetch(`http://127.0.0.1:${host.port}${path}`, { ...init, headers: { host: `${name}:${host.port}`, ...(init.headers ?? {}) } })

  test("a pinned version, at its frame address and its program address, with its own origin rewritten", async () => {
    const version = aModule()
    try {
      targets.set(`${ID}@${TAG}`, { origin: version.origin, token: null })
      const framed = new URL(frameOriginFor(ID, host.port!, TAG)!)
      const posted = await at(framed.hostname, '/api/echo', { method: 'POST', headers: { origin: framed.origin, 'content-type': 'application/json' }, body: '{}' })
      expect(posted.status).toBe(200)
      expect(version.seen.at(-1)!.origin).toBe(version.origin)
      const program = await fetch(`${machineBaseFor(ID, host.port!, TAG)}/api/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      expect(program.status).toBe(200)
      const other = await at(new URL(frameOriginFor(ID, host.port!, 'v9.9.9')!).hostname, '/app')
      expect(other.status).toBe(404)
      expect(await other.text()).toContain('No version v9-9-9')
    } finally {
      version.stop()
    }
  })

  test('the self-check is answered by the host under any frame name, never forwarded', async () => {
    const module = aModule()
    try {
      targets.set(ID, { origin: module.origin, token: null })
      for (const name of ['at--self-check.kehikot.localhost', 'example.kehikot.localhost', 'nobody.kehikot.localhost']) {
        const response = await at(name, ADDRESS_CHECK_PATH)
        expect(response.status).toBe(200)
        expect(response.headers.get('access-control-allow-origin')).toBe('*')
        expect(await response.json()).toEqual({ host: 'this-start' })
      }
      expect(module.seen.some((one) => one.path === ADDRESS_CHECK_PATH)).toBe(false)
      /* Not under this host's own name: there it is nothing of the proxy's. */
      expect(await (await fetch(`http://127.0.0.1:${host.port}${ADDRESS_CHECK_PATH}`)).text()).toBe('the host itself')
    } finally {
      module.stop()
    }
  })

  test('a module that moved port since the last sweep is found by reading its registration again', async () => {
    const module = aModule()
    const gone = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('x') })
    const port = gone.port
    gone.stop(true)
    try {
      stale = { origin: `http://127.0.0.1:${port}`, token: null }
      targets.set(ID, { origin: module.origin, token: null })
      expect((await at('example.kehikot.localhost', '/app')).status).toBe(200)
    } finally {
      module.stop()
    }
  })
})

describe('relayed sockets are bounded', () => {
  /** A module's side of a socket, as much as the relay uses. */
  function upstreamLike() {
    const target = new EventTarget() as EventTarget & { readyState: number; bufferedAmount: number; sent: unknown[]; closed: number | null; send(data: unknown): void; close(code?: number): void }
    target.readyState = 1
    target.bufferedAmount = 0
    target.sent = []
    target.closed = null
    target.send = (data) => void target.sent.push(data)
    target.close = (code) => {
      target.closed = code ?? 1000
      target.readyState = 3
    }
    return target
  }
  function clientLike(data: SocketData, buffered: () => number, sent = 1) {
    const client = { data, closed: null as number | null, got: [] as unknown[], send: (payload: unknown) => (client.got.push(payload), sent), close: (code?: number) => void (client.closed = code ?? 1000), getBufferedAmount: buffered }
    return client
  }
  const message = (data: string) => Object.assign(new Event('message'), { data })

  test('a client that falls too far behind is closed, both sides, 1013', () => {
    const upstream = upstreamLike()
    const data = moduleSockets.data(upstream as unknown as WebSocket)
    let behind = 0
    const client = clientLike(data, () => behind)
    moduleSockets.open(client as unknown as ClientSocket)
    upstream.dispatchEvent(message('one'))
    expect(client.got).toEqual(['one'])
    expect(client.closed).toBeNull()
    behind = SOCKET_BUFFER_MOST + 1
    upstream.dispatchEvent(message('two'))
    expect(upstream.closed).toBe(1013)
    expect(client.closed).toBe(1013)
  })

  test('a dropped send closes too', () => {
    const upstream = upstreamLike()
    const data = moduleSockets.data(upstream as unknown as WebSocket)
    const client = clientLike(data, () => 0, 0)
    moduleSockets.open(client as unknown as ClientSocket)
    upstream.dispatchEvent(message('one'))
    expect(client.closed).toBe(1013)
  })

  test('a module that does not read what the client sends is closed the same way', () => {
    const upstream = upstreamLike()
    const data = moduleSockets.data(upstream as unknown as WebSocket)
    const client = clientLike(data, () => 0)
    moduleSockets.open(client as unknown as ClientSocket)
    moduleSockets.message(client as unknown as ClientSocket, 'ls')
    expect(upstream.sent).toEqual(['ls'])
    upstream.bufferedAmount = SOCKET_BUFFER_MOST + 1
    moduleSockets.message(client as unknown as ClientSocket, 'more')
    expect(upstream.closed).toBe(1013)
    expect(client.closed).toBe(1013)
  })

  test('what arrives before the client opens is bounded in bytes as well as messages', () => {
    const upstream = upstreamLike()
    moduleSockets.data(upstream as unknown as WebSocket)
    upstream.dispatchEvent(message('x'.repeat(SOCKET_BUFFER_MOST)))
    expect(upstream.closed).toBe(1011)
  })
})

describe("the page's self-check", () => {
  const SAID = { on: true, frames: true, check: { url: 'http://at--self-check.kehikot.localhost:4170/.well-known/kehikot-host-check', host: 'nonce' } }
  const posted: unknown[] = []
  const fake = (check: () => Response | Promise<Response>, said: unknown = SAID): typeof fetch =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/host/module-addresses') return said === 404 ? new Response('', { status: 404 }) : Response.json(said)
      if (url === '/host/module-addresses/check') {
        posted.push(JSON.parse(String(init?.body)))
        return Response.json({ ok: true })
      }
      return check()
    }) as typeof fetch
  afterEach(() => {
    resetAddressCheck()
    posted.length = 0
  })
  const view = {
    presences: [{ id: ID, module: { entry: 'http://127.0.0.1:7920/app', address: 'http://example.kehikot.localhost:4170' } }, { id: 'x', module: { entry: 'http://127.0.0.1:7930/app' } }],
    pins: [{ presence: { module: { entry: 'http://127.0.0.1:9000/app', address: 'http://at--v1-2-0.example.kehikot.localhost:4170' } } }, { presence: null }],
  }

  test('the host answering there: frames move onto their addresses, pinned versions too', async () => {
    const found = await checkAddresses(fake(() => Response.json({ host: 'nonce' })))
    expect(found.usable).toBe(true)
    expect(addressesUsable()).toBe(true)
    const moved = onAddresses(view)
    expect(moved.presences[0]!.module!.entry).toBe('http://example.kehikot.localhost:4170/app')
    expect(moved.presences[1]!.module!.entry).toBe('http://127.0.0.1:7930/app')
    expect(moved.pins[0]!.presence!.module!.entry).toBe('http://at--v1-2-0.example.kehikot.localhost:4170/app')
    expect(posted).toEqual([])
  })

  test('another program answering there: frames stay on their own origins, and why is said', async () => {
    const found = await checkAddresses(fake(() => Response.json({ host: 'someone else' })))
    expect(found.usable).toBe(false)
    expect(onAddresses(view)).toBe(view)
    expect(framedOn(view.presences[0]!.module!).entry).toBe('http://127.0.0.1:7920/app')
    expect(posted).toEqual([{ ok: false, why: expect.stringContaining('Another program answered') }])
  })

  test('the name not reaching anything: fallen back, with the reason', async () => {
    const found = await checkAddresses(fake(() => Promise.reject(new TypeError('Could not connect'))))
    expect(found.usable).toBe(false)
    expect(found.why).toContain('could not be reached')
    expect(posted).toHaveLength(1)
  })

  test('the host holding no [::1]: fallen back with the host’s reason', async () => {
    const found = await checkAddresses(fake(() => Response.json({}), { on: true, frames: false, why: 'could not listen on [::1]' }))
    expect(found).toEqual({ usable: false, why: 'could not listen on [::1]' })
  })

  test('addresses off, or an older host: nothing to check and nothing said', async () => {
    expect((await checkAddresses(fake(() => Response.json({}), { on: false, frames: false }))).usable).toBe(false)
    resetAddressCheck()
    expect((await checkAddresses(fake(() => Response.json({}), 404))).usable).toBe(false)
    expect(posted).toEqual([])
  })

  test('asked once per page', async () => {
    let asked = 0
    const counting = fake(() => (asked += 1, Response.json({ host: 'nonce' })))
    await Promise.all([checkAddresses(counting), checkAddresses(counting)])
    await checkAddresses(counting)
    expect(asked).toBe(1)
  })
})

describe('what the host says about the addresses', () => {
  afterEach(() => moduleAddresses.reset())

  test('where to check, only when frames may have addresses', () => {
    moduleAddresses.held(4170)
    expect(moduleAddresses.said(true, 'nonce').check).toEqual({ url: `http://at--self-check.kehikot.localhost:4170${ADDRESS_CHECK_PATH}`, host: 'nonce' })
    moduleAddresses.notHeld(4170, 'EADDRINUSE')
    expect(moduleAddresses.said(true, 'nonce').check).toBeUndefined()
  })

  test("a page's failed check is kept and said", () => {
    moduleAddresses.held(4170)
    moduleAddresses.checked(false, 'could not be reached')
    expect(moduleAddresses.said(true, 'nonce').checked).toEqual({ ok: false, why: 'could not be reached' })
  })

  test("only the page reports its check: a program's report is refused", () => {
    expect(PAGE_ONLY).toContain('/host/module-addresses/check')
    const self = own({}, 4170, ['http://127.0.0.1:4170'])
    const headers = new Headers({ host: '127.0.0.1:4170', 'content-type': 'application/json' })
    expect(refusal({ method: 'POST', pathname: '/host/module-addresses/check', headers }, self)?.status).toBe(403)
    headers.set('origin', 'http://127.0.0.1:4170')
    expect(refusal({ method: 'POST', pathname: '/host/module-addresses/check', headers }, self)).toBeNull()
  })
})

describe('the manifest probe is not the check', () => {
  test('WELL_KNOWN is forwarded as any path is', () => expect(WELL_KNOWN).not.toBe(ADDRESS_CHECK_PATH))
})
