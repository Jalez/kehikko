import { describe, expect, test } from 'bun:test'

import {
  FOLDED_ROWS,
  SQUEEZED_ROWS,
  below,
  dragged,
  granted,
  mostFor,
  shares,
  tops,
  wishing,
  type Wished,
} from '../src/host/columns.ts'
import { CANVAS_ROWS } from '../src/host/fit.ts'

/**
 * A column is a fixed height budget, and growing a container spends it.
 *
 * The owner: "if a user expands another module's container height wise, it
 * should take that height from other elements sharing that column." The two
 * earlier answers to the same complaint are recorded in `fit.ts` and were both
 * about the SCALE — shrink every row, or hold every row and scroll. This is
 * about the arrangement, and these are the tests for the arithmetic.
 *
 * And then the second complaint, which is the one that turned a growth rule
 * into a rule about WISHES: "when we fold the other module the affected module
 * doesn't get back its height". The tests under "the height a fold gave away"
 * are that report, as scenarios.
 */

/** A container at rest: drawn at the height it asked for, and open. */
const box = (i: string, x: number, y: number, w: number, h: number): Wished => ({
  i,
  x,
  y,
  w,
  h,
  wish: h,
  collapsed: false,
})

/** A folded container: one row on the canvas, and a height to come back to. */
const folded = (i: string, x: number, y: number, w: number, wish: number): Wished => ({
  i,
  x,
  y,
  w,
  h: FOLDED_ROWS,
  wish,
  collapsed: true,
})

/* The real kehikko this was built against, so the cases below are an
   arrangement somebody actually has rather than one invented to pass. Three
   visual columns: 0-3, 3-8, 8-12. The two one-row containers at the bottom of
   the left column are folded ones. */
const canvas10: Wished[] = [
  box('checklist', 0, 0, 3, 18),
  box('paper', 3, 0, 5, 28),
  box('notes', 8, 0, 4, 8),
  box('learning', 8, 8, 4, 10),
  folded('notifications', 0, 18, 3, 6),
  box('terminal', 8, 18, 4, 10),
  folded('explorer', 0, 19, 3, 6),
]

/* And the one with a full-width container under two narrower ones, which is
   what proves that "column" cannot mean "lane". */
const canvas1: Wished[] = [
  box('references', 0, 0, 6, 10),
  box('orchestrator', 6, 0, 6, 16),
  box('journeys', 0, 10, 6, 16),
  box('tests', 6, 16, 6, 10),
  folded('diff', 0, 26, 5, 8),
  folded('checklist', 5, 26, 7, 8),
  folded('paper', 0, 27, 12, 20),
]

const find = (boxes: readonly Wished[], i: string) => boxes.find((one) => one.i === i)!

/** The arrangement redrawn at what `granted` gives it, for asking again. */
const drawn = (boxes: readonly Wished[], heights: Map<string, number>): Wished[] =>
  boxes.map((one) => ({ ...one, h: heights.get(one.i) ?? one.h }))

describe('what it means to share a column', () => {
  test('two containers in the same x-range share one', () => {
    expect(shares(find(canvas10, 'notes'), find(canvas10, 'learning'))).toBe(true)
  })

  test('two in different x-ranges do not', () => {
    expect(shares(find(canvas10, 'checklist'), find(canvas10, 'notes'))).toBe(false)
  })

  /* The case that rules out lanes. `paper` is twelve wide and sits under a
     five and a seven; any rule that partitioned the twelve columns into fixed
     lanes would have called those three unrelated, and growing one of them
     would have pushed `paper` off the bottom. */
  test('a wide container shares a column with every narrow one over it', () => {
    const wide = find(canvas1, 'paper')
    expect(shares(wide, find(canvas1, 'diff'))).toBe(true)
    expect(shares(wide, find(canvas1, 'checklist'))).toBe(true)
    expect(shares(wide, find(canvas1, 'references'))).toBe(true)
  })

  /* And the consequence, written down because it is the thing that makes this
     a relation rather than a partition: sharing is not transitive. */
  test('sharing is not transitive, and nothing here assumes it is', () => {
    const left = find(canvas1, 'diff')
    const right = find(canvas1, 'checklist')
    const wide = find(canvas1, 'paper')
    expect(shares(left, wide)).toBe(true)
    expect(shares(wide, right)).toBe(true)
    expect(shares(left, right)).toBe(false)
  })

  test('and nothing shares a column with itself', () => {
    const one = find(canvas10, 'paper')
    expect(shares(one, one)).toBe(false)
  })
})

