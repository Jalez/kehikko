import { beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { activitySetResult, type ActivityItem } from 'kehikot-module-protocol'

import { ActivityDot, dotClasses } from '../src/canvas/Activity.tsx'
import { Canvases } from '../src/canvas/Canvases.tsx'
import { Parts } from '../src/canvas/Parts.tsx'
import { TooltipProvider } from '../src/components/ui/tooltip.tsx'
import {
  ACTIVITY_WORDS,
  clearStored,
  epicMarks,
  kehikkoMarks,
  moduleMark,
  partMarks,
  placeOpened,
  placeWords,
  storedFor,
  type HeldItem,
  type Namer,
} from '../src/host/activity.ts'
import { answeredFor } from '../src/host/division.ts'
import { makeAsk, type CanvasControls } from '../src/host/ask.ts'

/*
 * Shared activity states, the host's half (protocol 1.5.0, docs/activity.md):
 * held per project and module and replaced whole, dropped when a module stops
 * answering, aggregated onto epics / parts / kehikot, seen once the person has
 * been to the place, drawn as dots whose words are never only colour, listed
 * for an agent in `read_canvas`.
 */

const item = (over: Partial<ActivityItem> & { id: string }): ActivityItem => ({
  state: 'working',
  label: over.id,
  ...over,
})

const items = (...list: Array<ActivityItem & { module?: string }>): HeldItem[] =>
  list.map((one, i) => ({ module: 'm', entered: one.since ?? i + 1, ...one }))

describe('aggregation', () => {
  test('attention beats working beats done, on a container', () => {
    const held = items(item({ id: 'a', state: 'done' }), item({ id: 'b', state: 'working' }), item({ id: 'c', state: 'attention' }))
    expect(moduleMark(held, 'm')).toBe('attention')
    expect(moduleMark(held.slice(0, 2), 'm')).toBe('working')
    expect(moduleMark(held.slice(0, 1), 'm')).toBe('done')
    expect(moduleMark(held, 'other')).toBeNull()
  })

  test('an epic holds its own items and those naming its parts; a part is the open epic’s; a kehikko by key', () => {
    const held = items(
      item({ id: 'a', state: 'done', place: { epic: 'thesis' } }),
      item({ id: 'b', state: 'working', place: { epic: 'thesis', parts: ['intro', 'method'] } }),
      item({ id: 'c', state: 'attention', place: { epic: 'other', parts: ['intro'] } }),
      item({ id: 'd', state: 'done', place: { kehikko: 'writing' } }),
      item({ id: 'e', state: 'working' }),
    )
    const epics = epicMarks(held, 'thesis')
    expect(epics.get('thesis')).toBe('working')
    expect(epics.get('other')).toBe('attention')
    const parts = partMarks(held, 'thesis')
    expect([...parts]).toEqual([['intro', 'working'], ['method', 'working']])
    expect(partMarks(held, 'other').get('intro')).toBe('attention')
    expect([...kehikkoMarks(held)]).toEqual([['writing', 'done']])
  })

  test('an item naming something that does not exist marks nothing known, and is still a row', () => {
    const held = items(item({ id: 'a', state: 'attention', place: { epic: 'gone', parts: ['x'], kehikko: 'nowhere' } }))
    expect(epicMarks(held, 'thesis').get('thesis')).toBeUndefined()
    expect(partMarks(held, 'thesis').size).toBe(0)
    expect(placeWords(held[0]!.place, { epic: () => null, part: () => null, kehikko: () => null })).toBe('gone · x · nowhere')
  })
})

describe('arriving, and what this browser kept before the Inbox', () => {
  const done = items(item({ id: 'a', state: 'done', since: 100, place: { epic: 'thesis', parts: ['intro'], kehikko: 'k1' } }))

  test('arriving at the place — epic, parts, kehikko — opens it; arriving at part of it does not', () => {
    expect(placeOpened(done[0]!.place, { epic: 'thesis', parts: [], kehikko: 'k1' })).toBe(true)
    expect(placeOpened(done[0]!.place, { epic: 'thesis', parts: ['intro', 'method'], kehikko: 'k1' })).toBe(true)
    expect(placeOpened(done[0]!.place, { epic: 'thesis', parts: ['method'], kehikko: 'k1' })).toBe(false)
    expect(placeOpened(done[0]!.place, { epic: 'thesis', parts: [], kehikko: 'k2' })).toBe(false)
    expect(placeOpened(done[0]!.place, { epic: 'other', parts: [], kehikko: 'k1' })).toBe(false)
    expect(placeOpened(undefined, { epic: 'thesis', parts: [], kehikko: 'k1' })).toBe(false)
    expect(placeOpened({}, { epic: 'thesis', parts: [], kehikko: 'k1' })).toBe(false)
  })

  test('a kehikko-only and an epic-only place each open on their own piece', () => {
    expect(placeOpened({ kehikko: 'k1' }, { epic: null, parts: [], kehikko: 'k1' })).toBe(true)
    expect(placeOpened({ epic: 'thesis' }, { epic: 'thesis', parts: [], kehikko: null })).toBe(true)
  })

  test('the seen and told sets of the old storage are read per project, handed over, and removed; a broken one is empty', () => {
    const store = new Map<string, string>([
      ['kehikot.activity.seen.7', JSON.stringify({ 'm\u0000a': 100, bad: 'x' })],
      ['kehikot.activity.derived.7', JSON.stringify({ 'm\u0000a\u0000done': 100 })],
    ])
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => void store.delete(key),
    }
    expect(storedFor(storage, 7)).toEqual({ seen: { 'm\u0000a': 100 }, told: { 'm\u0000a\u0000done': 100 } })
    expect(storedFor(storage, 8)).toBeNull()
    clearStored(storage, 7)
    expect(storedFor(storage, 7)).toBeNull()
    store.set('kehikot.activity.seen.7', '[not json')
    expect(storedFor(storage, 7)).toEqual({ seen: {}, told: {} })
    expect(() => clearStored(null, 7)).not.toThrow()
    expect(storedFor(null, 7)).toBeNull()
  })
})

