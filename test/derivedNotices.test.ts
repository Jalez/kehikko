import { describe, expect, test } from 'bun:test'
import type { ActivityItem } from 'kehikot-module-protocol'

import {
  deriveNotices,
  noticeFor,
  readDerived,
  replaced,
  writeDerived,
  type Derived,
  type Held,
  type HeldItem,
  type Namer,
  type Where,
} from '../src/host/activity.ts'

const names: Namer = {
  epic: (slug) => (slug === 'thesis' ? 'Thesis' : null),
  part: (_e, id) => (id === 'p1' ? 'Methods' : null),
  kehikko: (key) => (key === 'k1' ? 'writing' : null),
}
const elsewhere: Where = { epic: 'other', parts: [], kehikko: null }
const place = { epic: 'thesis', parts: ['p1'], kehikko: 'k1' }

/** What the hook does on `activity.set`: hold the list, derive, remember. */
function driver(at: Where = elsewhere, loadedAt = 1000) {
  let held: Held = {}
  let derived: Derived = {}
  const greeted = new Set<string>()
  return {
    at,
    send(items: ActivityItem[], now: number, module = 'claude'): HeldItem[] {
      held = replaced(held, 1, module, items, now)
      const baseline = !greeted.has(module)
      greeted.add(module)
      const out = deriveNotices(held[1]?.[module] ?? [], derived, this.at, baseline, loadedAt)
      derived = out.derived
      return out.fire
    },
    /** A page reload: the lists and the greeting are gone, the derived set is what storage kept. */
    reload() {
      held = {}
      greeted.clear()
    },
    /** A module whose server came back (its list was dropped). */
    regreet() {
      greeted.clear()
    },
  }
}

describe('notices derived from activity', () => {
  test('entering attention or done is one notice, in the Claude module’s words and format', () => {
    const d = driver()
    expect(d.send([{ id: 's', state: 'working', label: 'tighten the methods', place }], 2000)).toEqual([])
    const fired = d.send([{ id: 's', state: 'attention', label: 'tighten the methods', place }], 3000)
    expect(fired).toHaveLength(1)
    expect(noticeFor(fired[0]!, d.at, names)).toEqual({
      epic: 'thesis',
      message: 'Waiting for you: “tighten the methods” — Thesis · Methods · writing',
      level: 'attention',
      refs: [],
      place: { epic: 'thesis', parts: ['p1'], kehikko: 'k1' },
    })
    const done = d.send([{ id: 's', state: 'done', label: 'tighten the methods', place, detail: 'two edits' }], 4000)
    expect(noticeFor(done[0]!, d.at, names)).toMatchObject({
      level: 'done',
      message: 'Finished: “tighten the methods” — Thesis · Methods · writing. two edits',
    })
  })

  test('a long detail is left out; no epic anywhere is no notice', () => {
    const item = { id: 's', state: 'done', label: 'x', module: 'm', entered: 1, detail: 'y'.repeat(200) } as HeldItem
    expect(noticeFor(item, { epic: 'thesis', parts: [], kehikko: null }, names)?.message).toBe('Finished: “x”')
    expect(noticeFor(item, { epic: null, parts: [], kehikko: null }, names)).toBeNull()
  })

  test('working is never told; an item on screen is not told, and not told later either', () => {
    const d = driver({ epic: 'thesis', parts: ['p1'], kehikko: 'k1' })
    d.send([{ id: 's', state: 'working', label: 'x', place }], 2000)
    expect(d.send([{ id: 's', state: 'attention', label: 'x', place }], 3000)).toEqual([])
    d.at = elsewhere
    expect(d.send([{ id: 's', state: 'attention', label: 'x', place }], 3500)).toEqual([])
  })

  test('the same since re-sent is not told again', () => {
    const d = driver()
    d.send([{ id: 's', state: 'working', label: 'x' }], 2000)
    expect(d.send([{ id: 's', state: 'attention', label: 'x', since: 2500 }], 3000)).toHaveLength(1)
    expect(d.send([{ id: 's', state: 'attention', label: 'x', since: 2500 }], 3100)).toEqual([])
    expect(d.send([{ id: 's', state: 'attention', label: 'x!', since: 2500 }], 3200)).toEqual([])
  })

  test('a page reload: the first list is a baseline and tells nothing already derived', () => {
    const d = driver()
    d.send([{ id: 's', state: 'working', label: 'x' }], 2000)
    expect(d.send([{ id: 's', state: 'done', label: 'x', since: 2500 }], 3000)).toHaveLength(1)
    d.reload()
    expect(d.send([{ id: 's', state: 'done', label: 'x', since: 2500 }], 5000)).toEqual([])
    /* An item with no since, held for the first time by a new page: nothing. */
    const e = driver()
    expect(e.send([{ id: 's', state: 'done', label: 'x' }], 6000)).toEqual([])
  })

  test('on the baseline, a since newer than the last derived is told once', () => {
    const d = driver()
    d.send([{ id: 's', state: 'done', label: 'x', since: 2500 }], 2600)
    d.reload()
    expect(d.send([{ id: 's', state: 'done', label: 'x', since: 4000 }], 5000)).toHaveLength(1)
    expect(d.send([{ id: 's', state: 'done', label: 'x', since: 4000 }], 5100)).toEqual([])
  })

  test('a module that restarts and greets again is a baseline', () => {
    const d = driver()
    d.send([{ id: 's', state: 'working', label: 'x' }], 2000)
    expect(d.send([{ id: 's', state: 'attention', label: 'x' }], 3000)).toHaveLength(1)
    d.regreet()
    expect(d.send([{ id: 's', state: 'attention', label: 'x' }], 9000)).toEqual([])
  })

  test('[] and then the item again is told by its entered', () => {
    const d = driver()
    d.send([{ id: 's', state: 'working', label: 'x' }], 2000)
    expect(d.send([{ id: 's', state: 'done', label: 'x' }], 3000)).toHaveLength(1)
    d.send([], 4000)
    expect(d.send([{ id: 's', state: 'done', label: 'x' }], 5000)).toHaveLength(1)
    /* With its own since, the same one is the same thing. */
    const e = driver()
    e.send([{ id: 's', state: 'done', label: 'x', since: 2500 }], 3000)
    e.send([], 4000)
    expect(e.send([{ id: 's', state: 'done', label: 'x', since: 2500 }], 5000)).toEqual([])
  })

  test('the derived set survives a reload through storage, per project, and a broken store is empty', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    writeDerived(storage, 1, { 'a\u0000b\u0000done': 5 })
    expect(readDerived(storage, 1)).toEqual({ 'a\u0000b\u0000done': 5 })
    expect(readDerived(storage, 2)).toEqual({})
    store.set('kehikot.activity.derived.1', '{nope')
    expect(readDerived(storage, 1)).toEqual({})
  })
})
