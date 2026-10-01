import { describe, expect, test } from 'bun:test'

import { ago, waiting, type Reading } from '../src/host/updates.ts'

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

describe('how much is waiting', () => {
  test('adds what each checkout is behind, and counts nothing for one that could not be read', () => {
    const one = (behind: number): Reading => ({
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
      blocked: null,
    })
    expect(waiting([one(2), one(3), { id: 'u', name: 'u', dir: '/u', error: 'not a git checkout' }])).toBe(5)
  })
})