describe('words', () => {
  const names: Namer = {
    epic: (slug) => (slug === 'thesis' ? 'The thesis' : null),
    part: (_epic, id) => (id === 'intro' ? 'Introduction' : null),
    kehikko: (key) => (key === 'k1' ? 'Writing' : null),
  }
  test('the place in words: epic · parts · kehikko, falling back to the id', () => {
    expect(placeWords({ epic: 'thesis', parts: ['intro', 'zzz'], kehikko: 'k1' }, names)).toBe('The thesis · Introduction, zzz · Writing')
    expect(placeWords(undefined, names)).toBe('')
  })
  test('each state carries a word', () => {
    expect(ACTIVITY_WORDS).toEqual({ attention: 'needs your attention', done: 'finished', working: 'working' })
  })
})

describe('the dots', () => {
  test('each dot says its state in words, to assistive technology and in its label', () => {
    for (const state of ['attention', 'done', 'working'] as const) {
      const html = renderToStaticMarkup(<ActivityDot state={state} />)
      expect(html).toContain(`aria-label="${ACTIVITY_WORDS[state]}"`)
    }
    expect(renderToStaticMarkup(<ActivityDot state="working" what="Thesis" />)).toContain('Thesis — working')
  })

  test('working pulses only where motion is welcome and is a still ring where it is not', () => {
    const working = dotClasses('working')
    expect(working).toContain('motion-safe:animate-pulse')
    expect(working).toContain('motion-reduce:ring-')
    expect(working).toContain('motion-reduce:bg-transparent')
    expect(dotClasses('attention')).not.toContain('animate')
    expect(dotClasses('done')).not.toContain('animate')
    expect(dotClasses('attention')).toContain('amber')
    expect(dotClasses('done')).toContain('emerald')
  })

  test('a part row and a kehikko row carry a dot where something there holds activity, and none elsewhere', () => {
    const parts = [
      { id: 'intro', heading: 'Introduction', refs: [], steps: 0 },
      { id: 'method', heading: 'Method', refs: [], steps: 0 },
    ]
    const bare = renderToStaticMarkup(<TooltipProvider><Parts parts={parts} picked={[]} onPick={() => {}} epic="thesis" /></TooltipProvider>)
    expect(bare).not.toContain('data-activity')
    /* Narrowed to one part, with something in the other: the closed control says so. */
    const narrowed = renderToStaticMarkup(
      <TooltipProvider>
        <Parts parts={parts} picked={['intro']} onPick={() => {}} epic="thesis" marks={new Map([['method', 'attention' as const]])} />
      </TooltipProvider>,
    )
    expect(narrowed).toContain('data-activity="attention"')
    const canvases = [
      { id: 1, key: 'k1', name: 'One', placements: [] },
      { id: 2, key: 'k2', name: 'Two', placements: [] },
    ] as never
    const switcher = renderToStaticMarkup(
      <TooltipProvider>
        <Canvases canvases={canvases} open={(canvases as unknown as never[])[0] as never} onOpen={() => {}} onRename={() => {}} onCreate={() => {}} onDelete={() => {}} marks={new Map([['k2', 'done' as const]])} />
      </TooltipProvider>,
    )
    expect(switcher).toContain('data-activity="done"')
  })
})

