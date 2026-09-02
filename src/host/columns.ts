import { CANVAS_ROWS } from './fit.ts'

/**
 * A column is a fixed height budget, and growing a container spends it.
 *
 * ## What the owner asked for, and why it is the right shape
 *
 * "What I want to see happen is that if a user expands another module's
 * container height wise, it should take that height from other elements sharing
 * that column."
 *
 * That is the true mirror of the width axis, and it is worth saying why rather
 * than merely doing it. Twelve columns are a fixed budget: a container that
 * takes more width takes it from what is beside it, nothing overflows, and a
 * container in a different row is not consulted. Height should work the same
 * way, with the canvas height as the budget — which `fit.ts` has now made a
 * fixed twenty-eight rows, so there IS a budget to spend.
 *
 * Two earlier answers to the same complaint were wrong and are recorded in
 * `fit.ts`: shrinking every row on the canvas when any container grew (which
 * resized containers with no relationship to the one that moved), and holding
 * the row height steady and letting the canvas scroll (which brought back the
 * overflow the whole exercise started from). Both were about the SCALE. This is
 * about the arrangement, which is where it belongs.
 *
 * ## Why the arithmetic is here and not in the grid
 *
 * `react-grid-layout`'s answer to a collision is to PUSH. Growing a container
 * shoves its column-mate down, and — since compaction does not consult
 * `maxRows` — off the bottom of the canvas. There is no configuration for
 * "take the space from the thing below instead", so the rule has to be written
 * out, and it may as well be written somewhere it can be tested without a
 * browser, a pointer, or a grid.
 *
 * Everything here is pure and takes boxes rather than placements, so a test
 * says `{ i: 'a', x: 0, y: 0, w: 6, h: 10, wish: 10, collapsed: false }` and
 * not a canvas.
 */

/** A container's place on the grid, which is all the geometry here needs. */
export interface Box {
  i: string
  x: number
  y: number
  w: number
  h: number
}

/**
 * A container's place on the grid, and what its owner asked of it.
 *
 * `h` is what is DRAWN and `wish` is what was ASKED FOR, and keeping the two
 * apart is the whole of the design. Read the essay on `granted` for why.
 */
export interface Wished extends Box {
  /** The height its owner last chose on purpose, in rows. See `granted`. */
  wish: number
  /** Folded down to its header, which is a state and not a height. */
  collapsed: boolean
}

/**
 * The least a container may be squeezed to by somebody else's growth.
 *
 * Three rows, and the number is a judgement about what a container still IS.
 * One row is the FOLDED height — a header and nothing under it — and folding is
 * a state a person chooses for a container they want out of the way. Inflicting
 * it on a neighbour because somebody dragged something else would be the host
 * folding a module nobody asked to fold, and it would look like the container
 * had crashed rather than been squeezed.
 *
 * Three rows is a header and something under it at every row height this canvas
 * uses: 88 pixels on the screen these arrangements were built for, and 52 at
 * the floor, against a header of 32. It is deliberately not generous. A
 * neighbour that will not shrink is a growth that stops, and stopping is worse
 * for the person doing the growing than a short container is for the person who
 * is not currently looking at it.
 *
 * A container ALREADY below this — a folded one — is not pushed further and is
 * not expanded either. It simply has nothing to give.
 */
export const SQUEEZED_ROWS = 3

/**
 * The height of a folded container: a header and nothing under it.
 *
 * One, and the point of it is that nothing is reserved that is not drawn — see
 * the essay on the folded container in `canvas/Container.tsx`, which is where
 * the two-row version was measured and rejected: the emptiness did not go away,
 * it moved outside the container, and a person folding something to reclaim
 * space got twenty-two pixels of nothing between it and its neighbour.
 *
 * It is a count and not a computed number of rows. A row is `room /
 * CANVAS_ROWS` — 24 pixels on the canvas these arrangements were built for, 34
 * on a tall monitor, 12 at the floor — and the header goes dense when folded,
 * which is a change to one CSS rule rather than to the grid. A folded container
 * is ONE of whatever a row is, in the same sense that a full-width container
 * is twelve columns. Making it depend on the drawn row height would put the
 * arrangement back in the business of reading its own scale, which is the
 * loop `fit.ts` exists to keep shut.
 *
 * It lives here, beside `SQUEEZED_ROWS`, because the two are one judgement seen
 * from two sides: one row is what a container becomes when its owner folds it,
 * and three is the least it may be pushed to by anybody else. And it is what a
 * DRAG is measured against: a corner pulled up to this height is a fold, and a
 * folded container's corner pulled past it is an unfold — see `dragged`.
 */
export const FOLDED_ROWS = 1

