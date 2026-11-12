import { cloneLayout, compact, moveElement, type RglItem } from 'react-grid-layout/build/utils'

import { arranged, dragged, drawnWidth, folded, mostFor, wishing, type Wished } from './columns.ts'
import { CANVAS_ROWS, COLUMNS, MIN_W } from './fit.ts'

/**
 * An agent resizing, moving and showing containers on its own kehikko (`arrange_modules` in
 * `server/mcp.ts`), and the mark it leaves.
 *
 * ## The same rules as a person's hand
 *
 * The person asked for agents to be able to "open and resize different modules at will in their
 * kehikko". The arrangement is still the person's, so an agent's change is made by the rules a
 * person's own drag is made by, and nothing else:
 *
 *  - A resize is the south-east corner pulled until the container is that size: the grid's own
 *    clamps (no wider than the columns right of it, no narrower than `MIN_W`, no taller than
 *    `mostFor` grants), the column paying for the height (`wishing`, as `onResize` in `App.tsx`
 *    asks every frame), the grid's own compaction (react-grid-layout's `compact`, the function the
 *    page's grid runs), what the hand said written as a wish (`dragged`, as `fromGrid` does on
 *    release), and every height drawn from the wishes (`arranged`).
 *  - A move is the grip dragged there, step by step, as the grid hears a pointer: each step is the
 *    grid's own `moveElement` and `compact`, so whatever is in the way is pushed and swapped
 *    exactly as under a person's drag, and the drop compacts upward as theirs does.
 *  - Show is the fold control's unfold (`folded` in `columns.ts`): a folded container or a tile
 *    put back at the size and place it had.
 *
 * Nothing here removes a container: every container in is a container out.
 *
 * ## The mark, and Undo
 *
 * Like a fold's (`folds.ts`) and a jump's (`jump.ts`), the mark is the page's alone: which
 * containers an agent changed, the arrangement before and the arrangement it left. The page draws
 * it on those containers and offers **Undo**, which puts back the arrangement before — exactly,
 * every container's place, size, wish and fold. It stands only while the kehikko is as the agent
 * left it (`arrangeStands`): a person's own drag, fold, add or removal takes it away, because Undo
 * would then be undoing them. A second agent change made on top of the first, with nothing of the
 * person's in between, keeps the first arrangement to go back to: Undo undoes the agent, not only
 * its last call.
 */

/** Named widths an agent may ask for instead of a number of columns, of the canvas's `COLUMNS`. */
export const NAMED_WIDTHS = { small: 8, half: 12, wide: 16, full: 24 } as const
export type NamedWidth = keyof typeof NAMED_WIDTHS

/** One container's place and state: what an Undo restores. */
export interface Geometry {
  i: string
  x: number
  y: number
  w: number
  h: number
  wish: number
  collapsed: boolean
  tiled?: boolean
}

/** What one container is asked to become. Any of the four may be left out. */
export interface ArrangeAsk {
  i: string
  /** Width, in grid columns. */
  w?: number
  /** Height, in grid rows. */
  h?: number
  /** Left edge, in grid columns. */
  x?: number
  /** Top edge, in grid rows. */
  y?: number
}

/** The geometry out of a placement, nothing else. */
export function geometryOf(p: Wished): Geometry {
  return {
    i: p.i,
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    wish: p.wish,
    collapsed: p.collapsed,
    ...(p.tiled ? { tiled: true } : {}),
  }
}

/** Whether two arrangements are the same places, sizes, wishes and folds, container for container. */
export function sameGeometry(a: readonly Geometry[], b: readonly Geometry[]): boolean {
  if (a.length !== b.length) return false
  const by = new Map(b.map((g) => [g.i, g]))
  return a.every((one) => {
    const other = by.get(one.i)
    return (
      other !== undefined
      && one.x === other.x
      && one.y === other.y
      && one.w === other.w
      && one.h === other.h
      && one.wish === other.wish
      && one.collapsed === other.collapsed
      && (one.tiled ?? false) === (other.tiled ?? false)
    )
  })
}

type Item = RglItem & { i: string }

/** The arrangement as the page's grid is handed it: drawn heights and tops, a tile at a tile's width. */
function gridOf(placements: readonly Wished[]): Item[] {
  return placements.map((p) => ({ i: p.i, x: p.x, y: p.y, w: drawnWidth(p), h: p.h }))
}

/**
 * What the grid reported, merged onto what is stored: `fromGrid` in `canvases.ts`, for any
 * placement. `held` is the container a hand let go of the corner of; its height is what it said.
 */