describe('who is under whom', () => {
  test('the ones below, nearest first', () => {
    const mates = below(canvas10, find(canvas10, 'notes'))
    expect(mates.map((one) => one.i)).toEqual(['learning', 'terminal'])
  })

  /* Growth goes downward — the resize handle is the south-east corner — so a
     container above is not moved by the one under it getting taller. */
  test('and never the ones above', () => {
    expect(below(canvas10, find(canvas10, 'terminal')).map((one) => one.i)).toEqual([])
  })

  test('nor anything in another column', () => {
    const mates = below(canvas10, find(canvas10, 'checklist'))
    expect(mates.map((one) => one.i)).toEqual(['notifications', 'explorer'])
  })

  /* Decided by top edges, so that a neighbour is still "below" in the render
     between a height being written and the grid moving the neighbour down to
     make room for it. Here `a` has just been given twelve rows and `b` is
     still where it was, at row one. */
  test('a neighbour that the grid has not moved yet is still below', () => {
    const boxes = [box('a', 0, 0, 6, 12), box('b', 0, 1, 6, 10)]
    expect(below(boxes, find(boxes, 'a')).map((one) => one.i)).toEqual(['b'])
  })
})

describe('what a wish is granted', () => {
  /*
   * The whole complaint, as a test. `notes` is in the right-hand column;
   * `checklist` and `paper` are not, and must not move or change size however
   * much `notes` wishes.
   */
  test('takes nothing from another column', () => {
    const heights = wishing(canvas10, 'notes', { wish: 14 })
    expect(heights.get('checklist')).toBe(18)
    expect(heights.get('paper')).toBe(28)
    expect(heights.get('explorer')).toBe(FOLDED_ROWS)
    expect(heights.get('notifications')).toBe(FOLDED_ROWS)
  })

  /* Every container asked for what it has, and every column fits. Nothing
     moves. This is also what a canvas saved before wishes existed looks like
     — each wish defaulted to the height that was stored — so it is the test
     that such a canvas opens and draws the same arrangement. */
  test('an arrangement that fits is drawn exactly as it asked', () => {
    for (const boxes of [canvas10, canvas1]) {
      const heights = granted(boxes)
      for (const one of boxes) expect(heights.get(one.i)).toBe(one.h)
    }
  })

  /* The right column is full — 8 + 10 + 10 is 28 — so there is no free space
     and somebody has to make room. Rows are handed out from the top of the
     column down: `notes` takes its twelve, `learning` is offered what leaves
     `terminal` its floor and keeps its ten, and `terminal` gets the six that
     are left. */
  test('takes it from the column below, the bottom making room first', () => {
    const heights = wishing(canvas10, 'notes', { wish: 12 })
    expect(heights.get('notes')).toBe(12)
    expect(heights.get('learning')).toBe(10)
    expect(heights.get('terminal')).toBe(6)
  })

  /* Free space belongs to nobody, so it is spent before anybody is asked. The
     left column of this canvas uses twenty of twenty-eight rows. */
  test('spends the free rows under the column before anybody makes room', () => {
    const heights = wishing(canvas10, 'checklist', { wish: 24 })
    expect(heights.get('checklist')).toBe(24)
    for (const one of canvas10) {
      if (one.i !== 'checklist') expect(heights.get(one.i)).toBe(one.h)
    }
  })

  /*
   * The floor. A container squeezed to one row is a container drawn as a bare
   * header, which is the FOLDED state — something a person chooses for a
   * container they want out of the way, and not something to inflict on a
   * neighbour because somebody dragged something else.
   */
  test('nobody is squeezed past the floor', () => {
    const heights = wishing(canvas10, 'notes', { wish: CANVAS_ROWS })
    expect(heights.get('learning')).toBe(SQUEEZED_ROWS)
    expect(heights.get('terminal')).toBe(SQUEEZED_ROWS)
    /* And the wish is cut to what leaves them there: 28 - 3 - 3. */
    expect(heights.get('notes')).toBe(22)
  })

  /* A folded container has nothing to give and is not pushed further down.
     `notifications` and `explorer` are one row each and stay so. */
  test('a folded container makes no room and is not folded further', () => {
    const heights = wishing(canvas10, 'checklist', { wish: CANVAS_ROWS })
    expect(heights.get('notifications')).toBe(FOLDED_ROWS)
    expect(heights.get('explorer')).toBe(FOLDED_ROWS)
    expect(heights.get('checklist')).toBe(CANVAS_ROWS - 2 * FOLDED_ROWS)
  })

  /* A container that asked for less than the floor is drawn at what it asked.
     The floor is what somebody ELSE may push you to, not a height you are owed. */
  test('a wish under the floor is drawn at the wish', () => {
    const boxes = [box('a', 0, 0, 6, 10), box('b', 0, 10, 6, 2)]
    expect(granted(boxes).get('b')).toBe(2)
    /* And it is not squeezed below it either when the column fills. */
    expect(wishing(boxes, 'a', { wish: CANVAS_ROWS }).get('b')).toBe(2)
  })

  /*
   * When nobody can make room, the growth does not happen — the same answer as
   * dragging a container past column twelve, and it should feel the same.
   * `paper` is already the full twenty-eight rows of its column.
   */
  test('a wish past what the column has is cut to what it has', () => {
    expect(wishing(canvas10, 'paper', { wish: 40 }).get('paper')).toBe(CANVAS_ROWS)
    expect(wishing(canvas10, 'terminal', { wish: 20 }).get('terminal')).toBe(10)
  })

  /* And the sum is exactly conserved wherever the column was already full,
     which is the arithmetic version of "it takes that height from other
     elements sharing that column". */
  test('a full column makes room for every row it grants', () => {
    const column = ['notes', 'learning', 'terminal']
    const was = column.reduce((total, i) => total + find(canvas10, i).h, 0)
    const heights = wishing(canvas10, 'notes', { wish: 16 })
    const now = column.reduce((total, i) => total + heights.get(i)!, 0)
    expect(was).toBe(CANVAS_ROWS)
    expect(now).toBe(CANVAS_ROWS)
  })

  /* A container wishing for less hands its rows to the column, and the others
     — already at their wishes — are not inflated to fill them. A wish is the
     most a container is ever drawn at. */
  test('shrinking inflates nobody past their wish', () => {
    const heights = wishing(canvas10, 'notes', { wish: 4 })
    expect(heights.get('notes')).toBe(4)
    expect(heights.get('learning')).toBe(10)
    expect(heights.get('terminal')).toBe(10)
  })

  /*
   * The answer is a function of the wishes and nothing else — in particular
   * not of the heights currently drawn. Ask, draw the answer, ask again: the
   * same heights come back. Without this, every render would be a gesture.
   */
  test('is the same answer whatever was drawn before', () => {
    const squeezed = drawn(canvas10, wishing(canvas10, 'notes', { wish: 20 }))
    const again = granted(squeezed.map((one) => ({ ...one, wish: find(canvas10, one.i).wish })))
    for (const one of canvas10) expect(again.get(one.i)).toBe(one.h)
  })

  test('and a container that is not there is not an error', () => {
    expect(wishing(canvas10, 'nothing.at.all', { wish: 20 })).toEqual(granted(canvas10))
  })
})

