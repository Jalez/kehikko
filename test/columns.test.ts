import { describe, expect, test } from 'bun:test'

import { SQUEEZED_ROWS, below, mostFor, pay, reach, shares, unfolded, type Box } from '../src/host/columns.ts'
import { CANVAS_ROWS } from '../src/host/fit.ts'

/**
 * A column is a fixed height budget, and growing a container spends it.
 *
 * The owner: "if a user expands another module's container height wise, it
 * should take that height from other elements sharing that column." The two
 * earlier answers to the same complaint are recorded in `fit.ts` and were both
 * about the SCALE — shrink every row, or hold every row and scroll. This is
 * about the arrangement, and these are the tests for the arithmetic.
 */

const gap = 8
void gap

/* The real kehikko this was built against, so the cases below are an
   arrangement somebody actually has rather than one invented to pass. Three
   visual columns: 0-3, 3-8, 8-12. */
const canvas10: Box[] = [
  { i: 'checklist', x: 0, y: 0, w: 3, h: 18 },
  { i: 'paper', x: 3, y: 0, w: 5, h: 28 },
  { i: 'notes', x: 8, y: 0, w: 4, h: 8 },
  { i: 'learning', x: 8, y: 8, w: 4, h: 10 },
  { i: 'notifications', x: 0, y: 18, w: 3, h: 1 },
  { i: 'terminal', x: 8, y: 18, w: 4, h: 10 },
  { i: 'explorer', x: 0, y: 19, w: 3, h: 1 },
]

/* And the one with a full-width container under two narrower ones, which is
   what proves that "column" cannot mean "lane". */
const canvas1: Box[] = [
  { i: 'references', x: 0, y: 0, w: 6, h: 10 },
  { i: 'orchestrator', x: 6, y: 0, w: 6, h: 16 },
  { i: 'journeys', x: 0, y: 10, w: 6, h: 16 },
  { i: 'tests', x: 6, y: 16, w: 6, h: 10 },
  { i: 'diff', x: 0, y: 26, w: 5, h: 1 },
  { i: 'checklist', x: 5, y: 26, w: 7, h: 1 },
  { i: 'paper', x: 0, y: 27, w: 12, h: 1 },
]

const find = (boxes: Box[], i: string) => boxes.find((one) => one.i === i)!

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

describe('who pays, and in what order', () => {
  test('the ones below, nearest first', () => {
    const mates = below(canvas10, find(canvas10, 'notes'))
    expect(mates.map((one) => one.i)).toEqual(['learning', 'terminal'])
  })

  /* Growth goes downward — the resize handle is the south-east corner — so a
     container above is not moved by the one under it getting taller. Taking
     rows from above would mean moving the container being grown, which is not
     what pulling its bottom edge down asks for. */
  test('and never the ones above', () => {
    expect(below(canvas10, find(canvas10, 'terminal')).map((one) => one.i)).toEqual([])
  })

  test('nor anything in another column', () => {
    const mates = below(canvas10, find(canvas10, 'checklist'))
    expect(mates.map((one) => one.i)).toEqual(['notifications', 'explorer'])
  })
})

