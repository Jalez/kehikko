import { describe, expect, test } from 'bun:test'

import { DEFAULT_CHIME, chimeFrom, chimePatched, kindOf } from '../src/host/chime.ts'
import type { Entry } from '../src/host/inbox.ts'
import { Gather, TOAST_MAX, TOAST_MS, countWords, placeWords, toastMs, toastOf, withToast, type Arrival, type Toast } from '../src/host/toasts.ts'

const entry = (id: string, state: Entry['state'], more: Partial<Entry> = {}): Entry => ({
  module: 'kehikot.claude', name: 'Claude', id, state, label: id, priority: 'normal', refs: [],
  entered: 1, opened: 1, closed: null, how: null, seen: null, dismissed: null, origin: 'activity', ...more,
})
const arrival = (e: Entry): Arrival => ({ entry: e, project: 1, by: 'Claude', place: 'Wide · methods' })

describe('what a toast shows', () => {
  test('the kind is the chime\'s: working is nothing, urgent is attention at urgent priority', () => {
    expect(toastOf(1, [arrival(entry('w', 'working'))])).toBeNull()
    expect(toastOf(1, [arrival(entry('u', 'attention', { priority: 'urgent' }))])?.kind).toBe('urgent')
    expect(toastOf(1, [arrival(entry('d', 'done'))])?.kind).toBe(kindOf(entry('d', 'done')) ?? undefined)
  })

  test('a burst is one toast with a count, the most urgent first', () => {
    const toast = toastOf(7, [arrival(entry('a', 'done')), arrival(entry('b', 'attention', { priority: 'urgent', label: 'Deploy' })), arrival(entry('c', 'attention'))])!
    expect(toast.count).toBe(3)
    expect(toast.kind).toBe('urgent')
    expect(toast.label).toBe('Deploy')
    expect(countWords(toast.count)).toBe('3 new in the Inbox')
  })

  test('a place in words: parts and kehikko, then the epic; another project says its name', () => {
    const names = { epic: () => 'methods', part: () => null, kehikko: () => 'Wide' }
    expect(placeWords(entry('a', 'done', { place: { epic: 'm', kehikko: 'k' } }), names, null)).toBe('Wide · methods')
    expect(placeWords(entry('a', 'done'), names, null)).toBe('the project')
    expect(placeWords(entry('a', 'done'), names, 'Portal')).toBe('Portal')
  })
})

describe('a glimpse, never sticky', () => {
  test('about 5 s, 8 s for what needs the person', () => {
    expect(toastMs('done')).toBe(TOAST_MS.glimpse)
    expect(toastMs('notice')).toBe(5000)
    expect(toastMs('attention')).toBe(TOAST_MS.needs)
    expect(toastMs('urgent')).toBe(8000)
  })

  test('at most three on screen; a newer one replaces the oldest', () => {
    const make = (id: number): Toast => toastOf(id, [arrival(entry(`e${id}`, 'done'))])!
    let shown: Toast[] = []
    for (let i = 1; i <= 5; i += 1) shown = withToast(shown, make(i))
    expect(TOAST_MAX).toBe(3)
    expect(shown.map((one) => one.id)).toEqual([3, 4, 5])
  })
})

describe('Gather: arrivals in a window are one batch', () => {
  test('three quick arrivals are handed over once; a later one is a batch of its own', () => {
    const batches: number[] = []
    const pending: (() => void)[] = []
    const gather = new Gather((batch) => batches.push(batch.length), 350, (run) => void pending.push(run))
    gather.offer(arrival(entry('a', 'done')))
    gather.offer(arrival(entry('b', 'done')))
    gather.offer(arrival(entry('c', 'done')))
    expect(pending).toHaveLength(1)
    pending.shift()!()
    gather.offer(arrival(entry('d', 'done')))
    pending.shift()!()
    expect(batches).toEqual([3, 1])
  })
})

describe('the setting', () => {
  test('on by default, kept apart from the sound\'s mute, and only a boolean is a change', () => {
    expect(DEFAULT_CHIME.toast).toBe(true)
    expect(chimeFrom({ on: false }).toast).toBe(true)
    const off = chimePatched(DEFAULT_CHIME, { toast: false })!
    expect(off.toast).toBe(false)
    expect(off.on).toBe(true)
    expect(chimePatched(DEFAULT_CHIME, { toast: 'no' })).toBeNull()
    expect(chimePatched(DEFAULT_CHIME, { on: false })!.toast).toBe(true)
  })

  test('the page tells the toast from the same news as the chime, and agents have no door to it', async () => {
    const app = await Bun.file(new URL('../src/App.tsx', import.meta.url)).text()
    const notify = app.slice(app.indexOf('notify: (entry, project) =>'))
    expect(notify.slice(0, 700)).toMatch(/chime\.offer\(kind, entry\.module, entry\.named\?\.id\)[\s\S]*toastRef\.current\(entry, project\)/)
    const mcp = await Bun.file(new URL('../server/mcp.ts', import.meta.url)).text()
    expect(mcp.toLowerCase()).not.toContain('toast')
  })
})
