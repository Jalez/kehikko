import { describe, expect, test } from 'bun:test'
import { expandResult } from 'kehikot-module-protocol'

import { makeAsk, type CanvasControls } from '@/host/ask.ts'
import { ANSWERED_BY_THE_VIEW } from '@/host/division.ts'
import { EXPANDED_BODY, EXPAND_WORD, SHRINK_WORD, expandAsked, expandedHere, shrinksOn, type Expanded } from '@/host/expand.ts'
import { FRAME_ENTRIES, FRAME_SAID, layoutOf, reachable } from '@/host/headerOffer.ts'
import { frameEntriesOf, type FrameParts } from '@/canvas/HeaderMenus.tsx'

/**
 * A container shown large over the canvas for a while, and put back (protocol 2.58.0,
 * `view.expand`; `host/expand.ts`). The page's alone: never a placement, never written.
 */

const ME = 'example.agent'
const base = { from: ME, expand: true, pressed: true, kehikko: 7, onOpen: true }

describe('expandAsked', () => {
  test('expands on the person press, for the asker’s own container on the open kehikko', () => {
    expect(expandAsked(null, base)).toEqual({ result: { outcome: 'expanded', why: '' }, next: { kehikko: 7, id: ME } })
  })

  test('declines without a press, off the open kehikko, or with a hand on a container', () => {
    expect(expandAsked(null, { ...base, pressed: false }).result).toMatchObject({ outcome: 'declined', why: expect.stringContaining('presses') })
    expect(expandAsked(null, { ...base, onOpen: false }).result.outcome).toBe('declined')
    expect(expandAsked(null, { ...base, kehikko: null }).result.outcome).toBe('declined')
    expect(expandAsked(null, { ...base, busy: 'A container is being moved.' })).toEqual({ result: { outcome: 'declined', why: 'A container is being moved.' }, next: null })
  })

  test('already large is unchanged; another container large is replaced by this one', () => {
    const mine: Expanded = { kehikko: 7, id: ME }
    expect(expandAsked(mine, base)).toEqual({ result: { outcome: 'unchanged', why: '' }, next: mine })
    expect(expandAsked({ kehikko: 7, id: 'other.module' }, base).next).toEqual(mine)
  })

  test('putting back needs no press, and touches only the asker’s own', () => {
    const mine: Expanded = { kehikko: 7, id: ME }
    expect(expandAsked(mine, { ...base, expand: false, pressed: false })).toEqual({ result: { outcome: 'shrunk', why: '' }, next: null })
    const other: Expanded = { kehikko: 7, id: 'other.module' }
    expect(expandAsked(other, { ...base, expand: false })).toEqual({ result: { outcome: 'unchanged', why: '' }, next: other })
    expect(expandAsked(null, { ...base, expand: false }).result.outcome).toBe('unchanged')
  })

  test('every answer is the protocol’s shape', () => {
    for (const call of [base, { ...base, pressed: false }, { ...base, expand: false }]) expect(expandResult.safeParse(expandAsked(null, call).result).success).toBe(true)
  })
})

describe('expandedHere', () => {
  const placed = [{ i: ME }, { i: 'folded.one', collapsed: true }]
  const page = () => true
  test('the expanded container while it is placed, open and showing its page', () => {
    expect(expandedHere({ kehikko: 7, id: ME }, 7, placed, page)).toBe(ME)
  })
  test('put back when it is on another kehikko, removed, folded or not showing its page', () => {
    expect(expandedHere({ kehikko: 8, id: ME }, 7, placed, page)).toBeNull()
    expect(expandedHere({ kehikko: 7, id: 'gone.one' }, 7, placed, page)).toBeNull()
    expect(expandedHere({ kehikko: 7, id: 'folded.one' }, 7, placed, page)).toBeNull()
    expect(expandedHere({ kehikko: 7, id: ME }, 7, placed, () => false)).toBeNull()
    expect(expandedHere(null, 7, placed, page)).toBeNull()
  })
})

test('Escape puts it back; the panel body is measured under a key no module id can be', () => {
  expect(shrinksOn('Escape')).toBe(true)
  expect(shrinksOn('Enter')).toBe(false)
  expect(EXPANDED_BODY.startsWith('#')).toBe(true)
  expect([EXPAND_WORD, SHRINK_WORD]).toEqual(['Expand', 'Shrink back'])
})

describe('view.expand on the wire', () => {
  const asked: { from: string; expand: boolean; pressed: boolean }[] = []
  const controls = {
    expand: (from: string, call: { expand: boolean }, pressed: boolean) => {
      asked.push({ from, expand: call.expand, pressed })
      return pressed || !call.expand ? { outcome: call.expand ? 'expanded' : 'shrunk', why: '' } : { outcome: 'declined', why: 'no press' }
    },
  } as unknown as CanvasControls

  test('is answered by the page', () => {
    expect(ANSWERED_BY_THE_VIEW as readonly string[]).toContain('view.expand')
  })

  test('carries who asked and whether the press was fresh', async () => {
    asked.length = 0
    const ask = makeAsk(ME, controls)
    expect(await ask('view.expand', {}, { pressed: true })).toEqual({ ok: true, data: { outcome: 'expanded', why: '' } })
    expect(await ask('view.expand', { expand: true })).toEqual({ ok: true, data: { outcome: 'declined', why: 'no press' } })
    expect(await ask('view.expand', { expand: false })).toEqual({ ok: true, data: { outcome: 'shrunk', why: '' } })
    expect(asked).toEqual([
      { from: ME, expand: true, pressed: true },
      { from: ME, expand: true, pressed: false },
      { from: ME, expand: false, pressed: false },
    ])
    expect((await ask('view.expand', { expand: 'yes' })).ok).toBe(false)
  })

  test('a canvas without it declines; a module that did not declare view:expand is declined', async () => {
    expect(await makeAsk(ME, {} as CanvasControls)('view.expand', {}, { pressed: true })).toEqual({ ok: true, data: { outcome: 'declined', why: 'This canvas shows nothing large.' } })
    const out = await makeAsk(ME, controls, () => false)('view.expand', {}, { pressed: true })
    expect(out.ok).toBe(true)
    if (out.ok) expect((out.data as { outcome: string }).outcome).toBe('declined')
  })
})

describe('Expand in the Container menu', () => {
  const parts = (expand?: FrameParts['expand']): FrameParts =>
    ({ module: ME, name: 'Agent', feedback: {} as FrameParts['feedback'], agent: undefined, onTools: () => {}, prompted: false, onPrompts: () => {}, expand }) as FrameParts

  test('a row while offered, first after the standing rows, at every width', () => {
    expect(FRAME_ENTRIES.indexOf('expand')).toBe(FRAME_ENTRIES.indexOf('standing') + 1)
    expect(FRAME_SAID.expand).toBe('show large')
    expect(frameEntriesOf(parts())).not.toContain('expand')
    const entries = frameEntriesOf(parts({ on: false, onChange: () => {} }))
    expect(entries).toContain('expand')
    for (const mode of ['words', 'icons', 'merged'] as const) {
      expect(reachable(layoutOf({ items: [], frame: entries }, mode, true))).toContain('frame:expand')
    }
  })
})
