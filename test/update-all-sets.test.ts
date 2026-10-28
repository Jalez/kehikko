import { describe, expect, test } from 'bun:test'

import { summaryOf, tooltipFor } from '../src/canvas/Updates.tsx'
import { NOT_FETCHED, skippedAfter, skipReason, unfetchedCount, updateSets, type Checkout, type Check } from '../src/host/updates.ts'

const one = (id: string, over: Partial<Checkout> = {}): Checkout => ({
  id,
  name: id,
  dir: `/${id}`,
  branch: 'main',
  commit: 'abc1234',
  dirty: false,
  upstream: 'origin/main',
  behind: 0,
  ahead: 0,
  incoming: [],
  fetchFailed: null,
  blocked: 'already up to date',
  ...over,
})

const behind = (id: string, over: Partial<Checkout> = {}) => one(id, { behind: 2, blocked: null, ...over })
const waiting = (id: string, over: Partial<Checkout> = {}) => one(id, { waiting: true, ...over })

const check = (checkouts: Checkout[]): Check =>
  ({ checked: new Date(), checkouts, pins: {}, restartable: false, progress: {}, stale: {}, older: {}, previews: {}, kept: [], protocol: null, builds: {}, auto: null }) as unknown as Check

describe('the sets "Update all" works over', () => {
  const all = [
    behind('ready'),
    waiting('waits'),
    behind('dirty', { dirty: true, blocked: 'there are uncommitted changes; commit or stash them first' }),
    one('level'),
  ]
  test('ready, unfetched and blocked are told apart', () => {
    const sets = updateSets(all)
    expect(sets.ready.map((c) => c.id)).toEqual(['ready'])
    expect(sets.unfetched.map((c) => c.id)).toEqual(['waits'])
    expect(sets.blocked.map((c) => c.id)).toEqual(['dirty'])
  })

  test('a waiting checkout says it was not fetched, and what else stands in the way', () => {
    expect(skipReason(waiting('a'))).toBe(NOT_FETCHED)
    expect(skipReason(waiting('a', { blocked: 'there are uncommitted changes; commit or stash them first' }))).toContain('uncommitted changes')
    expect(skipReason(waiting('a', { fetchFailed: 'offline' }))).toContain('offline')
    expect(skipReason(one('level'))).toBeNull()
    expect(skipReason(behind('ready'))).toBeNull()
    expect(skipReason(behind('own', { ahead: 1, blocked: 'main has 1 commit of its own that origin/main does not — pull or push it by hand' }))).toContain('of its own')
  })

  test('skipped modules are listed with why, pinned ones are not', () => {
    expect(skippedAfter(all).map((s) => s.id)).toEqual(['waits', 'dirty'])
    expect(skippedAfter(all, { waits: { containers: 1, versions: ['v1'] } }).map((s) => s.id)).toEqual(['dirty'])
    expect(unfetchedCount(all)).toBe(1)
    expect(unfetchedCount(all, { waits: { containers: 1, versions: ['v1'] } })).toBe(0)
  })
})

describe('the summary and tooltip never say up to date over unfetched commits', () => {
  const now = new Date()
  test('only local checkouts moved', () => {
    const c = check([waiting('a'), waiting('b')])
    const said = summaryOf(c, null, 0, 2)
    expect(said).toBe('2 local checkouts have new commits not fetched yet. Update all fetches them.')
    expect(said).not.toContain('up to date')
    const tip = tooltipFor(c, null, 0, now, false, 1)
    expect(tip).toContain('1 local checkout has new commits not fetched yet')
    expect(tip).not.toContain('up to date')
  })
  test('mixed with fetched updates', () => {
    const c = check([behind('a'), waiting('b')])
    expect(summaryOf(c, null, 2, 1)).toBe('2 new commits across 1 repository. 1 local checkout has new commits not fetched yet.')
    expect(tooltipFor(c, null, 2, now, false, 1)).toContain('2 new commits waiting, 1 local checkout has')
  })
  test('really level still says so', () => {
    expect(summaryOf(check([one('a')]), null, 0, 0)).toBe('Everything is up to date with GitHub.')
    expect(tooltipFor(check([one('a')]), null, 0, now, false)).toContain('everything is up to date')
  })
})