describe('growing a container', () => {
  /*
   * The whole complaint, as a test. `notes` is in the right-hand column;
   * `checklist` and `paper` are not, and must not move or change size however
   * much `notes` grows.
   */
  test('takes nothing from another column', () => {
    const settled = pay(canvas10, 'notes', 14)
    expect(settled.has('checklist')).toBe(false)
    expect(settled.has('paper')).toBe(false)
    expect(settled.has('explorer')).toBe(false)
    expect(settled.has('notifications')).toBe(false)
  })

  test('takes it from the nearest container below', () => {
    /* The right column is full — 8 + 10 + 10 is 28 — so there is no free space
       and `learning` is the one that pays. */
    const settled = pay(canvas10, 'notes', 12)
    expect(settled.get('notes')).toBe(12)
    expect(settled.get('learning')).toBe(6)
    expect(settled.has('terminal')).toBe(false)
  })

  /* Free space belongs to nobody, so it is spent before anybody is asked. The
     left column of this canvas uses twenty of twenty-eight rows. */
  test('spends the free rows under the column before anybody pays', () => {
    const settled = pay(canvas10, 'checklist', 24)
    expect(settled.get('checklist')).toBe(24)
    /* Six rows were free (28 - 20), and eighteen to twenty-four is six. Nobody
       gave anything up. */
    expect(settled.size).toBe(1)
  })

  test('and then moves on to the next one down when the first is spent', () => {
    const settled = pay(canvas10, 'notes', 20)
    /* `learning` gives 10 -> 3, which is seven; the remaining five come from
       `terminal`, 10 -> 5. */
    expect(settled.get('learning')).toBe(SQUEEZED_ROWS)
    expect(settled.get('terminal')).toBe(5)
    expect(settled.get('notes')).toBe(20)
  })

  /*
   * The floor. A container squeezed to one row is a container drawn as a bare
   * header, which is the FOLDED state — something a person chooses for a
   * container they want out of the way, and not something to inflict on a
   * neighbour because somebody dragged something else.
   */
  test('nobody is squeezed past the floor', () => {
    const settled = pay(canvas10, 'notes', CANVAS_ROWS)
    for (const [id, height] of settled) {
      if (id === 'notes') continue
      expect(height).toBeGreaterThanOrEqual(SQUEEZED_ROWS)
    }
  })

  /* A folded container has nothing to give and is not pushed further down.
     `notifications` and `explorer` are one row each. */
  test('a folded container pays nothing and is not folded further', () => {
    const settled = pay(canvas10, 'checklist', CANVAS_ROWS)
    expect(settled.has('notifications')).toBe(false)
    expect(settled.has('explorer')).toBe(false)
  })

  /*
   * When nobody can pay, the growth stops — the same answer as dragging a
   * container past column twelve, and it should feel the same. `paper` is
   * already the full twenty-eight rows of its column.
   */
  test('growth that nobody can pay for does not happen', () => {
    expect(pay(canvas10, 'paper', CANVAS_ROWS).size).toBe(0)
    expect(pay(canvas10, 'paper', 40).size).toBe(0)
  })

  /* And the partial case, which is the one that could quietly overflow: a
     container asks for more than the column has, and gets exactly as much as
     was payable rather than all of it. */
  test('a growth nobody can fully pay for is granted only as far as it goes', () => {
    const settled = pay(canvas10, 'notes', CANVAS_ROWS)
    /* learning and terminal can give 7 and 7; 8 + 14 is 22, not 28. */
    expect(settled.get('notes')).toBe(22)
    const paid = [...settled].reduce((total, [id, h]) => {
      const was = find(canvas10, id).h
      return id === 'notes' ? total : total + (was - h)
    }, 0)
    expect(paid).toBe(22 - 8)
  })

  /*
   * Every row granted was paid for: out of the free space under the column, or
   * out of somebody below. Nothing is conjured, which is the arithmetic version
   * of "nothing overflows".
   *
   * This is the invariant, and the tempting stronger one is wrong. Summing the
   * heights of everything below the target and asserting it stacks inside
   * twenty-eight rows OVERCOUNTS, because sharing a column is not transitive:
   * on canvas 1, `diff` and `checklist` sit side by side over a full-width
   * `paper`, both below `references`, and they occupy one row band between them
   * rather than two. `reach` reads the bottom edge instead of adding heights
   * for exactly that reason.
   */
  test('every row granted came from somewhere', () => {
    for (const target of ['notes', 'learning', 'checklist', 'references', 'diff', 'orchestrator']) {
      const boxes = canvas10.some((one) => one.i === target) ? canvas10 : canvas1
      const box = find(boxes, target)
      const settled = pay(boxes, target, CANVAS_ROWS)
      const granted = (settled.get(target) ?? box.h) - box.h
      const free = CANVAS_ROWS - reach(boxes, box)
      const given = below(boxes, box).reduce(
        (total, one) => total + (one.h - (settled.get(one.i) ?? one.h)),
        0,
      )
      expect(granted).toBe(Math.min(granted, free + given))
      expect(granted).toBeGreaterThanOrEqual(0)
      /* And what it took is exactly what it was given, with nothing spare taken
         from a neighbour and then not used. */
      expect(granted).toBe(Math.min(free, granted) + given)
    }
  })

  /* And the sum is exactly conserved wherever the column was already full,
     which is the arithmetic version of "it takes that height from other
     elements sharing that column". */
  test('a full column pays for every row it grants', () => {
    /* The right-hand column of canvas 10 is 8 + 10 + 10 = 28, full. */
    const column = ['notes', 'learning', 'terminal']
    const was = column.reduce((total, i) => total + find(canvas10, i).h, 0)
    const settled = pay(canvas10, 'notes', 16)
    const now = column.reduce((total, i) => total + (settled.get(i) ?? find(canvas10, i).h), 0)
    expect(was).toBe(CANVAS_ROWS)
    expect(now).toBe(CANVAS_ROWS)
  })

  /* Shrinking gives rows back to the column as free space and does not inflate
     anybody. Auto-growing a container nobody touched is the same surprise as
     auto-shrinking one, in the other direction. */
  test('shrinking changes nothing but the container that shrank', () => {
    expect(pay(canvas10, 'notes', 4).size).toBe(0)
    expect(pay(canvas10, 'notes', 8).size).toBe(0)
  })

  test('and a container that is not there is not an error', () => {
    expect(pay(canvas10, 'nothing.at.all', 20).size).toBe(0)
  })
})