/**
 * Do these two containers share a column?
 *
 * They overlap in x, which is a broader question than "are they in the same
 * column" and deliberately so. Containers are placed by `x` and `w` over twelve
 * columns and nothing partitions those columns into lanes: a container six wide
 * at x=0 shares columns with a container three wide at x=0, with one three wide
 * at x=3, and with a full-width one at x=0 w=12. On the canvases in this
 * workspace right now, one kehikko has a twelve-wide container underneath a
 * five-wide and a seven-wide, and any rule that assumed lanes would have said
 * those three were unrelated.
 *
 * Note what follows: sharing is NOT transitive. A overlapping B and B
 * overlapping C does not make A and C column-mates, and there is no equivalence
 * class of "this column" to compute. Every question here is therefore asked
 * about ONE container's own mates, which is also the honest scope — a person
 * growing a container is looking at what is directly under it, not at a graph.
 */
export function shares(a: Box, b: Box): boolean {
  return a.i !== b.i && a.x < b.x + b.w && b.x < a.x + a.w
}

/**
 * Everything sharing a column with `box`, that sits BELOW it, nearest first.
 *
 * Below rather than around, because growth goes downward: the resize handle is
 * the south-east corner, and a container above is not moved by the one under it
 * getting taller. Taking rows from something above would mean moving the
 * container being grown, which is not what anybody asked for when they pulled
 * its bottom edge down.
 *
 * Two boxes that overlap in x cannot overlap in y — the grid does not allow it
 * — so "below" is unambiguous and needs no tie-breaking. It is decided by the
 * top edges alone, and not by whether `other` starts under this box's BOTTOM
 * edge, on purpose: between a height being written and the grid compacting
 * the containers under it, the stored `y` of a neighbour is where it was and
 * the stored `h` above it is already new, and a rule that compared against the
 * bottom edge would say for one render that the neighbour was not there.
 */
export function below<T extends Box>(boxes: readonly T[], box: Box): T[] {
  return boxes
    .filter((other) => shares(box, other) && other.y > box.y)
    .sort((one, two) => one.y - two.y)
}

/**
 * What the heights become, given every wish in the arrangement.
 *
 * Returns id → drawn height, for EVERY container given.
 *
 * ## A wish and a height are two different facts
 *
 * The bug this replaces was an asymmetry. A container growing took rows from
 * its column-mates and wrote the squeezed heights into them as if they had been
 * chosen — so when the grower later folded, and its rows became free space,
 * nothing knew that the neighbour had ever wanted them. The person was left
 * with a folded container, a shrunken one, and a band of empty canvas. The
 * rows had been taken and nothing could give them back, because the evidence
 * of what the neighbour had asked for was overwritten the moment it was
 * squeezed.
 *
 * So each container now carries a `wish`: the height its owner last chose on
 * purpose, by dragging its corner or by turning `grow` on and letting the
 * module ask. The height actually drawn is THIS function of every wish and the
 * budget, and nothing else. When a column is over-subscribed, wishes are cut
 * down to fit; when it has room, everybody is drawn at their wish. Giving rows
 * back is not a gesture with its own code path — it is what this function
 * returns once the rows are free — and there is deliberately no other rule
 * beside it that could drift from it.
 *
 * The invariant that follows, and that every caller has to hold: SQUEEZING
 * NEVER WRITES THE WISH. A caller that stored a drawn height back into `wish`
 * has destroyed the one fact this file exists to keep, and no later code can
 * recover it. The only things that write a wish are a hand on the corner and a
 * module asking, because those are the only two things that MEAN "this tall".
 *
 * ## Folding is a state, not a height
 *
 * A folded container is drawn at `FOLDED_ROWS` and its wish is left exactly as
 * it was, so unfolding is not "remember a height and put it back" — it is
 * clearing a flag and asking this function again. The height a person had
 * before folding comes back because it was never lost, and it comes back
 * SUBJECT TO THE BUDGET, because it is a wish like any other: a column that
 * filled up while the container was folded gives it back less. That is the
 * lesson the old `unfolded()` recorded — unfolding used to assign a remembered
 * height straight back and overflowed the canvas — kept, and now unable to be
 * forgotten, because there is no path that assigns a height at all.
 *
 * ## Who gets their wish when not everybody can: the top of the column first
 *
 * Rows are handed out from the top of the column down. Each container takes
 * its wish, less whatever is needed to leave every container under it at its
 * floor; whatever is left is what the next one down is offered. That is the
 * mirror of the rule growth always had — a container above is never moved by
 * the one under it getting taller — made into a total order, so the answer is
 * the same whichever gesture came last.
 *
 * It is worth being honest about what that order gives up. The old `pay()`
 * squeezed the NEAREST container below the one being grown first, on the
 * argument that the nearest is the one a person can see moving. That was a
 * property of a gesture — "the one that grew, then the ones under it, nearest
 * first" — and a function of the wishes alone has no gesture to be relative
 * to: the same three wishes have to give the same three heights whether the top
 * container grew last or the middle one did, or an arrangement would reshuffle
 * itself the next time anything unrelated asked. In a column of two
 * containers, which is every column in the reports this was built against, the
 * two rules agree exactly. In a longer chain the bottom container is now the
 * first to make room and the one directly under the grower the last.
 *
 * ## The budget holds, and the floor holds wherever it can
 *
 * A container is granted only what leaves the deepest chain of floors under it
 * inside the canvas, so whatever is under it can always be placed, and no
 * chain of containers reaches past `rows`. Nobody is drawn below
 * `SQUEEZED_ROWS` by somebody else's wish; a folded container is drawn at
 * `FOLDED_ROWS` and asked for nothing; and a container whose own wish is under
 * the floor is drawn at its wish — a wish is not a reason to grow.
 *
 * The floor is a limit on what OTHERS may take from a container, not a claim
 * on rows the column does not have. So when a container is unfolded into a
 * column whose mates are already at their floors, it is drawn at what is left
 * — down to one row — rather than at its floor with the bottom of the column
 * pushed off the canvas. That is the same answer the old `unfolded()` gave
 * ("a column at its floor gives back nothing"), and it is the right way
 * round: a canvas that overflows is the bug this whole area started from,
 * and a container that came back short is a container a person can see the
 * reason for. The one arrangement in which floors are not honoured at all is
 * one whose floors alone do not fit — ten containers of three stacked in a
 * column of twelve — and there the rows run out from the top down, one row
 * each, until the rest fit. Nothing can make that arrangement fit; this only
 * decides that the canvas holds and the containers do not.
 *
 * ## Why the positions are recomputed here
 *
 * The grid compacts vertically: every container moves up until it meets one it
 * shares columns with. So when a height changes, every `y` under it changes
 * too, and the stored `y` says where a container WAS. Whether a chain fits is
 * a question about where things will be, so this walks the containers in the
 * grid's own order — by `y`, then `x` — and places each under the lowest of
 * its column-mates above, exactly as the grid will. Only the ORDER is taken
 * from the stored positions, and compaction preserves order, which is what
 * makes the answer stable across the round trip through the grid: ask again
 * after it has settled and the same heights come back.
 */
