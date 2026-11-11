import { describe, expect, jest, test } from 'bun:test'
import { footerItemsSchema } from 'kehikot-module-protocol'

import { fromGrid } from '../src/host/canvases.ts'
import { FOLDED_ROWS, FOLDED_TWO_ROWS, foldedHeight, granted, pressed, redrawn, type Wished } from '../src/host/columns.ts'
import { drawsFooter } from '../src/host/footer.ts'
import { foldHint } from '../src/host/folds.ts'
import { REVEAL_ENTER_MS, Reveals, coversFor } from '../src/host/reveal.ts'
import { ROWS_SAID } from '../src/host/appearance.ts'
import {
  clickTo,
  foldDrawn,
  frameFocused,
  pressedAt,
  rowsHide,
  SHOW_ROWS,
  withMode,
} from '../src/host/rows.ts'
import { AT_REST, parseView, serializeView, viewOf } from '../server/view.ts'

/*
 * A container's two rows (`host/rows.ts`): when they show — always, on hover,
 * on click or on a long press, as Settings › Appearance says for every
 * container — and how far a fold goes — the header, or the
 * header and the footer. The state machines are pure and tested here; the DOM
 * is `container-rows-dom.test.tsx`.
 */

describe('when the rows show', () => {
  test('only always keeps them in place', () => {
    expect(rowsHide('always')).toBe(false)
    expect(rowsHide('hover')).toBe(true)
    expect(rowsHide('click')).toBe(true)
  })

})