describe('how tall a container is allowed to become', () => {
  /*
   * `mostFor` is `pay` asked for everything, deliberately, so that the `maxH`
   * the resize handle stops at and the height a resize actually grants can
   * never disagree. A handle that stops where nothing happens, or travels
   * where nothing is granted, is the edge discovered rather than felt.
   */
  test('it agrees with what a growth would actually be granted', () => {
    for (const one of canvas10) {
      const most = mostFor(canvas10, one.i)
      const settled = pay(canvas10, one.i, CANVAS_ROWS)
      expect(most).toBe(settled.get(one.i) ?? one.h)
    }
  })

  test('a container whose column has nothing spare may not grow at all', () => {
    expect(mostFor(canvas10, 'paper')).toBe(28)
  })

  test('and one with free space below it may grow into it', () => {
    expect(mostFor(canvas10, 'checklist')).toBeGreaterThan(18)
  })

  /* Never smaller than what is already there. A `maxH` below an item's own `h`
     is a value react-grid-layout complains about and would mean a container
     that cannot be left alone at the size it is. */
  test('it is never less than the height the container already has', () => {
    for (const one of canvas10) {
      expect(mostFor(canvas10, one.i)).toBeGreaterThanOrEqual(one.h)
    }
    for (const one of canvas1) {
      expect(mostFor(canvas1, one.i)).toBeGreaterThanOrEqual(one.h)
    }
  })

  test('and never past the bottom of the canvas', () => {
    for (const one of [...canvas10, ...canvas1]) {
      expect(mostFor(canvas10, one.i)).toBeLessThanOrEqual(CANVAS_ROWS)
    }
  })
})

describe('coming back from folded', () => {
  const box = (i: string, y: number, h: number, x = 0, w = 6): Box => ({ i, x, y, w, h })

  /*
   * Unfolding is growth, and growth is bought from the column.
   *
   * `onCollapse` used to assign the remembered height straight back, so the one
   * gesture whose whole meaning is "put this back the way it was" was the only
   * one that ignored the budget. Folding hands rows to the column; by the time
   * you unfold, a neighbour has usually taken them.
   */
  test('a column with room gives back everything that was folded away', () => {
    const boxes = [box('a', 0, 1), box('b', 1, 10)]
    const settled = unfolded(boxes, 'a', 12)
    expect(settled.get('a')).toBe(12)
  })

  /*
   * Explicit rows and floor, so the arithmetic is readable rather than a
   * consequence of two constants. A canvas of twelve with a floor of three: `b`
   * holds eleven and can give up eight, so a container asking for twelve gets
   * nine and not a row more.
   */
  test('a column that filled up in the meantime gives back less than was asked', () => {
    const boxes = [box('a', 0, 1), box('b', 1, 11)]
    const settled = unfolded(boxes, 'a', 12, 12, 3)
    expect(settled.get('a')).toBe(9)
    expect(settled.get('b')).toBe(3)
  })

  /* And a column with nothing left to give hands back nothing, rather than
     taking rows that do not exist. */
  test('a column at its floor gives back nothing', () => {
    const boxes = [box('a', 0, 1), box('b', 1, 3), box('c', 4, 3), box('d', 7, 3), box('e', 10, 2)]
    const settled = unfolded(boxes, 'a', 9, 12, 3)
    expect(settled.get('a') ?? 1).toBe(1)
  })

  /* The property that was actually broken: whatever is granted, the column
     still fits the canvas. Before this, unfolding could push the arrangement
     past its rows and a neighbour off the bottom. */
  test('whatever is granted, the column still fits', () => {
    for (const held of [4, 9, 14, 26, CANVAS_ROWS + 5]) {
      const boxes = [box('a', 0, 1), box('b', 1, 12), box('c', 13, 10)]
      const settled = unfolded(boxes, 'a', held)
      const after = boxes.map((one) => settled.get(one.i) ?? one.h)
      expect(after.reduce((sum, h) => sum + h, 0)).toBeLessThanOrEqual(CANVAS_ROWS)
    }
  })

  /* Unfolding and dragging to the same height must end in the same
     arrangement, or the two controls disagree about what a column can hold. */
  test('unfolding agrees with dragging to the same height', () => {
    const boxes = [box('a', 0, 1), box('b', 1, 18)]
    expect([...unfolded(boxes, 'a', 11)]).toEqual([...pay(boxes, 'a', 11)])
  })

  /* Nobody paid, so nothing changed, and a caller must not be handed a
     phantom container to write back. */
  test('a container that is not there settles nothing', () => {
    expect(unfolded([box('a', 0, 4)], 'nobody', 9).size).toBe(0)
  })

  /* No remembered height is the container's current one, not zero: a fold that
     never recorded anything must not unfold into nothing. */
  test('no remembered height asks for the height it already has', () => {
    const boxes = [box('a', 0, 5), box('b', 5, 5)]
    expect(unfolded(boxes, 'a', null).get('a') ?? 5).toBe(5)
  })
})