describe('activity.set at the canvas', () => {
  const ME = 'example.module'
  const taken: Array<[string, ActivityItem[]]> = []
  const canvas = {
    showEpic: () => {},
    goto: () => ({ outcome: 'declined', epic: null, why: '' }),
    select: () => {},
    point: () => {},
    show: () => {},
    emit: () => ({ ok: true, delivered: 0 }),
    filter: () => ({ ok: true, filters: {} }),
    pickProject: async () => ({ outcome: 'cancelled', project: null, why: '' }),
    fold: () => ({ outcome: 'unchanged', folded: [], unfolded: [], why: '' }),
    project: () => 1,
    activity: (from: string, list: ActivityItem[]) => {
      taken.push([from, list])
      return { outcome: 'taken' as const, taken: list.length, why: '' }
    },
  } as unknown as CanvasControls
  beforeEach(() => void (taken.length = 0))

  test('a module that declared the grant is answered, with its own id and the parsed list', async () => {
    const out = await makeAsk(ME, canvas, (c) => c === 'activity:report')('activity.set', { items: [{ id: 'a', state: 'attention', label: 'L' }] })
    expect(out.ok).toBe(true)
    if (out.ok) expect(activitySetResult.parse(out.data)).toEqual({ outcome: 'taken', taken: 1, why: '' })
    expect(taken).toEqual([[ME, [{ id: 'a', state: 'attention', label: 'L' }]]])
  })

  test('a module without the grant is refused with the sentence, and nothing is held', async () => {
    const out = await makeAsk(ME, canvas, () => false)('activity.set', { items: [] })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.error).toContain('activity:report')
      expect(out.error).toContain('declares.uses')
    }
    expect(taken).toEqual([])
  })

  test('a list the protocol refuses (a duplicate id, a long label) is refused, not clipped', async () => {
    const ask = makeAsk(ME, canvas, () => true)
    const twice = await ask('activity.set', { items: [{ id: 'a', state: 'done', label: 'x' }, { id: 'a', state: 'done', label: 'y' }] })
    expect(twice.ok).toBe(false)
    const long = await ask('activity.set', { items: [{ id: 'a', state: 'done', label: 'x'.repeat(121) }] })
    expect(long.ok).toBe(false)
    expect(taken).toEqual([])
  })

  test('the greeting’s answers lists activity.set only for a module that declared the grant', () => {
    expect(answeredFor(['activity:report'])).toContain('activity.set')
    expect(answeredFor([])).not.toContain('activity.set')
    expect(answeredFor(['epics:read'])).not.toContain('activity.set')
  })
})