/**
 * The second complaint, and the reason heights became wishes.
 *
 * "when unfolding another module affects the height of another module, the
 * other module gets correctly smaller — however when we fold the other module
 * the affected module doesn't 'get back its height' so to speak."
 */
describe('the height a fold gave away', () => {
  /* A over B, sharing a column, full: A asked for ten and B for eighteen. */
  const rest = [box('a', 0, 0, 6, 10), box('b', 0, 10, 6, 18)]

  test('B is squeezed to make room for A, and A folding gives it back', () => {
    /* A grows to twenty. B has to make room: eighteen becomes eight. */
    const grown = drawn(rest, wishing(rest, 'a', { wish: 20 })).map((one) =>
      one.i === 'a' ? { ...one, wish: 20 } : one,
    )
    expect(find(grown, 'a')).toMatchObject({ h: 20, wish: 20 })
    expect(find(grown, 'b')).toMatchObject({ h: 8, wish: 18 })

    /* A folds. Its wish is untouched — folding is a state — and B, whose wish
       never changed, is back at eighteen because the column has room. */
    const heights = wishing(grown, 'a', { collapsed: true })
    expect(heights.get('a')).toBe(FOLDED_ROWS)
    expect(heights.get('b')).toBe(18)
  })

  test('and A unfolding takes it again, exactly as before', () => {
    const grown = drawn(rest, wishing(rest, 'a', { wish: 20 })).map((one) =>
      one.i === 'a' ? { ...one, wish: 20 } : one,
    )
    const shut = drawn(
      grown.map((one) => (one.i === 'a' ? { ...one, collapsed: true } : one)),
      wishing(grown, 'a', { collapsed: true }),
    )
    const heights = wishing(shut, 'a', { collapsed: false })
    expect(heights.get('a')).toBe(20)
    expect(heights.get('b')).toBe(8)
  })

  /* Unfolding is growth, and growth is bought from the column. A column that
     filled up while the container was folded gives back less than was asked,
     and the canvas still fits. Explicit rows and floor, so the arithmetic is
     readable: a canvas of twelve with a floor of three, `b` at eleven can only
     make room down to three, so `a` asking for twelve gets nine. */
  test('a column that filled up in the meantime gives back less than was asked', () => {
    const boxes = [folded('a', 0, 0, 6, 12), box('b', 0, 1, 6, 11)]
    const heights = wishing(boxes, 'a', { collapsed: false }, 12, 3)
    expect(heights.get('a')).toBe(9)
    expect(heights.get('b')).toBe(3)
  })

  /* And a column with nothing left to give hands back nothing, rather than
     taking rows that do not exist. The floor is a limit on what others may
     take from a container, not a claim on rows the column does not have: `a`
     comes back one row tall and open, and the canvas does not overflow. */
  test('a column at its floor gives back nothing', () => {
    const boxes = [
      folded('a', 0, 0, 6, 9),
      box('b', 0, 1, 6, 3),
      box('c', 0, 4, 6, 3),
      box('d', 0, 7, 6, 3),
      box('e', 0, 10, 6, 2),
    ]
    expect(wishing(boxes, 'a', { collapsed: false }, 12, 3).get('a')).toBe(FOLDED_ROWS)
  })

  /* Unfolding and dragging to the same height must end in the same
     arrangement, or the two controls disagree about what a column can hold. */
  test('unfolding agrees with dragging to the same height', () => {
    const shut = [folded('a', 0, 0, 6, 11), box('b', 0, 1, 6, 18)]
    const open = [box('a', 0, 0, 6, 1), box('b', 0, 1, 6, 18)]
    expect([...wishing(shut, 'a', { collapsed: false })]).toEqual([...wishing(open, 'a', { wish: 11 })])
  })

  /* Both folded, both unfolded: the arrangement they built comes back. */
  test('fold both, unfold both, and it is the arrangement they built', () => {
    const grown = drawn(rest, wishing(rest, 'a', { wish: 20 })).map((one) =>
      one.i === 'a' ? { ...one, wish: 20 } : one,
    )
    const shut = grown.map((one) => ({ ...one, collapsed: true, h: FOLDED_ROWS }))
    expect([...granted(shut).values()]).toEqual([FOLDED_ROWS, FOLDED_ROWS])
    const open = shut.map((one) => ({ ...one, collapsed: false }))
    expect(granted(open).get('a')).toBe(20)
    expect(granted(open).get('b')).toBe(8)
  })
})

