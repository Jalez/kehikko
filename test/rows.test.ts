import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { footerItemsSchema } from 'kehikot-module-protocol'

import { fromGrid } from '../src/host/canvases.ts'
import { FOLDED_ROWS, FOLDED_TWO_ROWS, foldedHeight, granted, pressed, redrawn, type Wished } from '../src/host/columns.ts'
import { drawsFooter } from '../src/host/footer.ts'
import { foldHint } from '../src/host/folds.ts'
import { REVEAL_ENTER_MS, Reveals, coversFor } from '../src/host/reveal.ts'
import {
  FOLD_ROWS_SAID,
  LONG_PRESS_MS,
  LongPress,
  barRows,
  clickTo,
  foldChoices,
  foldDrawn,
  foldRowsIn,
  frameFocused,
  opensFoldChoice,
  pressedAt,
  rowsHide,
  rowsShown,
  showRowsIn,
} from '../src/host/rows.ts'
import { AT_REST, parseView, serializeView, viewOf } from '../server/view.ts'

/*
 * A container's two rows (`host/rows.ts`): when they show — always, on hover,
 * on click, or as the bar says — and how far a fold goes — the header, or the
 * header and the footer. The state machines are pure and tested here; the DOM
 * is `container-rows-dom.test.tsx`.
 */

describe('when the rows show', () => {
  test('a container that has not said follows the bar: on hover with focus mode on, always with it off', () => {
    expect(barRows('on')).toBe('hover')
    expect(barRows('off')).toBe('always')
    expect(rowsShown({}, 'on')).toBe('hover')
    expect(rowsShown({ showRows: null }, 'off')).toBe('always')
  })

  test('its own choice wins over the bar either way', () => {
    expect(rowsShown({ showRows: 'always' }, 'on')).toBe('always')
    expect(rowsShown({ showRows: 'click' }, 'off')).toBe('click')
    expect(rowsShown({ showRows: 'hover' }, 'off')).toBe('hover')
  })

  test('only always keeps them in place', () => {
    expect(rowsHide('always')).toBe(false)
    expect(rowsHide('hover')).toBe(true)
    expect(rowsHide('click')).toBe(true)
  })

  test('anything that is not one of the words follows the bar; anything that is not a literal 2 is one row', () => {
    expect(showRowsIn('click')).toBe('click')
    expect(showRowsIn('CLICK')).toBeNull()
    expect(showRowsIn(3)).toBeNull()
    expect(foldRowsIn(2)).toBe(2)
    expect(foldRowsIn('2')).toBe(1)
    expect(foldRowsIn(null)).toBe(1)
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
    expect(coversFor(over, open, true, 'on')).toEqual({ header: true, footer: true, by: 'hover' })
    expect(coversFor(over, { ...open, showRows: 'click' }, false, 'off')).toEqual({ header: true, footer: false, by: 'click' })
  })

  test('rows that never hide cover nothing; a pushed module is never covered; a folded page is not drawn, so nothing of it is covered', () => {
    expect(coversFor(over, open, true, 'off')).toBeNull()
    expect(coversFor(over, { ...open, showRows: 'always' }, true, 'on')).toBeNull()
    expect(coversFor({}, open, true, 'on')).toBeNull()
    expect(coversFor(over, { ...open, collapsed: true, showRows: 'click' }, true, 'on')).toBeNull()
  })
})

describe('how far a fold goes', () => {
  const footer = footerItemsSchema.parse([{ kind: 'text', id: 'status', text: 'Synced' }])

  test('two rows is offered only while the footer is drawn', () => {
    expect(foldChoices(true)).toEqual([1, 2])
    expect(foldChoices(false)).toEqual([1])
  })

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

  test('the choice is said with the rule, one line each', () => {
    expect(`${FOLD_ROWS_SAID[1].label} — ${FOLD_ROWS_SAID[1].line}`).toBe('One row — only the header: how this module is set up.')
    expect(`${FOLD_ROWS_SAID[2].label} — ${FOLD_ROWS_SAID[2].line}`).toBe('Two rows — header and footer: also what’s going on now (status, location, usage).')
  })

  test('the hint says how far a press folds, and that holding chooses', () => {
    expect(foldHint(false, null)).toBe('fold it down to this header. The module keeps running and keeps what is in it')
    expect(foldHint(false, null, 2, true)).toBe('fold it down to this header and its footer. The module keeps running and keeps what is in it. Hold for one row or two')
    expect(foldHint(false, 'an agent', 2)).toBe('unfolded by an agent. Press to fold it down to its header and footer again')
    expect(foldHint(false, null, 2, true, true)).toBe('fold it down to this header and its footer. The module keeps running and keeps what is in it. Hold for one row or two, and for when the header and footer show')
    expect(foldHint(true, null, 1, false, true)).toBe('folded — the module is still running. Press to put it back at the height it had. Hold to choose when the header and footer show')
  })
})

