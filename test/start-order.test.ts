import { describe, expect, test } from 'bun:test'

import { bootReadsNow, DEFER_FOR_MS, deferredMayRun } from '../server/startOrder.ts'
import { pageStep, StartupTimeline } from '../server/startupTimeline.ts'

const wanted = (needed: string[], warm: [string, number][] = []) => ({ needed: new Set(needed), warm: new Map(warm) })

describe('bootReadsNow: the open kehikko’s copies are read first, together', () => {
  test('every copy on the open kehikko is read at once, and nothing else meanwhile', () => {
    const held = ['a', 'b', 'c', 'd', 'e', 'f']
    expect(bootReadsNow(held, new Set(), wanted(['e', 'b', 'f']))).toEqual(['b', 'e', 'f'])
  })

  test('nothing else starts while one of the open kehikko’s copies is still being read', () => {
    expect(bootReadsNow(['a', 'b', 'c'], new Set(['b']), wanted(['b']))).toEqual([])
  })

  test('with none of them left, the rest go a few at a time: warm in its order first, then by id', () => {
    const held = ['z', 'y', 'w2', 'w1', 'x']
    expect(bootReadsNow(held, new Set(), wanted([], [['w1', 0], ['w2', 1]]), 3)).toEqual(['w1', 'w2', 'x'])
  })

  test('the few at a time counts the ones already being read', () => {
    const held = ['a', 'b', 'c', 'd', 'e']
    expect(bootReadsNow(held, new Set(['a', 'b']), wanted([]), 3)).toEqual(['c'])
    expect(bootReadsNow(held, new Set(['a', 'b', 'c']), wanted([]), 3)).toEqual([])
  })

  test('a kehikko opened while others are being read: its copies start at once, beside them', () => {
    expect(bootReadsNow(['a', 'b', 'c', 'd'], new Set(['a', 'b', 'c']), wanted(['d']), 3)).toEqual(['d'])
  })

  test('nothing held, nothing read', () => {
    expect(bootReadsNow([], new Set(), wanted(['a']))).toEqual([])
  })
})

describe('deferredMayRun: work that does not show the open kehikko waits for it', () => {
  test('not before the open kehikko is up', () => {
    expect(deferredMayRun(1_000, 0, null)).toBe(false)
  })
  test('once it is up', () => {
    expect(deferredMayRun(1_000, 0, 900)).toBe(true)
  })
  test('and at the latest after the deferral, with no kehikko up at all', () => {
    expect(deferredMayRun(DEFER_FOR_MS - 1, 0, null)).toBe(false)
    expect(deferredMayRun(DEFER_FOR_MS, 0, null)).toBe(true)
  })
})

describe('StartupTimeline', () => {
  test('a step is kept the first time it happens, and listed in order', () => {
    let now = 0
    const lines: string[] = []
    const t = new StartupTimeline(() => now, (line) => lines.push(line))
    now = 50
    t.mark('listening')
    now = 10
    t.mark('server code loaded')
    now = 900
    t.mark('listening')
    expect(t.list()).toEqual([
      { step: 'server code loaded', at: 10 },
      { step: 'listening', at: 50 },
    ])
    t.mark('page first paint', 400.4)
    expect(t.at('page first paint')).toBe(400)
  })

  test('written to the log once', () => {
    const lines: string[] = []
    const t = new StartupTimeline(() => 5, (line) => lines.push(line))
    t.mark('listening')
    t.write('settled')
    t.write('again')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('startup timeline (settled)')
    expect(lines[0]).toContain('listening')
  })

  test('a page reports only its own steps', () => {
    expect(pageStep('page first paint')).toBe('page first paint')
    expect(pageStep('greeted kehikot.paper')).toBe('greeted kehikot.paper')
    expect(pageStep('listening')).toBeNull()
    expect(pageStep('greeted <b>')).toBeNull()
    expect(pageStep(3)).toBeNull()
  })
})