/**
 * The properties, over arrangements nobody chose: every wish somebody could
 * make against the two real canvases, and a column that cannot grant them all.
 */
describe('whatever is wished, the canvas holds', () => {
  const wishes = [1, 2, 3, 5, 9, 14, 20, 27, CANVAS_ROWS, CANVAS_ROWS + 10]

  /* The property that was actually broken, twice: unfolding could push the
     arrangement past its rows, and the fix for that lost track of what a
     neighbour had asked for. Whatever is granted, nothing reaches past the
     bottom, nobody is below the floor unless they asked to be, and nobody is
     above their wish. */
  test('no container reaches past the bottom, sinks below the floor, or exceeds its wish', () => {
    for (const boxes of [canvas10, canvas1]) {
      for (const target of boxes) {
        for (const wish of wishes) {
          const wished = boxes.map((one) => (one.i === target.i ? { ...one, wish } : one))
          const heights = granted(wished)
          const placed = tops(wished)
          for (const one of wished) {
            const h = heights.get(one.i)!
            expect(placed.get(one.i)! + h).toBeLessThanOrEqual(CANVAS_ROWS)
            if (one.collapsed) {
              expect(h).toBe(FOLDED_ROWS)
            } else {
              expect(h).toBeGreaterThanOrEqual(Math.min(one.wish, SQUEEZED_ROWS))
              expect(h).toBeLessThanOrEqual(one.wish)
            }
          }
        }
      }
    }
  })

  /* Deterministic, and independent of what was drawn: the same wishes give
     the same heights whether they are asked from the arrangement at rest or
     from one somebody has been dragging about. */
  test('the same wishes give the same heights from any starting heights', () => {
    for (const boxes of [canvas10, canvas1]) {
      const heights = granted(boxes)
      for (const h of [1, 3, 7, 40]) {
        const scrambled = boxes.map((one) => ({ ...one, h }))
        expect(granted(scrambled)).toEqual(heights)
      }
    }
  })

  /* And a column nobody can fit. Nothing can make ten floors of three fit in
     twelve rows; what is decided is that the CANVAS holds — the rows run out
     from the top down, a row each, until the rest fit — rather than the
     bottom of the column being pushed off it. */
  test('a column whose floors alone do not fit still stays on the canvas', () => {
    const boxes = Array.from({ length: 10 }, (_, n) => box(`c${n}`, 0, n * 3, 6, 3))
    const heights = granted(boxes, 12, 3)
    const placed = tops(boxes, 12, 3)
    for (const one of boxes) expect(placed.get(one.i)! + heights.get(one.i)!).toBeLessThanOrEqual(12)
    expect(heights.get('c9')).toBe(3)
    expect(heights.get('c0')).toBe(1)
  })
})

