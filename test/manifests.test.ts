import { describe, expect, test } from 'bun:test'

import type { Presence } from '../server/discover.ts'
import { ManifestCache, probe } from '../server/manifests.ts'

/*
 * One kept manifest per module (`server/manifests.ts`): a sweep within the freshness reads it, a
 * module nothing answers for is asked every time, `forget` and `fresh` ask again, and two reads at
 * once are one request.
 */

const registration = (id: string, url = 'http://127.0.0.1:4999') => ({ id, url, file: `${id}.json` })
const presence = (id: string, reached: boolean): Presence =>
  ({ id, at: 'http://127.0.0.1:4999', condition: reached ? 'ready' : 'silent', reached, line: '' }) as Presence

function counted(reached = true) {
  const asked: string[] = []
  let now = 1_000
  const cache = new ManifestCache(
    async (r) => {
      asked.push(r.id)
      return presence(r.id, reached)
    },
    { now: () => now, freshMs: 60_000 },
  )
  return { cache, asked, later: (ms: number) => (now += ms) }
}

describe('the manifest cache', () => {
  test('a manifest read is kept for the freshness, then asked again', async () => {
    const { cache, asked, later } = counted()
    await cache.read(registration('kehikot.a'))
    await cache.read(registration('kehikot.a'))
    expect(asked).toEqual(['kehikot.a'])
    later(60_001)
    await cache.read(registration('kehikot.a'))
    expect(asked).toEqual(['kehikot.a', 'kehikot.a'])
  })

  test('a module nothing answers for is not kept', async () => {
    const { cache, asked } = counted(false)
    await cache.read(registration('kehikot.a'))
    await cache.read(registration('kehikot.a'))
    expect(asked.length).toBe(2)
  })

  test('forget, fresh and another address ask again', async () => {
    const { cache, asked } = counted()
    await cache.read(registration('kehikot.a'))
    cache.forget('kehikot.a')
    await cache.read(registration('kehikot.a'))
    await cache.read(registration('kehikot.a'), { fresh: true })
    await cache.read(registration('kehikot.a', 'http://127.0.0.1:5000'))
    expect(asked.length).toBe(4)
  })

  test('two reads at once are one request', async () => {
    const { cache, asked } = counted()
    const [a, b] = await Promise.all([cache.read(registration('kehikot.a')), cache.read(registration('kehikot.a'))])
    expect(a).toBe(b)
    expect(asked.length).toBe(1)
  })

  test('a read that was out when the module was forgotten is not kept', async () => {
    let release = () => {}
    const asked: string[] = []
    const cache = new ManifestCache(async (r) => {
      asked.push(r.id)
      if (asked.length === 1) await new Promise<void>((done) => (release = done))
      return presence(r.id, true)
    })
    const out = cache.read(registration('kehikot.a'))
    cache.forget('kehikot.a')
    release()
    await out
    await cache.read(registration('kehikot.a'))
    expect(asked.length).toBe(2)
  })
})

describe("a person's press", () => {
  test('forgets every kept manifest, and a press right behind it reads what that one read', async () => {
    const asked: string[] = []
    let now = 1_000
    const cache = new ManifestCache(
      async (r) => {
        asked.push(r.id)
        return presence(r.id, true)
      },
      { now: () => now, floorMs: 2_000 },
    )
    await cache.read(registration('kehikot.a'))
    expect(cache.refresh()).toBe(true)
    await cache.read(registration('kehikot.a'))
    /* Twenty presses in the next second and a half: none of them asks again. */
    for (let i = 0; i < 20; i++) {
      now += 75
      expect(cache.refresh()).toBe(false)
      await cache.read(registration('kehikot.a'))
    }
    expect(asked.length).toBe(2)
    now += 2_000
    expect(cache.refresh()).toBe(true)
    await cache.read(registration('kehikot.a'))
    expect(asked.length).toBe(3)
  })
})

describe('keyOf', () => {
  test('files two programs of one module apart', async () => {
    const asked: string[] = []
    const cache = new ManifestCache(
      async (r) => {
        asked.push(r.url)
        return presence(r.id, true)
      },
      { keyOf: (r) => `${r.id} ${r.url}` },
    )
    for (let i = 0; i < 3; i++) {
      await cache.read(registration('kehikot.a', 'http://127.0.0.1:5001'))
      await cache.read(registration('kehikot.a', 'http://127.0.0.1:5002'))
    }
    expect(asked).toEqual(['http://127.0.0.1:5001', 'http://127.0.0.1:5002'])
    cache.keepOnly(['kehikot.a http://127.0.0.1:5001'])
    await cache.read(registration('kehikot.a', 'http://127.0.0.1:5002'))
    expect(asked.length).toBe(3)
  })
})

describe('the liveness probe', () => {
  test('any answer is reached, with the build its header names', async () => {
    const said = await probe('http://127.0.0.1:1/healthz', (async () =>
      new Response('ok', { status: 404, headers: { 'x-module-build': 'v1@abc' } })) as unknown as typeof fetch)
    expect(said).toEqual({ reached: true, stamp: 'v1@abc' })
  })

  test('a refused connection is not reached', async () => {
    const said = await probe('http://127.0.0.1:1/healthz', (async () => {
      throw new TypeError('connection refused')
    }) as unknown as typeof fetch)
    expect(said).toEqual({ reached: false, stamp: null })
  })
})