function merged<T extends Wished>(was: readonly T[], next: readonly Item[], held: string | null): T[] {
  const by = new Map(was.map((p) => [p.i, p]))
  return next.flatMap((item) => {
    const before = by.get(item.i)
    if (!before) return []
    const said = held === item.i && before.tiled !== true ? dragged(before, item.h) : { wish: before.wish, collapsed: before.collapsed }
    return [{ ...before, x: item.x, y: item.y, w: before.tiled ? before.w : item.w, h: item.h, wish: said.wish, collapsed: said.collapsed }]
  })
}

/** The order the stored array was in, kept: the grid sorts what it compacts. */
function inOrderOf<T extends { i: string }>(was: readonly { i: string }[], next: readonly T[]): T[] {
  const by = new Map(next.map((p) => [p.i, p]))
  return was.flatMap((p) => {
    const one = by.get(p.i)
    return one ? [one] : []
  })
}

/**
 * A person's south-east corner pulled until `id` is `w` columns wide and `h` rows tall.
 *
 * Clamped as the grid clamps a hand: no wider than the columns from its left edge to the canvas's
 * right, no narrower than `MIN_W` (or what it already is, when narrower), no taller than its column
 * can grant (`mostFor`). A tile is not resizable — the page draws it without a corner — and is
 * returned unchanged; show it first.
 */
export function resizedAs<T extends Wished>(placements: readonly T[], id: string, size: { w?: number; h?: number }): T[] {
  const shown = arranged(placements)
  const before = shown.find((p) => p.i === id)
  if (!before || before.tiled) return shown
  const layout = cloneLayout(gridOf(shown))
  const l = layout.find((one) => one.i === id)!
  const w = Math.max(Math.min(MIN_W, before.w), Math.min(COLUMNS - l.x, Math.round(size.w ?? before.w)))
  const h = Math.max(1, Math.min(mostFor(shown, id), Math.round(size.h ?? before.h)))
  l.w = w
  l.h = h
  /* `onResize` in `App.tsx`: every height is what the wishes are granted with this one's in hand. */
  const heights = wishing(shown, id, dragged(before, h))
  for (const one of layout) {
    const height = heights.get(one.i)
    if (height !== undefined) one.h = height
  }
  const next = compact(layout, 'vertical', COLUMNS)
  return arranged(inOrderOf(shown, merged(shown, next, id)))
}

/**
 * A person's drag of `id`'s grip to column `x`, row `y`.
 *
 * The grid hears a pointer as a run of positions, moving and compacting at each; this walks the
 * straight line from where the container is to where it is asked, one cell at a time, through the
 * grid's own `moveElement` and `compact`, so what is in the way is pushed or swapped as it would
 * be under a hand. Clamped as a drag is: inside the columns and above the canvas's floor. The drop
 * compacts upward, so a container asked below empty space rises to meet what is above it, as a
 * person's would.
 */
export function movedTo<T extends Wished>(placements: readonly T[], id: string, to: { x?: number; y?: number }): T[] {
  const shown = arranged(placements)
  const before = shown.find((p) => p.i === id)
  if (!before) return shown
  let layout = cloneLayout(gridOf(shown))
  const start = layout.find((one) => one.i === id)!
  const x = Math.max(0, Math.min(COLUMNS - start.w, Math.round(to.x ?? before.x)))
  const y = Math.max(0, Math.min(CANVAS_ROWS - start.h, Math.round(to.y ?? before.y)))
  const steps = Math.max(Math.abs(x - start.x), Math.abs(y - start.y))
  const from = { x: start.x, y: start.y }
  for (let step = 1; step <= steps; step++) {
    const l = layout.find((one) => one.i === id)!
    const px = Math.round(from.x + ((x - from.x) * step) / steps)
    const py = Math.round(from.y + ((y - from.y) * step) / steps)
    layout = compact(moveElement(layout, l, px, py, true, false, 'vertical', COLUMNS), 'vertical', COLUMNS)
  }
  return arranged(inOrderOf(shown, merged(shown, layout, null)))
}

/** Folded containers and tiles put back, as the fold control's unfold puts them. */
export function shown<T extends Wished>(placements: readonly T[], ids: readonly string[]): T[] {
  return arranged(folded(placements, { unfold: ids }))
}

/**
 * Every ask applied in order: shown first, then each container moved and resized as asked.
 * The containers going in are the containers coming out.
 */
export function arrangedAs<T extends Wished>(placements: readonly T[], asks: readonly ArrangeAsk[], show: readonly string[] = []): T[] {
  let now = show.length ? shown(placements, show) : arranged(placements)
  for (const ask of asks) {
    if (ask.x !== undefined || ask.y !== undefined) now = movedTo(now, ask.i, { x: ask.x, y: ask.y })
    if (ask.w !== undefined || ask.h !== undefined) now = resizedAs(now, ask.i, { w: ask.w, h: ask.h })
  }
  return now
}

