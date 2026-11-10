import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { manifestSchema, MESSAGE_PREFIX, START_HEADER, WELL_KNOWN, type Manifest } from 'kehikot-module-protocol'
import { doorsFetch, establishBuild } from 'kehikot-module-protocol/serve'
import { hostFence, socketFence } from 'kehikot-module-protocol/run'

import { Conversation } from '@/host/conversation.ts'
import { frameOriginFor, idOfHost, isModuleHost, labelFor, machineBaseFor, routeOf } from '@/host/moduleAddress.ts'
import { ModuleProxy, moduleSockets, type ProxyTarget, type SocketData } from '../server/moduleProxy.ts'
import { addressesOn, moduleAddresses } from '../server/moduleAddresses.ts'
import { own, refusal } from '../server/guard.ts'
import { mintStartToken, Nursery, start } from '../server/launch.ts'

/**
 * Modules reached at stable addresses on the host (phase 2): a frame's `<label>.kehikot.localhost`,
 * a program's `/m/<id>/…`, both forwarded only to the process that is the module.
 */

const ID = 'kehikot.example'
const TOKEN_A = 'a'.repeat(32)
const TOKEN_B = 'b'.repeat(32)

const manifestFor = (id: string): Manifest =>
  manifestSchema.parse({
    kind: 'kehikot.module',
    protocol: 2,
    id,
    name: 'Example',
    version: '1.0.0',
    entry: '/app',
    modes: [{ id: 'main', label: 'Main' }],
    partless: 'An example with nothing in it that belongs to a part.',
  })

/**
 * A module as the protocol serves one with `run`: `hostFence` first, the doors, and a WebSocket at
 * `/term` held to `socketFence`. Whatever it was asked is written down, so a test sees the request
 * the module got.
 */
function aModule(options: { id?: string; token?: string | null; port?: number } = {}) {
  const seen: Array<{ path: string; host: string | null; origin: string | null }> = []
  const build = establishBuild({ version: '1.0.0', commit: null, start: options.token ?? null })
  const doors = doorsFetch({
    manifest: manifestFor(options.id ?? ID),
    build,
    page: { title: 'Example' },
    answer: async (method, path, query, body) => {
      if (path === '/api/echo') return { status: 200, body: { method, body } }
      if (path === '/api/redirect') return { status: 302, body: null, headers: { location: `http://127.0.0.1:${port}/app?x=1` } }
      return null
    },
    stream: (method, path, query, emit) => {
      if (path !== '/api/events') return null
      emit({ n: 1 }, 'tick')
      const timer = setTimeout(() => emit({ n: 2 }, 'tick'), 300)
      return { close: () => clearTimeout(timer) }
    },
  })
  let port = 0
  const server = Bun.serve<{ n: number }>({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    async fetch(request, srv) {
      const url = new URL(request.url)
      seen.push({ path: url.pathname, host: request.headers.get('host'), origin: request.headers.get('origin') })
      if (!hostFence(request.headers.get('host'))) return new Response('not here', { status: 403 })
      if (url.pathname === '/term' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        if (!socketFence(request.headers, port).ok) return new Response(null, { status: 403 })
        const protocol = request.headers.get('sec-websocket-protocol')?.split(',')[0]?.trim()
        if (srv.upgrade(request, { data: { n: 0 }, ...(protocol ? { headers: { 'sec-websocket-protocol': protocol } } : {}) })) return undefined
      }
      return (await doors(request)) ?? new Response('Not found', { status: 404 })
    },
    websocket: {
      open: (socket) => void socket.send('ready'),
      message: (socket, message) => {
        socket.data.n += 1
        if (typeof message === 'string') socket.send(`${socket.data.n}:${message}`)
        else socket.send(new Uint8Array([...new Uint8Array(message)].reverse()))
      },
    },
  })
  port = server.port!
  return { server, port, origin: `http://127.0.0.1:${port}`, seen, stop: () => server.stop(true) }
}