export function granted(
  boxes: readonly Wished[],
  rows = CANVAS_ROWS,
  floor = SQUEEZED_ROWS,
): Map<string, number> {
  /* What each container asks of the column. A wish is bounded here rather than
     trusted: a wish of no rows is a container deleted by a rounding error, and
     a wish past the canvas is simply "as much as there is". */
  const wanted = (box: Wished) =>
    box.collapsed ? FOLDED_ROWS : Math.max(1, Math.min(rows, Math.round(box.wish)))

  /* The least a container may be pushed to by anybody ABOVE it wanting more:
     its wish, if that is under the floor — a container that asked for two rows
     is not owed three — and otherwise the floor. Reserved for it before
     anything above is granted a row, which is what makes the floor hold. */
  const least = (box: Wished) => Math.min(wanted(box), floor)

  /* The deepest chain of floors under a container: how many rows the things
     under it need before it may take any for itself. Memoised, because a
     container in a wide column is under several and would be walked once per
     path. */
  const deepest = new Map<string, number>()
  const depth = (box: Wished): number => {
    const known = deepest.get(box.i)
    if (known !== undefined) return known
    let most = 0
    for (const under of below(boxes, box)) most = Math.max(most, least(under) + depth(under))
    deepest.set(box.i, most)
    return most
  }

  const heights = new Map<string, number>()
  const placed = new Map<string, number>()
  for (const box of inGridOrder(boxes)) {
    const top = stacked(boxes, box, placed, heights)
    /* What is left once everything under it has its floor. At least one row
       whatever the arithmetic says — a container of no rows is a container
       deleted — and never more than that, whatever the floor says: see the
       essay above on why the budget wins. */
    const room = rows - top - depth(box)
    heights.set(box.i, Math.max(1, Math.min(wanted(box), room)))
    placed.set(box.i, top)
  }
  return heights
}

/**
 * Where each container's top edge will be once everything is at the height
 * `granted` gives it, in rows.
 *
 * `granted` computes this on the way to its answer and does not return it;
 * this is the same walk, exported so a test can say "nothing reaches past the
 * bottom" about positions rather than about a sum of heights — which is only
 * the same thing in a column that is a single stack.
 */
export function tops(
  boxes: readonly Wished[],
  rows = CANVAS_ROWS,
  floor = SQUEEZED_ROWS,
): Map<string, number> {
  const heights = granted(boxes, rows, floor)
  const placed = new Map<string, number>()
  for (const box of inGridOrder(boxes)) placed.set(box.i, stacked(boxes, box, placed, heights))
  return placed
}