/* ------------------------------------------------------------------ *
 * The note a wake carries, and the mark the page keeps
 * ------------------------------------------------------------------ */

/** What travels with a wake when an agent arranged a kehikko — `ArrangeNote` in `server/wake.ts`. */
export interface ArrangeNote {
  by: string
  /** The containers the agent asked about and that changed. */
  changed: string[]
  /** Every container before the change, and after it. */
  before: Geometry[]
  after: Geometry[]
}

/** The mark on one kehikko: who, which containers, what Undo restores and what it stands on. */
export interface ArrangeMark extends ArrangeNote {
  kehikko: number
}

const MAX_IDS = 64
const MAX_TEXT = 64

function geometryIn(value: unknown): Geometry | null {
  if (typeof value !== 'object' || value === null) return null
  const { i, x, y, w, h, wish, collapsed, tiled } = value as Record<string, unknown>
  const whole = (n: unknown, max: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max
  if (typeof i !== 'string' || !i.length || i.length > MAX_TEXT) return null
  if (!whole(x, 200) || !whole(y, 10_000) || !whole(w, 200) || !whole(h, 400) || typeof wish !== 'number' || !Number.isFinite(wish)) return null
  if (typeof collapsed !== 'boolean' || (tiled !== undefined && typeof tiled !== 'boolean')) return null
  return { i, x, y, w, h, wish, collapsed, ...(tiled ? { tiled: true } : {}) }
}

/** A note read off the wake stream, bounded before it is believed; `null` for anything that is not one. */
export function arrangeNoteIn(value: unknown): ArrangeNote | null {
  if (typeof value !== 'object' || value === null) return null
  const { by, changed, before, after } = value as Record<string, unknown>
  if (typeof by !== 'string' || !by.length || by.length > MAX_TEXT) return null
  if (!Array.isArray(changed) || changed.length > MAX_IDS || !changed.every((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_TEXT)) return null
  const list = (raw: unknown): Geometry[] | null => {
    if (!Array.isArray(raw) || raw.length > MAX_IDS) return null
    const out: Geometry[] = []
    for (const one of raw) {
      const g = geometryIn(one)
      if (!g) return null
      out.push(g)
    }
    return out
  }
  const was = list(before)
  const now = list(after)
  if (!was || !now) return null
  return { by, changed: changed as string[], before: was, after: now }
}

/**
 * The mark after a note. A note made on top of the arrangement the standing mark left — the same
 * agent going on, with nothing of the person's in between — keeps the FIRST arrangement to go back
 * to, and names every container either changed.
 */
export function arrangeNoted(mark: ArrangeMark | null, kehikko: number, note: ArrangeNote): ArrangeMark {
  if (mark && mark.kehikko === kehikko && sameGeometry(mark.after, note.before)) {
    return { kehikko, by: note.by, changed: [...new Set([...mark.changed, ...note.changed])], before: mark.before, after: note.after }
  }
  return { kehikko, ...note }
}

/** Whether a mark still describes what is drawn: the kehikko is exactly as the agent left it. */
export function arrangeStands(mark: ArrangeMark | null, kehikko: number | null, placements: readonly Wished[]): boolean {
  return mark !== null && mark.kehikko === kehikko && sameGeometry(mark.after, placements.map(geometryOf))
}

/**
 * Undo: the arrangement before, every container's place, size, wish and fold put back, and
 * everything else about each container — its prompt, its pin, what it shows — left as it is now.
 * `null` when the mark no longer stands, because then Undo would undo the person.
 */
export function undoneTo<T extends Wished>(mark: ArrangeMark | null, kehikko: number | null, placements: readonly T[]): T[] | null {
  if (!mark || !arrangeStands(mark, kehikko, placements)) return null
  const was = new Map(mark.before.map((g) => [g.i, g]))
  return placements.map((p) => {
    const g = was.get(p.i)
    if (!g) return p
    const { tiled: _tiled, ...rest } = p
    return { ...(rest as T), x: g.x, y: g.y, w: g.w, h: g.h, wish: g.wish, collapsed: g.collapsed, ...(g.tiled ? { tiled: true } : {}) }
  })
}

/** The line the mark says, text only. */
export function arrangeMarkText(mark: ArrangeMark, names: (id: string) => string = (id) => id): string {
  const which = mark.changed.map(names)
  const list = which.length <= 3 ? which.join(', ') : `${which.slice(0, 3).join(', ')} and ${which.length - 3} more`
  return `Arranged by ${mark.by}: ${list}.`
}