/** A program that is not a module, holding a port: it answers everything with a page. */
function aStranger(port = 0) {
  let hits = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch(request) {
      if (new URL(request.url).pathname !== WELL_KNOWN) hits += 1
      return new Response('<h1>somebody else</h1>', { headers: { 'content-type': 'text/html' } })
    },
  })
  return { server, port: server.port!, hits: () => hits, stop: () => server.stop(true) }
}

/** The host's side, as `server.ts` wires it: `handle` first, the relay for sockets. */
function aHost(targets: Map<string, ProxyTarget>) {
  const deps = { port: 0, target: (id: string) => targets.get(id) ?? null }
  const proxy = new ModuleProxy(deps)
  let ownHosts: ReadonlySet<string> = new Set<string>()
  const server = Bun.serve<SocketData>({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request, srv) {
      const answered = await proxy.handle(request, srv, ownHosts)
      if (answered === 'upgraded') return undefined
      return answered ?? new Response('the host itself', { status: 200 })
    },
    websocket: {
      open: (socket) => moduleSockets.open(socket),
      message: (socket, message) => moduleSockets.message(socket, message),
      close: (socket, code, reason) => moduleSockets.close(socket, code, reason),
    },
  })
  deps.port = server.port!
  ownHosts = own({}, server.port!, [`http://127.0.0.1:${server.port}`]).hosts
  const frameHost = (id = ID) => new URL(frameOriginFor(id, server.port!)!).host
  return { server, proxy, port: server.port!, frameHost, frameOrigin: (id = ID) => frameOriginFor(id, server.port!)!, stop: () => server.stop(true) }
}

/** A request to the host at 127.0.0.1, under the frame address's name (what a browser on `*.localhost` sends). */
const atFrame = (host: ReturnType<typeof aHost>, path: string, init: RequestInit & { headers?: Record<string, string> } = {}, id = ID) =>
  fetch(`http://127.0.0.1:${host.port}${path}`, { ...init, headers: { host: host.frameHost(id), ...(init.headers ?? {}) } })

describe('the addresses', () => {
  test('kehikot.<name> is <name>; another reverse-DNS id is spelled as it is; the rest have none', () => {
    expect(labelFor('kehikot.notes')).toBe('notes')
    expect(labelFor('someone.tool')).toBe('someone.tool')
    expect(labelFor('kehikot.a.b')).toBeNull()
    expect(labelFor('dotless')).toBeNull()
    expect(labelFor('a.-b')).toBeNull()
  })

  test('the frame address comes back as the module, and only one spelling does', () => {
    for (const id of ['kehikot.notes', 'someone.tool', 'a.b.c']) {
      const origin = frameOriginFor(id, 4170)!
      expect(idOfHost(new URL(origin).host)).toBe(id)
    }
    expect(idOfHost('kehikot.notes.kehikot.localhost:4170')).toBeNull()
    expect(idOfHost('NOTES.Kehikot.Localhost:4170')).toBe('kehikot.notes')
    expect(idOfHost('kehikot.localhost:4170')).toBeNull()
    expect(idOfHost('notes.localhost:4170')).toBeNull()
    expect(idOfHost('127.0.0.1:4170')).toBeNull()
    expect(isModuleHost('x.kehikot.localhost')).toBe(true)
    expect(isModuleHost('127.0.0.1:4170')).toBe(false)
  })

  test('different modules are different origins, and none is the host page', () => {
    const a = frameOriginFor('kehikot.notes', 4170)
    const b = frameOriginFor('kehikot.paper', 4170)
    expect(a).not.toBe(b)
    expect(a).not.toBe('http://127.0.0.1:4170')
    expect(new URL(a!).origin).toBe(a!)
  })

  test('routeOf: a frame name whatever the path; /m/<id> for programs', () => {
    expect(routeOf('notes.kehikot.localhost:4170', '/host/headers')).toEqual({ kind: 'frame', id: 'kehikot.notes', path: '/host/headers' })
    expect(routeOf('127.0.0.1:4170', '/m/kehikot.notes/mcp')).toEqual({ kind: 'machine', id: 'kehikot.notes', path: '/mcp' })
    expect(routeOf('127.0.0.1:4170', '/m/kehikot.notes')).toEqual({ kind: 'machine', id: 'kehikot.notes', path: '/' })
    expect(routeOf('127.0.0.1:4170', '/m/NOPE!/x')).toBeNull()
    expect(routeOf('127.0.0.1:4170', '/host/modules')).toBeNull()
    /* A name under kehikot.localhost that is no module's is not a program's address either. */
    expect(routeOf('kehikot.notes.kehikot.localhost:4170', '/m/kehikot.notes/x')).toBeNull()
    expect(machineBaseFor('kehikot.notes', 4170)).toBe('http://127.0.0.1:4170/m/kehikot.notes')
  })

  test('off unless KEHIKOT_MODULE_ADDRESSES=1, and saying so', () => {
    expect(addressesOn({})).toBe(false)
    expect(addressesOn({ KEHIKOT_MODULE_ADDRESSES: '0' })).toBe(false)
    expect(addressesOn({ KEHIKOT_MODULE_ADDRESSES: '1' })).toBe(true)
    moduleAddresses.reset()
    expect(moduleAddresses.said(false)).toEqual({ on: false, frames: false })
    moduleAddresses.notHeld(4170, 'EADDRINUSE')
    expect(moduleAddresses.said(true)).toMatchObject({ on: true, frames: false })
    moduleAddresses.held(4170)
    expect(moduleAddresses.said(true)).toMatchObject({ on: true, frames: true })
    moduleAddresses.reset()
  })
})

