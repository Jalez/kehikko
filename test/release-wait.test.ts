import { describe, expect, test } from 'bun:test'

import { CHECK_AT_MOST_EVERY_MS, foundIn, ReleaseWaits, type Found } from '../server/releaseWait.ts'
import type { Checkout, Place } from '../server/updates.ts'

/**
 * A module starts first and is checked for a newer release after; what the
 * check finds is put in place only when the module is not running. See
 * `server/releaseWait.ts`.
 */

const place: Place = { id: 'kehikot.thing', name: 'Thing', dir: '/nowhere/kehikot.thing' }
const NOW = 1_700_000_000_000

function harness(found: () => Promise<Found>) {
  const order: string[] = []
  const lines: string[] = []
  let now = NOW
  const waits = new ReleaseWaits({
    check: async (one) => {
      order.push(`check ${one.id}`)
      return found()
    },
    apply: async (one) => {
      order.push(`apply ${one.id}`)
    },
    log: (line) => lines.push(line),
    now: () => now,
  })
  return { waits, order, lines, later: (ms: number) => (now += ms) }
}

describe('a start never waits for a release check', () => {
  test('the start happens, and the check runs beside it without being awaited', async () => {
    /* A check that never answers: the network is down, or slow. */
    const { waits, order } = harness(() => new Promise<Found>(() => {}))
    order.push('start')
    const checking = waits.started(place)
    order.push('answering')
    expect(checking).not.toBeNull()
    expect(order).toEqual(['start', 'check kehikot.thing', 'answering'])
    expect(waits.waiting(place.id)).toBeNull()
  })

  test('at most one check per module per ten minutes', async () => {
    const { waits, order, later } = harness(async () => ({ kind: 'current' }))
    await waits.started(place)
    expect(waits.started(place)).toBeNull()
    later(CHECK_AT_MOST_EVERY_MS + 1)
    await waits.started(place)
    expect(order.filter((one) => one.startsWith('check'))).toHaveLength(2)
  })
})

describe('a newer release waits for the next stop or restart', () => {
  test('a check that finds one remembers it, and says so once', async () => {
    const { waits, lines, later } = harness(async () => ({ kind: 'waiting', target: 'v1.6.1' }))
    await waits.started(place)
    expect(waits.waiting(place.id)).toBe('v1.6.1')
    later(CHECK_AT_MOST_EVERY_MS + 1)
    await waits.started(place)
    expect(lines.filter((line) => line.includes('v1.6.1 waiting'))).toHaveLength(1)
  })

  test('put in place on the next restart (or stop), and then no longer waiting', async () => {
    const { waits, order } = harness(async () => ({ kind: 'waiting', target: 'v1.6.1' }))
    await waits.started(place)
    expect(await waits.apply(place)).toBe(true)
    expect(order).toEqual(['check kehikot.thing', 'apply kehikot.thing'])
    expect(waits.waiting(place.id)).toBeNull()
    /* A second stop has nothing to apply. */
    expect(await waits.apply(place)).toBe(false)
  })

  test('nothing waiting, nothing applied', async () => {
    const { waits, order } = harness(async () => ({ kind: 'current' }))
    await waits.started(place)
    expect(await waits.apply(place)).toBe(false)
    expect(order).toEqual(['check kehikot.thing'])
  })

  test('the module is not to be started while its release goes in', async () => {
    let finish = () => {}
    const waits = new ReleaseWaits({
      check: async () => ({ kind: 'waiting', target: 'v2.0.0' }),
      apply: () => new Promise<void>((done) => (finish = done)),
      log: () => {},
    })
    await waits.started(place)
    const applying = waits.apply(place)
    expect(waits.applying(place.id)).toBe(true)
    /* A second stop meanwhile does not run it twice. */
    expect(await waits.apply(place)).toBe(false)
    finish()
    expect(await applying).toBe(true)
    expect(waits.applying(place.id)).toBe(false)
  })

  test('a later check that finds the copy current forgets what was waiting', async () => {
    let next: Found = { kind: 'waiting', target: 'v1.6.1' }
    const { waits, later } = harness(async () => next)
    await waits.started(place)
    next = { kind: 'current' }
    later(CHECK_AT_MOST_EVERY_MS + 1)
    await waits.started(place)
    expect(waits.waiting(place.id)).toBeNull()
  })

  test('a failed check is said, and is not a reason to hold anything', async () => {
    const { waits, lines } = harness(async () => {
      throw new Error('offline')
    })
    await waits.started(place)
    expect(waits.waiting(place.id)).toBeNull()
    expect(lines.some((line) => line.includes('offline'))).toBe(true)
  })
})

describe('what a fetched reading says', () => {
  const checkout = (over: Partial<Checkout> = {}): Checkout => ({
    id: place.id,
    name: place.name,
    dir: place.dir,
    branch: null,
    commit: 'abc1234',
    dirty: false,
    upstream: null,
    behind: 0,
    ahead: 0,
    incoming: [],
    fetchFailed: null,
    blocked: null,
    ...over,
  })
  const release = (target: string | null) => ({
    follows: 'release' as const,
    installed: 'v1.6.0',
    newest: target ?? 'v1.6.0',
    target,
    notes: [],
    needsNewer: null,
    repo: null,
    error: null,
  })

  test('a newer release is waiting', () => {
    expect(foundIn(checkout({ release: release('v1.6.1') }))).toEqual({ kind: 'waiting', target: 'v1.6.1' })
  })
  test('none is current', () => {
    expect(foundIn(checkout({ release: release(null) }))).toEqual({ kind: 'current' })
  })
  test('one that cannot be applied is held, with the reason', () => {
    expect(foundIn(checkout({ release: release('v1.6.1'), blocked: 'it has changes of its own' }))).toEqual({
      kind: 'held',
      why: 'it has changes of its own',
    })
  })
  test('an unreadable copy is said', () => {
    expect(foundIn({ ...place, error: 'not a git repository' })).toEqual({ kind: 'unreadable', why: 'not a git repository' })
  })
})
