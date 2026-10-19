import { beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { activitySetResult, type ActivityItem } from 'kehikot-module-protocol'

import { ActivityDot, dotClasses } from '../src/canvas/Activity.tsx'
import { Canvases } from '../src/canvas/Canvases.tsx'
import { InboxControl, InboxPanel, controlWords, type InboxView } from '../src/canvas/Inbox.tsx'
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
import { tally, type Entry } from '../src/host/inbox.ts'

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

  const entry = (id: string, state: Entry['state'], more: Partial<Entry> = {}): Entry => ({
    module: 'kehikot.claude',
    name: 'Claude',
    id,
    state,
    label: id,
    priority: 'normal',
    refs: [],
    entered: Date.now() - 180_000,
    opened: Date.now() - 180_000,
    closed: null,
    how: null,
    seen: null,
    dismissed: null,
    origin: 'activity',
    ...more,
  })
  const names: Namer = { epic: () => 'The thesis', part: (_e, id) => (id === 'm' ? 'Methods' : null), kehikko: (k) => (k === 'k1' ? 'Writing' : null) }
  const view = (entries: Entry[], more: Partial<InboxView> = {}): InboxView => {
    const at = { epic: 'thesis', kehikko: 'k1' }
    return {
      entries,
      earlierCount: 0,
      at,
      scope: 'everywhere',
      onScope: () => {},
      names,
      tally: tally(entries, at),
      next: entries.find((one) => one.state === 'attention') ?? null,
      open: true,
      onOpenChange: () => {},
      onGo: () => {},
      onNext: () => {},
      onSee: () => {},
      onDismiss: () => {},
      onForget: () => {},
      onSeeAll: () => {},
      loadLog: async () => ({ rows: [], more: false, total: 0 }),
      rev: 1,
      shortcut: 'Alt+Shift+N',
      now: () => Date.now(),
      ...more,
    }
  }

  test('the control keeps the old footprint — a dot and the attention count — and says where things are in words', () => {
    const entries = [
      entry('a', 'attention', { place: { kehikko: 'k1' } }),
      entry('b', 'attention', { place: { kehikko: 'k2' } }),
      entry('c', 'attention', { place: { kehikko: 'k2' } }),
      entry('w', 'working'),
    ]
    const v = view(entries, { open: false })
    const html = renderToStaticMarkup(<TooltipProvider><InboxControl view={v} worst="attention" /></TooltipProvider>)
    expect(html).toContain('data-activity-count="">3<')
    expect(html).toContain('1 needs you here, 2 in other kehikot')
    expect(controlWords(tally([], { epic: null, kehikko: null }), 'Alt+Shift+N')).toContain('nothing new')
  })

  test('the panel: Next first, sections in order, by-line before the claim, place parts then epic, urgent marked', () => {
    const entries = [
      entry('done-one', 'done', { label: 'Draft finished', entered: Date.now() - 60_000 }),
      entry('work', 'working', { label: 'Compiling' }),
      entry('late', 'attention', { label: 'Pick a file', place: { epic: 'thesis', parts: ['m'], kehikko: 'k1' } }),
      entry('burning', 'attention', { label: 'Build broke', priority: 'urgent' }),
    ]
    const html = renderToStaticMarkup(<InboxPanel view={view(entries, { next: entries[3]! })} />)
    expect(html).toContain('Next:')
    expect(html).toContain('Alt+Shift+N')
    const order = ['Needs you', 'Working', 'Finished'].map((word) => html.indexOf(`>${word}<`))
    expect(order.every((at) => at > 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    /* The rows (not the Next button, which says the same label first). */
    const rows = html.split('<li data-inbox-row=').slice(1)
    expect(rows[0]).toContain('Build broke')
    expect(rows[1]).toContain('Pick a file')
    expect(rows[0]!.indexOf('Claude says')).toBeGreaterThan(-1)
    expect(rows[0]!.indexOf('Claude says')).toBeLessThan(rows[0]!.indexOf('Build broke'))
    expect(html).toContain('urgent')
    expect(html).toContain('Methods · Writing · The thesis')
    expect(html).toContain('3 min ago')
    expect(html).toContain('needs you')
    expect(html).toContain('dismiss Build broke')
  })

  test('empty and honest: nothing here, and what is elsewhere with a press to switch scope', () => {
    const elsewhere = [entry('x', 'attention', { place: { kehikko: 'k2' } }), entry('y', 'working', { place: { kehikko: 'k2' } })]
    const here = renderToStaticMarkup(<InboxPanel view={view(elsewhere, { scope: 'here' })} />)
    expect(here).toContain('Nothing needs you here.')
    expect(here).toContain('1 thing needs you elsewhere')
    expect(here).toContain('Show everywhere')
    const none = renderToStaticMarkup(<InboxPanel view={view([], { scope: 'everywhere', next: null })} />)
    expect(none).toContain('Nothing needs you.')
  })

  test('when the host cannot tell the kehikko it says so and shows everything, never a false empty list', () => {
    const unknown = renderToStaticMarkup(
      <InboxPanel view={view([entry('x', 'attention', { place: { kehikko: 'k2' } })], { scope: 'here', at: { epic: null, kehikko: null } })} />,
    )
    expect(unknown).toContain('cannot tell which kehikko is open')
    expect(unknown).toContain('Claude says')
  })

  test('items that name no kehikko are shown on this kehikko, and said so', () => {
    const html = renderToStaticMarkup(<InboxPanel view={view([entry('p', 'attention')], { scope: 'here' })} />)
    expect(html).toContain('does not say which kehikko it belongs to')
    expect(html).toContain('Claude says')
  })

  test('a group of one module folds into one row with a count', () => {
    const entries = [entry('t1', 'attention', { group: 'tests', label: 'Tests failed' }), entry('t2', 'attention', { group: 'tests', label: 'Tests failed' }), entry('t3', 'attention', { group: 'tests', label: 'Tests failed' })]
    const html = renderToStaticMarkup(<InboxPanel view={view(entries)} />)
    expect(html.match(/data-inbox-row=/g)).toHaveLength(1)
    expect(html).toContain('aria-expanded="false"')
    expect(html).toMatch(/tabular-nums[^>]*>[^<]*(<[^>]+>)*3</)
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