describe('through the proxy', () => {
  const targets = new Map<string, ProxyTarget>()
  let module: ReturnType<typeof aModule>
  let host: ReturnType<typeof aHost>

  beforeAll(() => {
    module = aModule({ token: TOKEN_A })
    host = aHost(targets)
  })
  afterEach(() => {
    targets.clear()
    host.proxy.forget()
  })
  afterAll(() => {
    module.stop()
    host.stop()
  })

  test("a frame's page: Host and Origin are the module's own when it reaches it, and its gate takes it", async () => {
    targets.set(ID, { origin: module.origin, token: TOKEN_A })
    const page = await atFrame(host, '/app')
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<title>Example</title>')
    const posted = await atFrame(host, '/api/echo', {
      method: 'POST',
      headers: { origin: host.frameOrigin(), 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'there' }),
    })
    expect(posted.status).toBe(200)
    expect(((await posted.json()) as { body: unknown }).body).toEqual({ hello: 'there' })
    const last = module.seen.at(-1)!
    expect(last.host).toBe(`127.0.0.1:${module.port}`)
    expect(last.origin).toBe(module.origin)
  })

  test("another module's frame is refused by the module, as it is on its own port", async () => {
    targets.set(ID, { origin: module.origin, token: TOKEN_A })
    const posted = await atFrame(host, '/api/echo', {
      method: 'POST',
      headers: { origin: frameOriginFor('kehikot.other', host.port)!, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(posted.status).toBe(403)
    expect(module.seen.at(-1)!.origin).toBe(frameOriginFor('kehikot.other', host.port))
  })

  test("a program's address reaches the module; a browser there is refused, and every answer is sandboxed", async () => {
    targets.set(ID, { origin: module.origin, token: TOKEN_A })
    const program = await fetch(`http://127.0.0.1:${host.port}/m/${ID}/api/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' })
    expect(program.status).toBe(200)
    expect(program.headers.get('content-security-policy')).toContain('sandbox')
    const before = module.seen.length
    const browser = await fetch(`http://127.0.0.1:${host.port}/m/${ID}/app`, { headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' } })
    expect(browser.status).toBe(403)
    expect(browser.headers.get('content-security-policy')).toBe('sandbox')
    const page = await fetch(`http://127.0.0.1:${host.port}/m/${ID}/api/echo`, { headers: { origin: `http://127.0.0.1:${host.port}` } })
    expect(page.status).toBe(403)
    expect(module.seen.length).toBe(before)
  })

  test("a program's address under another name is not the proxy's: it falls to the host", async () => {
    targets.set(ID, { origin: module.origin, token: TOKEN_A })
    const response = await fetch(`http://127.0.0.1:${host.port}/m/${ID}/api/echo`, { headers: { host: `evil.example:${host.port}` } })
    expect(await response.text()).toBe('the host itself')
  })

  test('a Location naming the real origin is put back on the address the request came by', async () => {
    targets.set(ID, { origin: module.origin, token: TOKEN_A })
    const framed = await atFrame(host, '/api/redirect', { redirect: 'manual' })
    expect(framed.status).toBe(302)
    expect(framed.headers.get('location')).toBe(`${host.frameOrigin()}/app?x=1`)
    const machine = await fetch(`http://127.0.0.1:${host.port}/m/${ID}/api/redirect`, { redirect: 'manual' })
    expect(machine.headers.get('location')).toBe(`http://127.0.0.1:${host.port}/m/${ID}/app?x=1`)
  })

  test('an event stream arrives as it is sent, not when it ends', async () => {
    targets.set(ID, { origin: module.origin, token: TOKEN_A })
    const control = new AbortController()
    const began = performance.now()
    const response = await atFrame(host, '/api/events', { signal: control.signal })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const text = new TextDecoder()
    let got = ''
    while (!got.includes('"n":1')) got += text.decode((await reader.read()).value)
    /* The first event, well before the second is even sent (300 ms). */
    expect(performance.now() - began).toBeLessThan(250)
    while (!got.includes('"n":2')) got += text.decode((await reader.read()).value)
    control.abort()
  })

  test('WebSocket traffic, text and binary, with the subprotocol the module chose', async () => {
    targets.set(ID, { origin: module.origin, token: TOKEN_A })
    const socket = new WebSocket(`ws://127.0.0.1:${host.port}/term`, {
      headers: { host: host.frameHost(), origin: host.frameOrigin() },
      protocols: ['tty', 'other'],
    } as unknown as string[])
    socket.binaryType = 'arraybuffer'
    const got: Array<string | number[]> = []
    await new Promise<void>((resolve, reject) => {
      socket.onerror = () => reject(new Error('the socket failed'))
      socket.onmessage = (event) => {
        got.push(typeof event.data === 'string' ? event.data : [...new Uint8Array(event.data as ArrayBuffer)])
        if (got.length === 1) {
          socket.send('ls -la')
          socket.send(new Uint8Array([1, 2, 3]))
        }
        if (got.length === 3) resolve()
      }
    })
    expect(socket.protocol).toBe('tty')
    expect(got).toEqual(['ready', '1:ls -la', [3, 2, 1]])
    const closed = new Promise<number>((resolve) => (socket.onclose = (event) => resolve(event.code)))
    socket.close(1000)
    expect(await closed).toBe(1000)
  })

  test("a socket from another module's frame is refused by the module's own fence", async () => {
    targets.set(ID, { origin: module.origin, token: TOKEN_A })
    const socket = new WebSocket(`ws://127.0.0.1:${host.port}/term`, {
      headers: { host: host.frameHost(), origin: frameOriginFor('kehikot.other', host.port)! },
    } as unknown as string[])
    const outcome = await new Promise<string>((resolve) => {
      socket.onopen = () => resolve('open')
      socket.onerror = () => resolve('refused')
      socket.onclose = () => resolve('refused')
    })
    expect(outcome).toBe('refused')
  })

  test('a module nothing answers for: a clear "not running"', async () => {
    const empty = aStranger()
    const port = empty.port
    empty.stop()
    targets.set(ID, { origin: `http://127.0.0.1:${port}`, token: null })
    const response = await atFrame(host, '/app')
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('is not running')
  })

  test('no registration: 404 with a sentence', async () => {
    const response = await atFrame(host, '/app', {}, 'kehikot.nothing')
    expect(response.status).toBe(404)
    expect(await response.text()).toContain('No module called kehikot.nothing')
  })
})

describe("a stranger on a module's port", () => {
  const targets = new Map<string, ProxyTarget>()
  let host: ReturnType<typeof aHost>
  beforeAll(() => (host = aHost(targets)))
  afterAll(() => host.stop())

  test('the stable path never reaches it: refused with a sentence, and nothing forwarded', async () => {
    const stranger = aStranger()
    try {
      targets.set(ID, { origin: `http://127.0.0.1:${stranger.port}`, token: TOKEN_A })
      for (const ask of [atFrame(host, '/app'), fetch(`http://127.0.0.1:${host.port}/m/${ID}/mcp`, { method: 'POST', body: '{}' })]) {
        const response = await ask
        expect(response.status).toBe(502)
        expect(await response.text()).toContain('Something else is answering')
      }
      expect(stranger.hits()).toBe(0)
    } finally {
      stranger.stop()
    }
  })

  test('another module on the port is a stranger too: the id decides', async () => {
    const neighbour = aModule({ id: 'kehikot.neighbour' })
    try {
      targets.set(ID, { origin: neighbour.origin, token: null })
      const response = await atFrame(host, '/app')
      expect(response.status).toBe(502)
      expect(neighbour.seen.filter((one) => one.path !== WELL_KNOWN)).toHaveLength(0)
    } finally {
      neighbour.stop()
      host.proxy.forget()
    }
  })

  test('once the real module is back on its port, it is reached', async () => {
    const stranger = aStranger()
    const port = stranger.port
    targets.set(ID, { origin: `http://127.0.0.1:${port}`, token: TOKEN_A })
    expect((await atFrame(host, '/app')).status).toBe(502)
    stranger.stop()
    host.proxy.forget()
    const module = aModule({ token: TOKEN_A, port })
    try {
      expect((await atFrame(host, '/app')).status).toBe(200)
    } finally {
      module.stop()
      host.proxy.forget()
    }
  })
})

describe('the start token', () => {
  const targets = new Map<string, ProxyTarget>()
  let host: ReturnType<typeof aHost>
  beforeAll(() => (host = aHost(targets)))
  afterEach(() => host.proxy.forget())
  afterAll(() => host.stop())

  test('a module saying another token is refused: it is not the process this host started', async () => {
    const module = aModule({ token: TOKEN_B })
    try {
      targets.set(ID, { origin: module.origin, token: TOKEN_A })
      const response = await atFrame(host, '/app')
      expect(response.status).toBe(502)
      expect(await response.text()).toContain('not the process this host started')
      expect(module.seen.filter((one) => one.path !== WELL_KNOWN)).toHaveLength(0)
    } finally {
      module.stop()
    }
  })

  test('a module built before the token, or one this host did not start: the id decides', async () => {
    const old = aModule({ token: null })
    try {
      targets.set(ID, { origin: old.origin, token: TOKEN_A })
      expect((await atFrame(host, '/app')).status).toBe(200)
      host.proxy.forget()
      targets.set(ID, { origin: old.origin, token: null })
      expect((await atFrame(host, '/app')).status).toBe(200)
    } finally {
      old.stop()
    }
  })

  test('a process swapped under a kept identity is caught on its answer', async () => {
    const first = aModule({ token: TOKEN_A })
    const port = first.port
    targets.set(ID, { origin: first.origin, token: TOKEN_A })
    expect((await atFrame(host, '/app')).status).toBe(200)
    first.stop()
    /* Inside KEEP_MS: the identity is still believed, so only the answer can tell. */
    const second = aModule({ token: TOKEN_B, port })
    try {
      const response = await atFrame(host, '/app')
      expect(response.status).toBe(502)
      expect(await response.text()).toContain('another process')
    } finally {
      second.stop()
    }
  })
})

describe('the host hands a module a token per start', () => {
  test('start() puts a fresh KEHIKOT_START_TOKEN in the environment and says which', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kehikot-token-'))
    const script = join(dir, 'run.sh')
    const out = join(dir, 'env.txt')
    writeFileSync(script, `#!/bin/sh\nprintf '%s' "$KEHIKOT_START_TOKEN" > "${out}"\n`)
    chmodSync(script, 0o755)
    const ran = start({ dir, script, port: null, url: 'http://127.0.0.1:1', command: script, env: { KEHIKOT_START_TOKEN: 'registered-one-must-not-win' } })
    expect(ran.ok).toBe(true)
    for (let i = 0; i < 50 && !readFileSync(out, { flag: 'a+' }).length; i += 1) await Bun.sleep(20)
    expect(readFileSync(out, 'utf8')).toBe(ran.token!)
    expect(ran.token).toMatch(/^[0-9a-f]{32}$/)
    expect(mintStartToken()).not.toBe(mintStartToken())
  })

  test("the nursery says the token of a live child it holds, and nothing for one that ended or isn't ours", () => {
    const nursery = new Nursery(
      () => {},
      () => {},
    )
    let alive = true
    nursery.keep(ID, { child: { pid: 1, alive: () => alive }, at: 0, url: 'http://127.0.0.1:1', token: TOKEN_A })
    expect(nursery.tokenOf(ID)).toBe(TOKEN_A)
    expect(nursery.tokenOf('kehikot.other')).toBeNull()
    alive = false
    expect(nursery.tokenOf(ID)).toBeNull()
  })
})

describe("the host's guard still tells its page from a module's frame", () => {
  const PORT = 4170
  const self = own({}, PORT, [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`])
  const ask = (pathname: string, headers: Record<string, string>, method = 'POST') => refusal({ method, pathname, headers: new Headers(headers) }, self)

  test("a frame's origin is never one of the page's", () => {
    expect(self.origins).not.toContain(frameOriginFor(ID, PORT))
    for (const host of self.hosts) expect(isModuleHost(host)).toBe(false)
  })

  test('PAGE_ONLY: the page is answered; a module frame on its stable address is not', () => {
    const json = { 'content-type': 'application/json', host: `127.0.0.1:${PORT}` }
    expect(ask('/host/headers', { ...json, origin: `http://127.0.0.1:${PORT}` })).toBeNull()
    expect(ask('/host/headers', { ...json, origin: frameOriginFor(ID, PORT)! })?.status).toBe(403)
    expect(ask('/host/inbox/act', { ...json, origin: frameOriginFor(ID, PORT)! })?.status).toBe(403)
  })

  test('a request under a frame name never reaches a host route: with the addresses off the guard refuses it', () => {
    expect(ask('/host/modules', { host: `${new URL(frameOriginFor(ID, PORT)!).host}` }, 'GET')?.status).toBe(403)
  })
})

describe('the frame-origin check, with a frame on its stable address', () => {
  const PORT = 4170
  const message = { type: `${MESSAGE_PREFIX}from-a-later-protocol` }

  test("a message from the module's own frame address is taken; another module's is not", () => {
    const contentWindow = { postMessage() {} } as unknown as Window
    const quiet = { ready() {}, silent() {}, fault() {}, height() {}, filters() {}, clearable() {}, refreshable() {}, header() {} }
    const conversation = new Conversation({ contentWindow }, ID, frameOriginFor(ID, PORT), async () => ({ ok: true, data: null }), quiet)
    expect(conversation.receive({ source: contentWindow, origin: frameOriginFor('kehikot.other', PORT)!, data: message })).toBe(false)
    expect(conversation.receive({ source: contentWindow, origin: `http://127.0.0.1:${PORT}`, data: message })).toBe(false)
    expect(conversation.receive({ source: contentWindow, origin: frameOriginFor(ID, PORT)!, data: message })).toBe(true)
    conversation.close()
  })
})

describe('the header every answer is checked by', () => {
  test('is the protocol’s', () => expect(START_HEADER).toBe('x-kehikot-start'))
})
