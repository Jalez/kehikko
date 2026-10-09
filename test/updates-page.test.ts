import { describe, expect, test } from 'bun:test'

import { ago, needsAttention, offersAppRestart, triage, waiting, type Outcome, type Reading } from '../src/host/updates.ts'

/* What the update button's tooltip says about when the last check was. */

describe('how long ago the last check was', () => {
  const now = new Date('2026-10-01T12:00:00Z')
  const before = (seconds: number) => new Date(now.getTime() - seconds * 1000)

  test('reads like a sentence', () => {
    expect(ago(before(20), now)).toBe('just now')
    expect(ago(before(60), now)).toBe('1 minute ago')
    expect(ago(before(4 * 60), now)).toBe('4 minutes ago')
    expect(ago(before(2 * 3600), now)).toBe('2 hours ago')
    expect(ago(before(3 * 86400), now)).toStartWith('on ')
  })
})

const one = (behind: number, more: Partial<Reading> = {}): Reading => ({
  id: String(behind),
  name: 'x',
  dir: '/x',
  branch: 'main',
  commit: 'abc',
  dirty: false,
  upstream: 'origin/main',
  behind,
  ahead: 0,
  incoming: [],
  fetchFailed: null,
  blocked: behind ? null : 'already up to date',
  ...more,
})
const unreadable: Reading = { id: 'u', name: 'u', dir: '/u', error: 'not a git checkout' }

describe('how much is waiting', () => {
  test('adds what each checkout is behind, and counts nothing for one that could not be read', () => {
    expect(waiting([one(2), one(3), unreadable])).toBe(5)
  })
})

describe('what gets a row of its own in the panel', () => {
  test('behind, unreadable and unreachable need a person; level does not', () => {
    expect(needsAttention(one(2), null)).toBe(true)
    expect(needsAttention(one(1, { blocked: 'there are uncommitted changes' }), null)).toBe(true)
    expect(needsAttention(unreadable, null)).toBe(true)
    expect(needsAttention(one(0, { fetchFailed: 'offline' }), null)).toBe(true)
    expect(needsAttention(one(0), null)).toBe(false)
    expect(needsAttention(one(0, { dirty: true, ahead: 2 }), undefined)).toBe(false)
  })

  test('anything just acted on keeps its row, even once it is level', () => {
    const outcomes: Outcome[] = [
      { kind: 'updated', note: 'Updated', restart: null, installFailed: null },
      { kind: 'failed', why: 'no' },
      { kind: 'failed', why: 'it did not come back', retry: true },
    ]
    for (const outcome of outcomes) expect(needsAttention(one(0), outcome)).toBe(true)
  })

  test('and so does one the server says something about, with nothing done on this page', () => {
    expect(needsAttention(one(0), null, true)).toBe(true)
    const { attention } = triage([one(0, { id: 'a' }), one(0, { id: 'b' })], {}, new Set(['b']))
    expect(attention.map((r) => r.id)).toEqual(['b'])
  })

  test('the level rest is counted apart, and the pressing come first', () => {
    const level = (id: string) => one(0, { id })
    const { attention, level: rest } = triage(
      [level('a'), one(0, { id: 'f', fetchFailed: 'offline' }), level('b'), unreadable, one(3, { id: 'n' }), level('c')],
      { b: { kind: 'updated', note: 'Updated', restart: null, installFailed: null } },
    )
    expect(attention.map((r) => r.id)).toEqual(['n', 'u', 'f', 'b'])
    expect(rest.map((r) => r.id)).toEqual(['a', 'c'])
  })
})

describe('Restart the host', () => {
  const host: Outcome = { kind: 'updated', note: '', restart: 'host', installFailed: null }
  test('is offered only when the host server changed and the app can restart it', () => {
    expect(offersAppRestart(host, true)).toBe(true)
    expect(offersAppRestart(host, false)).toBe(false)
    expect(offersAppRestart({ ...host, restart: null }, true)).toBe(false)
    expect(offersAppRestart({ kind: 'failed', why: 'no' }, true)).toBe(false)
    expect(offersAppRestart(null, true)).toBe(false)
  })
})