describe('how tall a container is allowed to become', () => {
  /*
   * `mostFor` is `granted` asked for the whole canvas, deliberately, so that
   * the `maxH` the resize handle stops at and the height a resize actually
   * draws can never disagree. A handle that stops where nothing happens, or
   * travels where nothing is granted, is the edge discovered rather than felt.
   */
  test('it agrees with what a wish for everything would be granted', () => {
    for (const one of canvas10) {
      const most = mostFor(canvas10, one.i)
      const heights = wishing(canvas10, one.i, { wish: CANVAS_ROWS, collapsed: false })
      expect(most).toBe(heights.get(one.i)!)
    }
  })

  test('a container whose column has nothing spare may not grow at all', () => {
    expect(mostFor(canvas10, 'paper')).toBe(28)
    expect(mostFor(canvas10, 'terminal')).toBe(10)
  })

  test('and one with free space below it may grow into it', () => {
    expect(mostFor(canvas10, 'checklist')).toBe(26)
  })

  /* Never smaller than what is drawn. A `maxH` below an item's own `h` is a
     value react-grid-layout complains about and would mean a container that
     cannot be left alone at the size it is. */
  test('it is never less than the height the container is drawn at', () => {
    for (const boxes of [canvas10, canvas1]) {
      const heights = granted(boxes)
      for (const one of boxes) expect(mostFor(boxes, one.i)).toBeGreaterThanOrEqual(heights.get(one.i)!)
    }
  })

  test('and never past the bottom of the canvas', () => {
    for (const one of [...canvas10, ...canvas1]) {
      expect(mostFor(canvas10, one.i)).toBeLessThanOrEqual(CANVAS_ROWS)
    }
  })

  /* A folded container's handle may travel: it is asked as if it were open,
     because pulling it is how it is opened. */
  test('a folded container may be pulled open', () => {
    expect(mostFor(canvas10, 'explorer')).toBeGreaterThan(FOLDED_ROWS)
  })
})