describe('the long press', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test('a press let go before the wait is a click, and opens nothing', () => {
    let opened = 0
    const long = new LongPress(() => void (opened += 1))
    long.down()
    jest.advanceTimersByTime(LONG_PRESS_MS - 1)
    long.cancel()
    expect(long.click()).toBe(true)
    jest.advanceTimersByTime(LONG_PRESS_MS)
    expect(opened).toBe(0)
  })

  test('held for the wait, it opens the choice and the click after the release is swallowed — once', () => {
    let opened = 0
    const long = new LongPress(() => void (opened += 1))
    long.down()
    jest.advanceTimersByTime(LONG_PRESS_MS)
    expect(opened).toBe(1)
    long.cancel()
    expect(long.click()).toBe(false)
    expect(long.click()).toBe(true)
  })

  test('a pointer that leaves before the wait opens nothing', () => {
    let opened = 0
    const long = new LongPress(() => void (opened += 1))
    long.down()
    long.cancel()
    jest.advanceTimersByTime(LONG_PRESS_MS * 2)
    expect(opened).toBe(0)
  })

  test('the keys that open it: Shift+Enter, Shift+F10, the context-menu key; Enter alone is a press', () => {
    expect(opensFoldChoice({ key: 'Enter', shiftKey: true })).toBe(true)
    expect(opensFoldChoice({ key: 'F10', shiftKey: true })).toBe(true)
    expect(opensFoldChoice({ key: 'ContextMenu', shiftKey: false })).toBe(true)
    expect(opensFoldChoice({ key: 'Enter', shiftKey: false })).toBe(false)
    expect(opensFoldChoice({ key: ' ', shiftKey: true })).toBe(false)
  })
})

describe('kept per container, in this person\'s view', () => {
  test('at rest they are not written; set, they are, and they read back', () => {
    const canvas = (placements: object[]) =>
      ({ key: 'k1', placements: placements.map((p) => ({ i: 'kehikot.paper', collapsed: false, selected: false, filters: {}, ...p })) }) as never
    const subject = { epic: null, parts: [], selection: [] }
    expect(serializeView(viewOf([canvas([{}])], subject))).toContain('"kehikot": {}')
    const text = serializeView(viewOf([canvas([{ collapsed: true, foldRows: 2, showRows: 'click' }])], subject))
    expect(text).toContain('"foldRows":2')
    expect(text).toContain('"showRows":"click"')
    const read = parseView(text)!
    expect(read.kehikot.get('k1')!.get('kehikot.paper')).toEqual({ ...AT_REST, collapsed: true, foldRows: 2, showRows: 'click' })
  })

  test('a value it does not know is dropped, not refused', () => {
    const read = parseView(JSON.stringify({ version: 1, epic: null, selection: [], kehikot: { k1: { 'kehikot.paper': { foldRows: 3, showRows: 'sometimes', collapsed: true } } } }))!
    expect(read.kehikot.get('k1')!.get('kehikot.paper')).toEqual({ ...AT_REST, collapsed: true })
  })
})

describe('what the grid reports keeps how a container folds and when its rows show', () => {
  test('fromGrid carries foldRows and showRows across, and leaves them out where they were at rest', () => {
    const base = { x: 0, y: 0, w: 12, h: FOLDED_TWO_ROWS, wish: 20, grow: false, pinned: false, prompt: '', promptFor: null, selected: false, filters: {}, refreshEvery: null, version: null, scope: null }
    const was = [
      { ...base, i: 'kehikot.a', collapsed: true, foldRows: 2 as const, showRows: 'click' as const },
      { ...base, i: 'kehikot.b', x: 12, collapsed: false, h: 20 },
    ]
    const got = fromGrid(was, [{ i: 'kehikot.a', x: 0, y: 0, w: 12, h: FOLDED_TWO_ROWS }, { i: 'kehikot.b', x: 12, y: 0, w: 12, h: 20 }], null, new Map())
    expect(got[0]).toMatchObject({ collapsed: true, foldRows: 2, showRows: 'click' })
    expect('foldRows' in got[1]!).toBe(false)
    expect('showRows' in got[1]!).toBe(false)
    expect(redrawn(got)[0]!.h).toBe(FOLDED_TWO_ROWS)
  })
})
