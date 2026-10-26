import { describe, expect, test } from 'bun:test'

import type { Presence } from '../server/discover.ts'
import { ASK_FIRST_MS, ASK_LONGEST_MS } from '../server/launch.ts'
import { ManifestCache, probe, UNANSWERED_MS } from '../server/manifests.ts'

/*
 * One kept manifest per module (`server/manifests.ts`): a sweep within the freshness reads it, a
 * module nothing answers for is asked again after `UNANSWERED_MS`, `forget` and `fresh` ask again,
 * two reads at once are one request, and a module the host started is asked by its wait alone.
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

  test('a module nothing answers for stands for a moment only', async () => {
    const { cache, asked, later } = counted(false)
    await cache.read(registration('kehikot.a'))
    later(UNANSWERED_MS - 1)
    await cache.read(registration('kehikot.a'))
    expect(asked.length).toBe(1)
    /* Not a reading the liveness check may take for an answer. */
    expect(cache.readAt('kehikot.a')).toBeNull()
    later(2)
    await cache.read(registration('kehikot.a'))
    expect(asked.length).toBe(2)
    await cache.read(registration('kehikot.a'), { fresh: true })
    expect(asked.length).toBe(3)
  })

  test('`kept` reads what is kept however old, and asks only for what is not', async () => {
    const { cache, asked, later } = counted(true)
    await cache.read(registration('kehikot.a'))
    later(10 * 60_000)
    await cache.read(registration('kehikot.a'), { kept: true })
    expect(asked).toEqual(['kehikot.a'])
    await cache.read(registration('kehikot.b'), { kept: true })
    expect(asked).toEqual(['kehikot.a', 'kehikot.b'])
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

describe('the host waiting for a module it started', () => {
  /** A module that answers from the `up`th ask on, a clock that only the waits move, and every ask counted. */
  function starting(up: number, served: Partial<Presence> = {}) {
    const asked: string[] = []
    const slept: number[] = []
    let now = 1_000
    const cache = new ManifestCache(
      async (r) => {
        asked.push(r.id)
        return asked.length >= up ? { ...presence(r.id, true), ...served } : presence(r.id, false)
      },
      {
        now: () => now,
        sleep: async (ms) => {
          slept.push(ms)
          now += ms
          await Promise.resolve()
        },
      },
    )
    return { cache, asked, slept }
  }

  test('asks at widening intervals until it answers, and keeps the answer', async () => {
    const { cache, asked, slept } = starting(6)
    const waited = await cache.wait(registration('kehikot.a'), 30_000)
    expect(waited.up).toBe(true)
    expect(asked.length).toBe(6)
    expect(slept[0]).toBe(ASK_FIRST_MS)
    for (let i = 1; i < slept.length; i++) expect(slept[i]).toBeGreaterThanOrEqual(slept[i - 1]!)
    expect(Math.max(...slept)).toBeLessThanOrEqual(ASK_LONGEST_MS)
    /* The sweep after it asks nothing. */
    await cache.read(registration('kehikot.a'))
    expect(asked.length).toBe(6)
  })

  test('nobody else asks while it waits: a read is what the wait last found', async () => {
    let answer = false
    const asked: string[] = []
    let wake = () => {}
    const cache = new ManifestCache(async (r) => {
      asked.push(r.id)
      return presence(r.id, answer)
    }, { sleep: () => new Promise<void>((done) => (wake = done)) })
    const waiting = cache.wait(registration('kehikot.a'), 30_000)
    expect(cache.waiting('kehikot.a')).toBe(true)
    for (let i = 0; i < 5; i++) expect((await cache.read(registration('kehikot.a'), { fresh: i % 2 === 0 })).reached).toBe(false)
    /* A person's look again does not end the wait. */
    cache.refresh()
    await cache.read(registration('kehikot.a'))
    expect(asked.length).toBe(1)
    answer = true
    wake()
    expect((await waiting).up).toBe(true)
    expect(asked.length).toBe(2)
    expect(cache.waiting('kehikot.a')).toBe(false)
    expect((await cache.read(registration('kehikot.a'))).reached).toBe(true)
    expect(asked.length).toBe(2)
  })

  test('a 404 is not an answer, a page that is not a manifest is', async () => {
    const notFound = starting(1, { condition: 'silent', served: undefined })
    expect((await notFound.cache.wait(registration('kehikot.a'), 2_000)).up).toBe(false)
    const served = starting(1, { condition: 'silent', served: true })
    expect((await served.cache.wait(registration('kehikot.a'), 2_000)).up).toBe(true)
  })

  test('gives up at its deadline, and the refusal stands for a moment', async () => {
    const { cache, asked } = starting(Infinity)
    const waited = await cache.wait(registration('kehikot.a'), 5_000)
    expect(waited).toMatchObject({ up: false, cancelled: false })
    const n = asked.length
    expect(n).toBeLessThanOrEqual(10)
    await cache.read(registration('kehikot.a'))
    expect(asked.length).toBe(n)
  })

  test('forgetting the module ends the wait: whoever stopped or restarted it decides', async () => {
    let wake = () => {}
    const asked: string[] = []
    const cache = new ManifestCache(async (r) => {
      asked.push(r.id)
      return presence(r.id, false)
    }, { sleep: () => new Promise<void>((done) => (wake = done)) })
    const waiting = cache.wait(registration('kehikot.a'), 30_000)
    await Promise.resolve()
    await Promise.resolve()
    cache.forget('kehikot.a')
    wake()
    expect(await waiting).toMatchObject({ up: false, cancelled: true })
    expect(asked.length).toBe(1)
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
