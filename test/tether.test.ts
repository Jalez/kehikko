import { describe, expect, test } from 'bun:test'
import { createServer, type Socket } from 'node:net'

import { SETTLED_AFTER_MS, Tethers, type Connect } from '../server/tether.ts'

/**
 * A held connection to a module the host did not start: its closing is heard,
 * and only while it is wanted.
 */

/** A socket the test opens and closes by hand. */
function fake() {
  const made: { port: number; host: string; heard: Record<string, () => void>; destroyed: boolean }[] = []
  const connect: Connect = (port, host) => {
    const one = { port, host, heard: {} as Record<string, () => void>, destroyed: false }
    made.push(one)
    return {
      on: (event, heard) => {
        one.heard[event] = heard
      },
      destroy: () => {
        one.destroyed = true
      },
    }
  }
  return { made, connect }
}

describe('which modules are tethered', () => {
  test('one connection each, to the port its address names', () => {
    const { made, connect } = fake()
    const tethers = new Tethers(() => {}, connect)
    tethers.sync(new Map([['a', 'http://127.0.0.1:7801'], ['b', 'http://localhost:7802/']]))
    expect(made.map((one) => [one.host, one.port])).toEqual([['127.0.0.1', 7801], ['localhost', 7802]])
    /* Asked again with the same: nothing new. */
    tethers.sync(new Map([['a', 'http://127.0.0.1:7801'], ['b', 'http://localhost:7802/']]))
    expect(made.length).toBe(2)
    expect(tethers.ids.sort()).toEqual(['a', 'b'])
  })

  test('one no longer wanted is let go, and that is not a drop', () => {
    const { made, connect } = fake()
    const dropped: string[] = []
    const tethers = new Tethers((id) => dropped.push(id), connect)
    tethers.sync(new Map([['a', 'http://127.0.0.1:7801']]))
    tethers.sync(new Map())
    expect(made[0]!.destroyed).toBe(true)
    /* The close that follows a destroy. */
    made[0]!.heard.close?.()
    expect(dropped).toEqual([])
    expect(tethers.ids).toEqual([])
  })

  test('an address that is not one is skipped', () => {
    const { made, connect } = fake()
    new Tethers(() => {}, connect).sync(new Map([['a', 'not an address']]))
    expect(made.length).toBe(0)
  })
})

describe('a tether that closes', () => {
  test('is said once, with whether it had been held a while', () => {
    const { made, connect } = fake()
    let now = 1_000
    const dropped: [string, boolean][] = []
    const tethers = new Tethers((id, quick) => dropped.push([id, quick]), connect, () => now)
    tethers.sync(new Map([['a', 'http://127.0.0.1:7801']]))
    made[0]!.heard.connect?.()
    now += SETTLED_AFTER_MS + 1
    made[0]!.heard.close?.()
    expect(dropped).toEqual([['a', false]])
    expect(tethers.ids).toEqual([])
    /* Put back by the caller, and this one never opens: refused. */
    tethers.sync(new Map([['a', 'http://127.0.0.1:7801']]))
    made[1]!.heard.error?.()
    made[1]!.heard.close?.()
    expect(dropped).toEqual([['a', false], ['a', true]])
  })

  test('the other end going away is read as the end, and this side closes too', () => {
    /* A socket nobody reads never hears the end: the connection sat half-open
       and the module's container stayed green. */
    const { made, connect } = fake()
    const tethers = new Tethers(() => {}, (port, host) => ({ ...connect(port, host), resume: () => resumed.push(port) }))
    const resumed: number[] = []
    tethers.sync(new Map([['a', 'http://127.0.0.1:7801']]))
    expect(resumed).toEqual([7801])
    expect(typeof made[0]!.heard.data).toBe('function')
    made[0]!.heard.end?.()
    expect(made[0]!.destroyed).toBe(true)
  })

  test('a real process going away is heard within a moment', async () => {
    const sockets: Socket[] = []
    const server = createServer((socket) => sockets.push(socket))
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const port = (server.address() as { port: number }).port

    let heard: (() => void) | null = null
    const dropped = new Promise<void>((done) => {
      heard = done
    })
    const tethers = new Tethers(() => heard?.())
    tethers.sync(new Map([['a', `http://127.0.0.1:${port}`]]))
    while (sockets.length === 0) await new Promise((wake) => setTimeout(wake, 5))

    /* What the operating system does when the process holding the port dies. */
    const before = Date.now()
    for (const socket of sockets) socket.destroy()
    server.close()
    await dropped
    expect(Date.now() - before).toBeLessThan(1_000)
    expect(tethers.ids).toEqual([])
  })
})
