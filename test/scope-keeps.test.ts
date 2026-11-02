import { describe, expect, test } from 'bun:test'
import type { ModuleScope } from 'kehikot-module-protocol'

import { toStart, toStop, wanted, GRACE_MS, type Standing } from '../server/lifecycle.ts'
import { framesKept, KEPT_KEHIKOT, recentlyOpen, type Canvas } from '@/host/canvases.ts'
import { keptScope, scopeKeeps } from '@/host/scope.ts'

/**
 * A container's scope is the person's choice, and it says how long its module
 * is wanted: at This computer always, at Project while in its project. Both
 * halves of keeping read it — the host's processes (`wanted`) and the page's
 * frames (`framesKept`). See `scopeKeeps` in `host/scope.ts`.
 */

const NOW = 1_700_000_000_000

/* Containers as `[module, scope]`: the scope in use, as `keptScope` would give it. */
type Placed = readonly [string, ModuleScope | null]
const k = (id: number, project: number | null, ...placed: Placed[]) => ({
  id,
  key: `k${id}`,
  name: `K${id}`,
  project,
  placements: placed.map(([i, scope]) => ({ i, scope })),
})
const inUse = (placement: { scope?: string | null }) => (placement.scope ?? null) as ModuleScope | null

/* Project 10 has kehikot 1, 2, 3; project 20 has 4. */
const canvases = [
  k(1, 10, ['kehikot.tests', 'machine'], ['kehikot.notes', 'project'], ['kehikot.flows', 'epic']),
  k(2, 10, ['kehikot.board', 'kehikko']),
  k(3, 10, ['kehikot.part', 'part']),
  k(4, 20, ['kehikot.other', 'epic']),
]

describe('the rule', () => {
  const open = new Set([10])

  test('This computer keeps, whatever is open, and in no project', () => {
    expect(scopeKeeps('machine', 10, open)).toBe(true)
    expect(scopeKeeps('machine', 20, new Set())).toBe(true)
    expect(scopeKeeps('machine', null, new Set())).toBe(true)
  })

  test('Project keeps while its project is open, and not after', () => {
    expect(scopeKeeps('project', 10, open)).toBe(true)
    expect(scopeKeeps('project', 20, open)).toBe(false)
    expect(scopeKeeps('project', null, open)).toBe(false)
  })

  test('Epic, Part, Kehikko and an unread module keep nothing', () => {
    for (const scope of ['epic', 'part', 'kehikko', null] as const) expect(scopeKeeps(scope, 10, open)).toBe(false)
  })

  test('the scope in use is the pick the module offers, else its default; unread is none', () => {
    const module = { modes: [{ id: 'all', label: 'All', scope: 'machine' }, { id: 'here', label: 'Here', scope: 'project' }] }
    expect(keptScope(module as never, null)).toBe('machine')
    expect(keptScope(module as never, 'project')).toBe('project')
    /* A pick the module no longer offers reads as its default. */
    expect(keptScope(module as never, 'part')).toBe('machine')
    expect(keptScope(null, 'machine')).toBeNull()
  })
})

describe('the processes', () => {
  test('a module at This computer is needed with another project open, or none', () => {
    expect(wanted(canvases, new Set([4]), true, inUse).needed.has('kehikot.tests')).toBe(true)
    expect(wanted(canvases, new Set(), true, inUse).needed.has('kehikot.tests')).toBe(true)
  })

  test('a module at Project is needed from any kehikko of its project, even with "keep running" off', () => {
    const got = wanted(canvases, new Set([2]), false, inUse)
    expect(got.needed.has('kehikot.notes')).toBe(true)
    expect(got.warm.size).toBe(0)
  })

  test('switching project puts a module at Project back on the ordinary rules', () => {
    const got = wanted(canvases, new Set([4]), true, inUse)
    expect(got.needed.has('kehikot.notes')).toBe(false)
    expect(got.warm.has('kehikot.notes')).toBe(false)
  })

  test('Epic, Part and Kehikko change nothing', () => {
    const got = wanted(canvases, new Set([2]), true, inUse)
    expect([...got.needed].sort()).toEqual(['kehikot.board', 'kehikot.notes', 'kehikot.tests'])
    expect([...got.warm.keys()].sort()).toEqual(['kehikot.flows', 'kehikot.part'])
    expect(wanted(canvases, new Set([4]), true, inUse).needed.has('kehikot.flows')).toBe(false)
  })

  test('without a scope to go by, today’s rule exactly', () => {
    expect(wanted(canvases, new Set([4]), true)).toEqual({ needed: new Set(['kehikot.other']), warm: new Map() })
  })

  test('kept means never stopped, however long nobody looked, and started again when it went down', () => {
    const needed = wanted(canvases, new Set([4]), true, inUse).needed
    const tests: Standing = {
      id: 'kehikot.tests',
      needed: needed.has('kehikot.tests'),
      answering: true,
      startable: true,
      ours: true,
      keep: false,
      idleSince: NOW - 10 * GRACE_MS,
      starting: false,
    }
    expect(toStop([tests], NOW)).toEqual([])
    expect(toStart([{ ...tests, answering: false, ours: false }])).toEqual(['kehikot.tests'])
    /* The same container at Epic is stopped as before. */
    const atEpic = wanted([k(1, 10, ['kehikot.tests', 'epic'])], new Set([4]), true, inUse).needed
    expect(toStop([{ ...tests, needed: atEpic.has('kehikot.tests') }], NOW)).toEqual(['kehikot.tests'])
  })
})

describe('the pages', () => {
  const all = canvases as unknown as Canvas[]
  const scopeOf = (p: { scope?: string | null }) => inUse(p)
  const visit = (...opens: number[]) => opens.reduce<number[]>((recent, open) => recentlyOpen(recent, open), [])

  test('a page at This computer stays after its kehikko, and its project, are left', () => {
    expect(framesKept(all, visit(1, 4), scopeOf).has('kehikot.tests')).toBe(true)
  })

  test('and does not count against the kehikot kept', () => {
    /* Many more kehikot than are kept, the first long gone from the list. */
    const many = [...all, k(5, 20), k(6, 20), k(7, 20)] as unknown as Canvas[]
    const recent = visit(1, 4, 5, 6, 7)
    expect(recent).toHaveLength(KEPT_KEHIKOT + 1)
    expect(recent.includes(1)).toBe(false)
    expect(framesKept(many, recent, scopeOf).has('kehikot.tests')).toBe(true)
    expect(framesKept(many, recent, scopeOf).has('kehikot.flows')).toBe(false)
  })

  test('a page at Project stays across its project’s kehikot, and goes with the project', () => {
    const within = [...all, k(5, 10), k(6, 10), k(7, 10)] as unknown as Canvas[]
    expect(framesKept(within, visit(1, 5, 6, 7), scopeOf).has('kehikot.notes')).toBe(true)
    expect(framesKept(all, visit(1, 4), scopeOf).has('kehikot.notes')).toBe(true)
    const away = [...all, k(5, 20), k(6, 20)] as unknown as Canvas[]
    expect(framesKept(away, visit(1, 4, 5, 6), scopeOf).has('kehikot.notes')).toBe(false)
  })

  test('without a scope to go by, the bound alone', () => {
    expect(framesKept(all, visit(1, 4))).toEqual(framesKept(all, visit(1, 4), () => null))
    const many = [...all, k(5, 20), k(6, 20), k(7, 20)] as unknown as Canvas[]
    expect(framesKept(many, visit(1, 4, 5, 6, 7)).has('kehikot.tests')).toBe(false)
  })
})
