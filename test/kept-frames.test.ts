import { describe, expect, test } from 'bun:test'

import { giveBackFocus, hiddenFrame } from '@/canvas/Frames.tsx'
import { framesKept, KEPT_KEHIKOT, recentlyOpen } from '@/host/canvases.ts'
import { toWireContext, whileAway } from '@/host/context.ts'
import type { Canvas } from '@/host/canvases.ts'

/**
 * Switching back to a kehikko shows its pages at once: they are kept, hidden
 * and inert, for the last few kehikot left, and a hidden page is not told the
 * open kehikko's context. See `Frames.tsx`.
 */

const canvas = (id: number, ...modules: string[]): Canvas =>
  ({ id, key: `k${id}`, name: `K${id}`, project: 1, placements: modules.map((i) => ({ i })) }) as unknown as Canvas

describe('which kehikot keep their pages', () => {
  test('the open one first, then the ones left, most recent first, at most two of them', () => {
    expect(KEPT_KEHIKOT).toBe(2)
    let recent: number[] = []
    for (const open of [1, 2, 3]) recent = recentlyOpen(recent, open)
    expect(recent).toEqual([3, 2, 1])
    /* A fourth drops the oldest. */
    recent = recentlyOpen(recent, 4)
    expect(recent).toEqual([4, 3, 2])
    /* Going back moves it to the front, and keeps each once. */
    recent = recentlyOpen(recent, 2)
    expect(recent).toEqual([2, 4, 3])
    /* The same one again changes nothing. */
    expect(recentlyOpen(recent, 2)).toEqual([2, 4, 3])
  })

  test('nothing open keeps what was left', () => {
    expect(recentlyOpen([2, 4, 3], null)).toEqual([2, 4, 3])
  })

  test('a page stays while its module is on a kept kehikko, and goes when none is', () => {
    const canvases = [canvas(1, 'kehikot.a', 'kehikot.b'), canvas(2, 'kehikot.c'), canvas(3, 'kehikot.d'), canvas(4, 'kehikot.b', 'kehikot.e')]
    expect([...framesKept(canvases, [4, 3, 2])].sort()).toEqual(['kehikot.b', 'kehikot.c', 'kehikot.d', 'kehikot.e'])
    /* kehikot.a was only on kehikko 1, the oldest, which fell off. */
    expect(framesKept(canvases, [4, 3, 2]).has('kehikot.a')).toBe(false)
    /* kehikot.b is also on kehikko 4, so it stays. */
    expect(framesKept(canvases, [4]).has('kehikot.b')).toBe(true)
  })
})

describe('a hidden page', () => {
  test('is inert and hidden from readers; a shown one is neither', () => {
    expect(hiddenFrame(false)).toEqual({ inert: true, 'aria-hidden': true })
    expect(hiddenFrame(true)).toEqual({})
  })
})

describe('a hidden page does not keep the focus', () => {
  /* The element that has the focus, inside the frame of `id` (or the host's own, for null). */
  const focused = (id: string | null) => {
    const blurred = { n: 0 }
    const active = {
      closest: (selector: string) => (selector === '[data-frame]' && id ? { getAttribute: (name: string) => (name === 'data-frame' ? id : null) } : null),
      blur: () => {
        blurred.n += 1
      },
    }
    return { doc: { activeElement: active } as unknown as Pick<Document, 'activeElement'>, blurred }
  }

  test('a page that is hidden with the focus in it gives it back — keystrokes never go to a terminal nobody sees', () => {
    const { doc, blurred } = focused('kehikot.claude')
    expect(giveBackFocus(doc, new Set(['kehikot.claude']))).toBe(true)
    expect(blurred.n).toBe(1)
  })

  test('a shown page keeps it, and so does the host’s own page', () => {
    const shown = focused('kehikot.claude')
    expect(giveBackFocus(shown.doc, new Set(['kehikot.journeys']))).toBe(false)
    expect(shown.blurred.n).toBe(0)
    const host = focused(null)
    expect(giveBackFocus(host.doc, new Set(['kehikot.claude']))).toBe(false)
    expect(giveBackFocus({ activeElement: null }, new Set(['kehikot.claude']))).toBe(false)
  })
})

describe('what a page on a kehikko that is not open is told', () => {
  const project = { id: 1, name: 'webapp', path: '/w/webapp', epics: true, git: true, shared: false }
  const held = { ...toWireContext({ epic: 'on-its-own-kehikko', project }, 'dark', [], null, null), prompt: 'its own prompt' }

  test('nothing, when only the open kehikko moved: its place is its own kehikko', () => {
    const told = { ...toWireContext({ epic: 'something-else', project }, 'dark', [], null, null), prompt: 'the open kehikko’s prompt' }
    expect(whileAway(held, told)).toBeNull()
  })

  test('the theme, and only the theme', () => {
    const told = { ...toWireContext({ epic: 'something-else', project: null }, 'light', [], null, null), prompt: null }
    const sent = whileAway(held, told)!
    expect(sent.theme).toBe('light')
    expect(sent.epic).toBe('on-its-own-kehikko')
    expect(sent.project).toBe('webapp')
    expect(sent.prompt).toBe('its own prompt')
  })

  test('nothing before anything was sent', () => {
    expect(whileAway(null, held)).toBeNull()
  })
})