describe('reveal on long press', () => {
  test('a press into a long-press container reveals nothing, takes the click from the others, and keeps itself when revealed', () => {
    expect(clickTo(null, { kind: 'press', id: 'a', mode: 'longpress' })).toBeNull()
    expect(clickTo('b', { kind: 'press', id: 'a', mode: 'longpress' })).toBeNull()
    expect(clickTo('a', { kind: 'press', id: 'a', mode: 'longpress' })).toBe('a')
    expect(clickTo('b', { kind: 'frame', id: 'a', mode: 'longpress' })).toBeNull()
    expect(clickTo(null, { kind: 'held', id: 'a' })).toBe('a')
    expect(clickTo('a', { kind: 'release', held: 10 })).toBe('a')
  })

  test('withMode fills the mode of the events that name a container, and keeps one already there', () => {
    const modeOf = (id: string): 'longpress' | 'click' => (id === 'a' ? 'longpress' : 'click')
    expect(withMode({ kind: 'press', id: 'a' }, modeOf)).toEqual({ kind: 'press', id: 'a', mode: 'longpress' })
    expect(withMode({ kind: 'chrome', id: 'b' }, modeOf)).toEqual({ kind: 'chrome', id: 'b', mode: 'click' })
    expect(withMode({ kind: 'frame', id: 'a', mode: 'hover' }, modeOf)).toEqual({ kind: 'frame', id: 'a', mode: 'hover' })
    expect(withMode({ kind: 'escape' }, modeOf)).toEqual({ kind: 'escape' })
  })

  test('Reveals times the press: released early reveals nothing, held reveals, a release saying it was held reveals', () => {
    jest.useFakeTimers()
    try {
      const reveals = new Reveals(5, 20, 500)
      reveals.click({ kind: 'press', id: 'a', mode: 'longpress' })
      jest.advanceTimersByTime(200)
      reveals.click({ kind: 'release', held: 200 })
      jest.advanceTimersByTime(1000)
      expect(reveals.showing('a', 'longpress')).toBe(false)
      reveals.click({ kind: 'press', id: 'a', mode: 'longpress' })
      jest.advanceTimersByTime(500)
      expect(reveals.showing('a', 'longpress')).toBe(true)
      reveals.click({ kind: 'outside' })
      expect(reveals.showing('a', 'longpress')).toBe(false)
      reveals.click({ kind: 'press', id: 'a', mode: 'longpress' })
      reveals.click({ kind: 'release', held: 640 })
      expect(reveals.showing('a', 'longpress')).toBe(true)
      /* A press elsewhere ends a hold that has not fired. */
      reveals.click({ kind: 'outside' })
      reveals.click({ kind: 'chrome', id: 'b', mode: 'longpress' })
      reveals.click({ kind: 'press', id: 'c', mode: 'click' })
      jest.advanceTimersByTime(1000)
      expect(reveals.showing('b', 'longpress')).toBe(false)
      expect(reveals.showing('c', 'click')).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  test('its words say a plain click does not, and where to hold in a page too old to say its presses', () => {
    expect(SHOW_ROWS).toContain('longpress')
    expect(ROWS_SAID.longpress.label).toBe('Reveal on long press')
    expect(ROWS_SAID.longpress.line).toContain('a plain click does not')
    expect(ROWS_SAID.longpress.line).toContain('hold on the header')
  })
})

describe('reveal on click: one container at a time', () => {
  test('clicking into a container clicks it; into another moves the click there, which hides the first', () => {
    let clicked = clickTo(null, { kind: 'frame', id: 'a' })
    expect(clicked).toBe('a')
    clicked = clickTo(clicked, { kind: 'frame', id: 'b' })
    expect(clicked).toBe('b')
    clicked = clickTo(clicked, { kind: 'chrome', id: 'a' })
    expect(clicked).toBe('a')
  })

  test('Escape, or a press on nothing, takes it away', () => {
    expect(clickTo('a', { kind: 'escape' })).toBeNull()
    expect(clickTo('a', { kind: 'outside' })).toBeNull()
  })

  test('the clicked container going away takes it away; another going away does not', () => {
    expect(clickTo('a', { kind: 'forget', id: 'a' })).toBeNull()
    expect(clickTo('a', { kind: 'forget', id: 'b' })).toBe('a')
  })

  test('the store tells only on a change, and each mode reads its own state', () => {
    jest.useFakeTimers()
    try {
      const reveals = new Reveals()
      let told = 0
      reveals.subscribe(() => void (told += 1))
      reveals.click({ kind: 'chrome', id: 'a' })
      reveals.click({ kind: 'frame', id: 'a' })
      expect(told).toBe(1)
      expect(reveals.showing('a', 'click')).toBe(true)
      /* Clicked is not hovered, and hovered is not clicked. */
      expect(reveals.showing('a', 'hover')).toBe(false)
      reveals.hold('b', 'frame', true)
      jest.advanceTimersByTime(REVEAL_ENTER_MS)
      expect(reveals.showing('b', 'hover')).toBe(true)
      expect(reveals.showing('b', 'click')).toBe(false)
      /* Always is never "revealed": nothing hides. */
      expect(reveals.showing('a', 'always')).toBe(false)
      reveals.forget('a')
      expect(reveals.clicked('a')).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  test('a press on a container\'s chrome is that container; on a menu it is nothing; anywhere else it is outside', () => {
    const chrome = { closest: (selector: string) => (selector === '[data-module]' ? { getAttribute: () => 'kehikot.paper' } : null) }
    const menu = { closest: (selector: string) => (selector === '[data-module]' ? null : {}) }
    const canvas = { closest: () => null }
    expect(pressedAt(chrome as unknown as EventTarget)).toEqual({ kind: 'chrome', id: 'kehikot.paper' })
    expect(pressedAt(menu as unknown as EventTarget)).toBeNull()
    expect(pressedAt(canvas as unknown as EventTarget)).toEqual({ kind: 'outside' })
    expect(pressedAt(null)).toEqual({ kind: 'outside' })
  })

  test('the page the keyboard is in: the active element is a frame in [data-frame]', () => {
    const frame = { tagName: 'IFRAME', closest: () => ({ getAttribute: () => 'kehikot.notes' }) }
    expect(frameFocused({ activeElement: frame as unknown as Element })).toBe('kehikot.notes')
    expect(frameFocused({ activeElement: { tagName: 'BUTTON', closest: () => null } as unknown as Element })).toBeNull()
    expect(frameFocused({ activeElement: null })).toBeNull()
  })
})

describe('what an over module is told is covered, in every mode', () => {
  const over = { reveal: 'over' }
  const open = { collapsed: false, selected: false }

  test('hidden rows cover, revealed by hover or by click', () => {
    expect(coversFor(over, open, true, 'hover')).toEqual({ header: true, footer: true, by: 'hover' })
    expect(coversFor(over, open, false, 'click')).toEqual({ header: true, footer: false, by: 'click' })
    expect(coversFor(over, open, false, 'longpress')).toEqual({ header: true, footer: false, by: 'click' })
  })

  test('rows that never hide cover nothing; a pushed module is never covered; a folded page is not drawn, so nothing of it is covered', () => {
    expect(coversFor(over, open, true, 'always')).toBeNull()
    expect(coversFor({}, open, true, 'hover')).toBeNull()
    expect(coversFor(over, { ...open, collapsed: true }, true, 'click')).toBeNull()
  })
})

describe('how far a fold goes', () => {
  const footer = footerItemsSchema.parse([{ kind: 'text', id: 'status', text: 'Synced' }])

  test('drawn at two rows only when chosen and there is a footer; open is open', () => {
    expect(foldDrawn(false, 2, true)).toBe(0)
    expect(foldDrawn(true, 1, true)).toBe(1)
    expect(foldDrawn(true, 2, true)).toBe(2)
    expect(foldDrawn(true, 2, false)).toBe(1)
    expect(foldDrawn(true, undefined, true)).toBe(1)
  })

  test('a container folded to two rows draws its footer; folded to one it does not', () => {
    expect(drawsFooter(footer, true, 2)).toBe(true)
    expect(drawsFooter(footer, true, 1)).toBe(false)
    expect(drawsFooter(footer, true, true)).toBe(false)
    expect(drawsFooter(footer, true, false)).toBe(true)
    expect(drawsFooter(footer, false, 2)).toBe(false)
  })

  test('two rows is twice a fold\'s height, granted as one', () => {
    expect(FOLDED_TWO_ROWS).toBe(FOLDED_ROWS * 2)
    expect(foldedHeight({})).toBe(FOLDED_ROWS)
    expect(foldedHeight({ foldRows: 2 })).toBe(FOLDED_TWO_ROWS)
    const boxes: Wished[] = [
      { i: 'a', x: 0, y: 0, w: 6, h: 20, wish: 20, collapsed: true, foldRows: 2 },
      { i: 'b', x: 0, y: 20, w: 6, h: 20, wish: 20, collapsed: true },
      { i: 'c', x: 6, y: 0, w: 6, h: 20, wish: 20, collapsed: false, foldRows: 2 },
    ]
    const heights = granted(boxes)
    expect(heights.get('a')).toBe(FOLDED_TWO_ROWS)
    expect(heights.get('b')).toBe(FOLDED_ROWS)
    /* Open, the fold choice is only remembered. */
    expect(heights.get('c')).toBe(20)
  })

  test('the wish survives a two-row fold and comes back on unfold', () => {
    const one: Wished[] = [{ i: 'a', x: 0, y: 0, w: 6, h: 20, wish: 20, collapsed: false, foldRows: 2 }]
    const folded = pressed(one, 'a', true)
    expect(folded[0]).toMatchObject({ h: FOLDED_TWO_ROWS, wish: 20, collapsed: true, foldRows: 2 })
    expect(pressed(folded, 'a', false)[0]).toMatchObject({ h: 20, wish: 20, collapsed: false, foldRows: 2 })
  })

  test('the hint says how far a press folds, and offers no held choice any more', () => {
    expect(foldHint(false, null)).toBe('fold it down to this header. The module keeps running and keeps what is in it')
    expect(foldHint(false, null, 2)).toBe('fold it down to this header and its footer. The module keeps running and keeps what is in it')
    expect(foldHint(false, 'an agent', 2)).toBe('unfolded by an agent. Press to fold it down to its header and footer again')
    expect(foldHint(true, null, 1)).toBe('folded — the module is still running. Press to put it back at the height it had')
  })
})

describe('no longer kept per container', () => {
  test('a view never writes how far a fold goes or when the rows show', () => {
    const canvas = (placements: object[]) =>
      ({ key: 'k1', placements: placements.map((p) => ({ i: 'kehikot.paper', collapsed: false, selected: false, filters: {}, ...p })) }) as never
    const subject = { epic: null, parts: [], selection: [] }
    expect(serializeView(viewOf([canvas([{}])], subject))).toContain('"kehikot": {}')
    const text = serializeView(viewOf([canvas([{ collapsed: true, foldRows: 2, showRows: 'click' }])], subject))
    expect(text).not.toContain('foldRows')
    expect(text).not.toContain('showRows')
    expect(parseView(text)!.kehikot.get('k1')!.get('kehikot.paper')).toEqual({ ...AT_REST, collapsed: true })
  })

  test('a choice an older host stored is ignored, not refused', () => {
    const read = parseView(JSON.stringify({ version: 1, epic: null, selection: [], kehikot: { k1: { 'kehikot.paper': { foldRows: 2, showRows: 'click', collapsed: true } } } }))!
    expect(read.kehikot.get('k1')!.get('kehikot.paper')).toEqual({ ...AT_REST, collapsed: true })
  })
})

describe('what the grid reports carries the fold the page stamped, and decides none', () => {
  test('fromGrid carries foldRows across, and a drag never sets it', () => {
    const base = { x: 0, y: 0, w: 12, h: FOLDED_TWO_ROWS, wish: 20, grow: false, pinned: false, prompt: '', promptFor: null, selected: false, filters: {}, refreshEvery: null, version: null, scope: null }
    const was = [
      { ...base, i: 'kehikot.a', collapsed: true, foldRows: 2 as const },
      { ...base, i: 'kehikot.b', x: 12, collapsed: false, h: 20 },
    ]
    const got = fromGrid(was, [{ i: 'kehikot.a', x: 0, y: 0, w: 12, h: FOLDED_TWO_ROWS }, { i: 'kehikot.b', x: 12, y: 0, w: 12, h: 20 }], null, new Map())
    expect(got[0]).toMatchObject({ collapsed: true, foldRows: 2 })
    expect('foldRows' in got[1]!).toBe(false)
    expect(redrawn(got)[0]!.h).toBe(FOLDED_TWO_ROWS)
    const pulled = fromGrid(was, [{ i: 'kehikot.a', x: 0, y: 0, w: 12, h: FOLDED_TWO_ROWS }, { i: 'kehikot.b', x: 12, y: 0, w: 12, h: FOLDED_ROWS }], 'kehikot.b', new Map(), () => true)
    expect(pulled[1]).toMatchObject({ collapsed: true })
    expect('foldRows' in pulled[1]!).toBe(false)
  })
})
