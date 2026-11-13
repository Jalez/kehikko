import { afterEach, describe, expect, test } from 'bun:test'

import { WELL_KNOWN } from 'kehikot-module-protocol'

import { routeOf } from '@/host/moduleAddress.ts'
import { doorWake, GRACE_MS, Idleness, personStoppedDoorLine, toStop, type Standing } from '../server/lifecycle.ts'
import { ModuleProxy, type ProxyTarget } from '../server/moduleProxy.ts'

/**
 * A module the host stopped for being idle is started by a request at its MCP door and answers it;
 * one the person stopped is refused in words; and door traffic counts as use for the idle stop.
 */

const ID = 'kehikot.example'
const DOOR = `/m/${ID}/mcp`
const route = () => routeOf(null, DOOR)!

function aModule() {
  let port = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request): Promise<Response> {
      const path = new URL(request.url).pathname
      if (path === WELL_KNOWN) return Response.json({ id: ID })
      if (path === '/mcp') {
        const body = (await request.json()) as { id: number; method: string }
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { method: body.method, port } })
      }
      return new Response('Not found', { status: 404 })
    },
  })
  port = server.port!
  return { origin: `http://127.0.0.1:${port}`, port, stop: () => server.stop(true) }
}

const stops: Array<() => unknown> = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

function rpc(method: string, id = 1): Request {
  return new Request(`http://127.0.0.1:4170${DOOR}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method }),
  })
}

/** A dead port: a module that was stopped leaves nothing listening there. */
function deadOrigin(): string {
  const gone = aModule()
  gone.stop()
  return gone.origin
}

describe('doorWake', () => {
  test('the person’s stop wins; the host’s idle stop starts; anything else is left alone', () => {
    const base = { personStopped: false, idleStopped: false, registered: true, startable: true }
    expect(doorWake({ ...base, idleStopped: true })).toBe('start')
    expect(doorWake({ ...base, idleStopped: true, personStopped: true })).toBe('refuse')
    expect(doorWake({ ...base, personStopped: true })).toBe('refuse')
    expect(doorWake(base)).toBe('none')
    expect(doorWake({ ...base, idleStopped: true, registered: false })).toBe('none')
    expect(doorWake({ ...base, idleStopped: true, startable: false })).toBe('none')
  })
})

describe('a request at the MCP door of a stopped module', () => {
  test('idle-stopped: the host starts it and the request is answered by the new process', async () => {
    const state = { target: { origin: deadOrigin(), token: null } as ProxyTarget | null, starting: false, asleep: true }
    const woken: string[] = []
    const lines: string[] = []
    const proxy = new ModuleProxy({
      port: 4170,
      target: () => state.target,
      starting: () => state.starting,
      wake: (id) => {
        if (doorWake({ personStopped: false, idleStopped: state.asleep, registered: true, startable: true }) !== 'start') return null
        woken.push(id)
        state.asleep = false
        state.starting = true
        /* The start takes a moment, then the module answers on a new port. */
        setTimeout(() => {
          const fresh = aModule()
          stops.push(fresh.stop)
          state.target = { origin: fresh.origin, token: null }
        }, 100)
        return { ok: true }
      },
      log: (line) => lines.push(line),
      holdMs: 5_000,
      pollMs: 20,
    })
    const answer = await proxy.answer(rpc('tools/call', 4), route())
    expect(woken).toEqual([ID])
    expect(answer.status).toBe(200)
    expect(((await answer.json()) as { id: number }).id).toBe(4)
    expect(lines[0]).toContain('forwarded to')
  })

  test('person-stopped: refused in words saying so and how to start it, and not started', async () => {
    let started = false
    const proxy = new ModuleProxy({
      port: 4170,
      target: () => ({ origin: deadOrigin(), token: null }),
      starting: () => started,
      wake: () => {
        const rule = doorWake({ personStopped: true, idleStopped: true, registered: true, startable: true })
        if (rule === 'start') started = true
        return rule === 'refuse' ? { ok: false, why: personStoppedDoorLine('Example') } : null
      },
      holdMs: 2_000,
      pollMs: 20,
    })
    const began = Date.now()
    const answer = await proxy.answer(rpc('tools/list', 9), route())
    expect(Date.now() - began).toBeLessThan(1_500)
    expect(started).toBe(false)
    expect(answer.status).toBe(503)
    const body = (await answer.json()) as { id: number; error: { message: string } }
    expect(body.id).toBe(9)
    expect(body.error.message).toContain('stopped by the person')
    expect(body.error.message).toContain('presses Start')
  })

  test('a module the host never stopped is refused at once, as before', async () => {
    const proxy = new ModuleProxy({ port: 4170, target: () => ({ origin: deadOrigin(), token: null }), starting: () => false, wake: () => null, holdMs: 2_000, pollMs: 20 })
    const answer = await proxy.answer(rpc('tools/list'), route())
    expect(answer.status).toBeGreaterThanOrEqual(500)
  })
})

describe('door traffic counts as use', () => {
  test('a door request is reported as use, and resets the idle timer the stop measures from', async () => {
    const live = aModule()
    stops.push(live.stop)
    const idleness = new Idleness()
    let now = 1_000
    const proxy = new ModuleProxy({ port: 4170, target: () => ({ origin: live.origin, token: null }), used: (id) => idleness.noted([id], now) })
    const startedAt = 0
    const standing = (): Standing => ({ id: ID, needed: false, answering: true, startable: true, ours: true, keep: false, idleSince: idleness.since(ID, startedAt), starting: false })

    now = GRACE_MS - 10_000
    expect((await proxy.answer(rpc('tools/list'), route())).status).toBe(200)
    /* Past the grace period from its start, but not from the agent's last call: kept. */
    expect(toStop([standing()], GRACE_MS + 1_000)).toEqual([])
    /* A grace period after the last call with no more: stopped. */
    expect(toStop([standing()], now + GRACE_MS)).toEqual([ID])
  })

  test('a module’s other paths are not counted', async () => {
    const live = aModule()
    stops.push(live.stop)
    const used: string[] = []
    const proxy = new ModuleProxy({ port: 4170, target: () => ({ origin: live.origin, token: null }), used: (id) => used.push(id) })
    await proxy.answer(new Request(`http://127.0.0.1:4170/m/${ID}/api/x`), routeOf(null, `/m/${ID}/api/x`)!)
    expect(used).toEqual([])
  })
})
