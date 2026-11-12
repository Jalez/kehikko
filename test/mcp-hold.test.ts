import { afterEach, describe, expect, test } from 'bun:test'

import { WELL_KNOWN } from 'kehikot-module-protocol'

import { routeOf } from '@/host/moduleAddress.ts'
import { HOLD_MOST, isMcpDoor, ModuleProxy, type ProxyTarget } from '../server/moduleProxy.ts'

/**
 * A module's MCP door riding out a restart: a request that finds nothing answering while the host
 * brings the module up is held and forwarded to the new process, at whatever port it bound.
 */

const ID = 'kehikot.example'
const DOOR = `/m/${ID}/mcp`

/** A module's door as the protocol serves one, enough for the proxy: its manifest, and `/mcp` answering JSON-RPC. */
function aModule(options: { hang?: boolean } = {}) {
  let calls = 0
  let port = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request): Promise<Response> {
      const path = new URL(request.url).pathname
      if (path === WELL_KNOWN) return Response.json({ id: ID })
      if (path === '/mcp') {
        calls += 1
        const body = (await request.json()) as { id: number; method: string }
        if (options.hang) return new Promise<Response>(() => {})
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { method: body.method, port } })
      }
      return new Response('Not found', { status: 404 })
    },
  })
  port = server.port!
  return { origin: `http://127.0.0.1:${port}`, port, calls: () => calls, stop: () => server.stop(true) }
}

const stops: Array<() => unknown> = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

function rpc(method: string, id = 1, signal?: AbortSignal): Request {
  return new Request(`http://127.0.0.1:4170${DOOR}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method }),
    ...(signal ? { signal } : {}),
  })
}

function aProxy(state: { target: ProxyTarget | null; starting: boolean }, holdMs = 5_000) {
  const lines: string[] = []
  const proxy = new ModuleProxy({
    port: 4170,
    target: () => state.target,
    starting: () => state.starting,
    log: (line) => lines.push(line),
    holdMs,
    pollMs: 20,
  })
  return { proxy, lines }
}

const route = () => routeOf(null, DOOR)!

describe('isMcpDoor', () => {
  test('a module’s door on its program address, not its other paths, a frame or a pinned version', () => {
    expect(isMcpDoor(routeOf(null, DOOR)!)).toBe(true)
    expect(isMcpDoor(routeOf(null, `/m/${ID}/api/runs`)!)).toBe(false)
    expect(isMcpDoor(routeOf(null, `/m/${ID}@v1.0.0/mcp`)!)).toBe(false)
  })
})

describe('a request at the MCP door while the module restarts', () => {
  test('is held and forwarded to the new process on its new port', async () => {
    const old = aModule()
    const state = { target: { origin: old.origin, token: null } as ProxyTarget | null, starting: false }
    const { proxy, lines } = aProxy(state)
    expect((await proxy.answer(rpc('tools/list'), route())).status).toBe(200)
    old.stop()
    state.starting = true

    const asked = proxy.answer(rpc('tools/call', 7), route())
    await Bun.sleep(150)
    expect(proxy.holding(ID)).toBe(1)
    const fresh = aModule()
    stops.push(fresh.stop)
    state.target = { origin: fresh.origin, token: null }
    const answer = await asked
    state.starting = false

    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ jsonrpc: '2.0', id: 7, result: { method: 'tools/call', port: fresh.port } })
    expect(fresh.calls()).toBe(1)
    expect(proxy.holding(ID)).toBe(0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(new RegExp(`held POST /mcp for ${ID} \\d+ ms while it started: forwarded to ${fresh.origin}`))
  })

  test('is refused with a JSON-RPC error after the deadline', async () => {
    const gone = aModule()
    gone.stop()
    const state = { target: { origin: gone.origin, token: null }, starting: true }
    const { proxy, lines } = aProxy(state, 300)
    const began = Date.now()
    const answer = await proxy.answer(rpc('initialize', 3), route())
    expect(Date.now() - began).toBeGreaterThanOrEqual(300)
    expect(answer.status).toBe(503)
    const body = (await answer.json()) as { jsonrpc: string; id: number; error: { code: number; message: string } }
    expect(body.jsonrpc).toBe('2.0')
    expect(body.id).toBe(3)
    expect(body.error.message).toContain('did not answer within')
    expect(lines[0]).toContain('timed out')
  })

  test('is refused once the host stops bringing it up', async () => {
    const gone = aModule()
    gone.stop()
    const state = { target: { origin: gone.origin, token: null }, starting: true }
    const { proxy } = aProxy(state)
    const asked = proxy.answer(rpc('tools/list'), route())
    await Bun.sleep(100)
    state.starting = false
    const answer = await asked
    expect(answer.status).toBe(503)
    expect(((await answer.json()) as { error: { message: string } }).error.message).toContain('stopped again without answering')
  })

  test('is refused at once when nothing is starting the module', async () => {
    const gone = aModule()
    gone.stop()
    const { proxy, lines } = aProxy({ target: { origin: gone.origin, token: null }, starting: false })
    const began = Date.now()
    const answer = await proxy.answer(rpc('tools/list', 9), route())
    expect(Date.now() - began).toBeLessThan(1_000)
    expect(answer.status).toBe(503)
    const body = (await answer.json()) as { id: number; error: { message: string } }
    expect(body.id).toBe(9)
    expect(body.error.message).toContain('not running')
    expect(lines).toHaveLength(0)
  })

  test('is refused at once when no module is registered under that id', async () => {
    const { proxy } = aProxy({ target: null, starting: false })
    const answer = await proxy.answer(rpc('tools/list'), route())
    expect(answer.status).toBe(404)
    expect(((await answer.json()) as { error: { message: string } }).error.message).toContain('No module called')
  })

  test('already forwarded to the old process is never sent again to the new one', async () => {
    const old = aModule({ hang: true })
    const state = { target: { origin: old.origin, token: null } as ProxyTarget | null, starting: false }
    const { proxy } = aProxy(state)
    const asked = proxy.answer(rpc('tools/call', 5), route())
    await Bun.sleep(150)
    expect(old.calls()).toBe(1)
    /* The old process goes with the call in hand, and the host starts the new one. */
    state.starting = true
    const fresh = aModule()
    stops.push(fresh.stop)
    state.target = { origin: fresh.origin, token: null }
    old.stop()
    const answer = await asked
    expect(answer.status).toBe(503)
    expect(await answer.text()).toContain('stopped answering')
    await Bun.sleep(100)
    expect(fresh.calls()).toBe(0)
  })

  test('holds at most HOLD_MOST per module; one more is refused at once', async () => {
    const gone = aModule()
    gone.stop()
    const state = { target: { origin: gone.origin, token: null }, starting: true }
    const { proxy, lines } = aProxy(state, 10_000)
    const quit = new AbortController()
    const held = Array.from({ length: HOLD_MOST }, (_, n) => proxy.answer(rpc('tools/list', n, quit.signal), route()))
    await Bun.sleep(150)
    expect(proxy.holding(ID)).toBe(HOLD_MOST)

    const began = Date.now()
    const over = await proxy.answer(rpc('tools/list', 99), route())
    expect(Date.now() - began).toBeLessThan(1_000)
    expect(over.status).toBe(503)
    expect(((await over.json()) as { error: { message: string } }).error.message).toContain('already waiting')

    quit.abort()
    const ended = await Promise.all(held)
    expect(ended.every((one) => one.status === 499)).toBe(true)
    expect(proxy.holding(ID)).toBe(0)
    expect(lines).toHaveLength(HOLD_MOST)
  })
})