/**
 * The first complaint. "When you minimize a module to a single row from the
 * corner drag instead of the fold button it doesn't minimize it to the folded
 * view (like it obviously should)."
 */
describe('a hand on the corner', () => {
  const open = { h: 14, wish: 14, collapsed: false }
  const shut = { h: FOLDED_ROWS, wish: 14, collapsed: true }

  test('dragged to one row is a fold, and remembers what to come back to', () => {
    expect(dragged(open, 1)).toEqual({ wish: 14, collapsed: true })
  })

  /* The grid does not go below one row, but a rounded measurement can, and a
     zero is a fold rather than a request for nothing. */
  test('dragged to less than one row is a fold too', () => {
    expect(dragged(open, 0)).toEqual({ wish: 14, collapsed: true })
  })

  test('and dragged back out of the fold opens it, at the height it was dragged to', () => {
    expect(dragged(shut, 6)).toEqual({ wish: 6, collapsed: false })
  })

  /* Nobody drags precisely; the smallest movement that changes the height is
     as much a "let me see this" as a big one. */
  test('one row taller than folded is an unfold', () => {
    expect(dragged(shut, FOLDED_ROWS + 1)).toEqual({ wish: FOLDED_ROWS + 1, collapsed: false })
  })

  test('dragged taller while open is simply a new wish', () => {
    expect(dragged(open, 20)).toEqual({ wish: 20, collapsed: false })
  })

  /* This is the common case, not an edge: react-grid-layout reports the whole
     layout on every gesture, and a corner pressed and let go without moving is
     not a choice. Neither writes the wish. */
  test('a drag that ends where it started says nothing', () => {
    expect(dragged(open, 14)).toEqual({ wish: 14, collapsed: false })
    expect(dragged(shut, FOLDED_ROWS)).toEqual({ wish: 14, collapsed: true })
  })

  /* The invariant. A container drawn at eight because a neighbour took its
     rows still wishes for eighteen, and releasing its corner at eight must not
     turn the squeeze into a choice. */
  test('a squeezed container released at its drawn height keeps its wish', () => {
    expect(dragged({ h: 8, wish: 18, collapsed: false }, 8)).toEqual({ wish: 18, collapsed: false })
  })

  /* The whole first report, as arithmetic: drag A to one row, and B — which
     was making room for it — gets its height back; drag A back out, and B
     makes room again, subject to the budget. */
  test('dragging A to one row folds it and gives B its height back, and dragging out takes it again', () => {
    const at = [box('a', 0, 0, 6, 10), box('b', 0, 10, 6, 18)]
    const rest = drawn(at, wishing(at, 'a', { wish: 20 })).map((one) =>
      one.i === 'a' ? { ...one, wish: 20 } : one,
    )
    const toOne = dragged(find(rest, 'a'), 1)
    expect(toOne).toEqual({ wish: 20, collapsed: true })
    const shutHeights = wishing(rest, 'a', toOne)
    expect(shutHeights.get('a')).toBe(FOLDED_ROWS)
    expect(shutHeights.get('b')).toBe(18)

    const shut = drawn(rest, shutHeights).map((one) => (one.i === 'a' ? { ...one, ...toOne } : one))
    const back = dragged(find(shut, 'a'), 20)
    expect(back).toEqual({ wish: 20, collapsed: false })
    const openHeights = wishing(shut, 'a', back)
    expect(openHeights.get('a')).toBe(20)
    expect(openHeights.get('b')).toBe(8)
  })
})