/** The order the grid compacts in: by row, then by column. */
function inGridOrder<T extends Box>(boxes: readonly T[]): T[] {
  return [...boxes].sort((one, two) => one.y - two.y || one.x - two.x)
}

/**
 * Where the grid will put `box`: under the lowest column-mate above it that
 * has already been placed. Zero for a container with nothing above it.
 */
function stacked(
  boxes: readonly Box[],
  box: Box,
  placed: ReadonlyMap<string, number>,
  heights: ReadonlyMap<string, number>,
): number {
  let top = 0
  for (const other of boxes) {
    if (other.y >= box.y || !shares(box, other)) continue
    top = Math.max(top, (placed.get(other.i) ?? 0) + (heights.get(other.i) ?? 0))
  }
  return top
}

/**
 * What the heights become when ONE container's wish or fold changes.
 *
 * `granted` with the change swapped in, which is what every gesture is: a drag
 * of the corner, a module asking for its document's height, a press on the fold
 * control. It is a convenience and not a second rule — the answer is
 * `granted`'s, and a caller that computed something else for "just this one"
 * would be the drift this file exists to prevent.
 */
export function wishing(
  boxes: readonly Wished[],
  id: string,
  change: Partial<Pick<Wished, 'wish' | 'collapsed'>>,
  rows = CANVAS_ROWS,
  floor = SQUEEZED_ROWS,
): Map<string, number> {
  return granted(
    boxes.map((one) => (one.i === id ? { ...one, ...change } : one)),
    rows,
    floor,
  )
}

/**
 * The tallest this container could become right now.
 *
 * `granted` asked with this container wishing for the whole canvas, and told
 * what it would get. Written this way rather than as its own arithmetic so
 * there is exactly one rule: a `maxH` that disagreed with what a resize
 * actually draws would be a handle that stops somewhere nothing happens, or
 * travels somewhere nothing is granted.
 */
export function mostFor(
  boxes: readonly Wished[],
  id: string,
  rows = CANVAS_ROWS,
  floor = SQUEEZED_ROWS,
): number {
  const box = boxes.find((one) => one.i === id)
  if (!box) return rows
  return wishing(boxes, id, { wish: rows, collapsed: false }, rows, floor).get(id) ?? box.h
}

/**
 * What a hand on the corner has said, once the container is `h` rows tall.
 *
 * ## A drag to the folded height IS a fold
 *
 * One row is the folded height — a header and nothing under it — and the
 * SQUEEZED_ROWS essay is explicit that no neighbour is ever pushed there,
 * because one row is a state a person chooses. A person who has pulled a
 * container's corner all the way up to it has chosen it. Before this, the grid
 * took the height and the container stayed open: one row tall, drawing a
 * header and a sliver of a page, not folded, and — worse — with nothing
 * remembered, so there was no height to come back to. So the drag sets
 * `collapsed` and LEAVES THE WISH ALONE, exactly as the fold control does, and
 * unfolding returns the container to the height it had before the drag.
 *
 * "One row or less" rather than "exactly one": the grid does not go below one,
 * but a rounded pixel measurement can, and a zero must read as a fold rather
 * than as a request for nothing.
 *
 * ## And a drag out of it is an unfold
 *
 * A folded container's corner pulled taller is a person saying "I want to see
 * this", which is the same sentence the fold control says. It is honoured as
 * one: the flag clears and the height they dragged to becomes the wish, which
 * is better than the height it was folded FROM — they have just said where
 * they want it. Refusing the resize would be worse: a handle that does not
 * move is a handle somebody pulls again, harder, and then reports.
 *
 * ## A drag that ends where it started has said nothing
 *
 * `h` arrives for every container on every gesture, and a corner pressed and
 * released without moving is not a choice. Neither writes the wish. This
 * matters most for a container that is currently SQUEEZED below its wish: a
 * rule that wrote `h` back on any release would overwrite the wish with the
 * squeezed height, and that is the exact bug this file's `granted` essay names
 * as the one thing no caller may do.
 *
 * ## Only on release
 *
 * The fold itself is applied when the corner is let go, not while it moves.
 * While a drag is in flight the grid owns the layout and the stored placements
 * stand still, and a container flickering between folded and open as the
 * pointer crosses a row boundary would be a state changing under a hand that
 * has not finished. The HEIGHTS are live — `granted` runs on every frame with
 * the in-flight height as this container's wish, so the neighbours give and
 * take as the pointer moves — but a state changes when the gesture ends.
 */
export function dragged(
  before: Pick<Wished, 'h' | 'wish' | 'collapsed'>,
  h: number,
  folded = FOLDED_ROWS,
): Pick<Wished, 'wish' | 'collapsed'> {
  if (h === before.h) return { wish: before.wish, collapsed: before.collapsed }
  if (h <= folded) return { wish: before.wish, collapsed: true }
  return { wish: h, collapsed: false }
}
