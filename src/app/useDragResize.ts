import { useCallback, useEffect, useRef, useState } from 'react'
import type { ItemCallback, Layout } from 'react-grid-layout'
import { fromGrid, reportArranging, type Placement } from '@/host/canvases.ts'
import { dragged, granted, redrawn, topEdge, wishing } from '@/host/columns.ts'
import { cornerOf } from '@/host/corners.ts'
import { rowsHolding } from '@/host/fit.ts'

/** How long a fold, an unfold, or a container let go of glides: the grid's 200 ms, and a frame either side. */
const GLIDE_MS = 260

/** Below this, a request is agreement rather than a request. */
const WORTH_GROWING_PX = 12

export interface DragResizeInputs {
  /** The open kehikko as drawn (`open` in `App.tsx`), or null: what a gesture is measured against. */
  open: { placements: Placement[] } | null
  /** The kehikko open, for the "arranging" report (`server/arranging.ts`). */
  openId: number | null
  /** Change the open canvas (`change` in `App.tsx`): on screen now, written shortly. */
  change: (edit: { placements?: Placement[] }) => void
  /** Whether the host draws this container's footer now, so a corner pulled to two rows is a two-row fold. */
  twoRowsFor: (id: string) => boolean
  /** How tall a row is drawn, and the gap between rows (`MARGIN[1]`). */
  rowHeight: number
  rowGap: number
  /** `useRects`' measuring: once a frame while a container moves, and after its glide. */
  remeasure: () => void
  settle: () => void
  /** The page's `Writer`: what the hand left is stored before agents may arrange again. */
  writer: { flushAll: () => Promise<unknown> }
}

/**
 * A hand on the arrangement: a container dragged by its grip or resized by a
 * corner, what the grid reports back, and a module asking to grow.
 *
 * Moved out of `App.tsx` as it was. The handlers for the grid are made on
 * every render, as they were written inline on it, so each reads the
 * arrangement and the corner held at that render; `onLayoutChange` and
 * `onHeight` are memoised on what they were before. `moving`, `pulling` and
 * `gliding` are state the page draws from (the grid's `in-motion`, `maxH`, the
 * frames layer); `resized` and `traded` are refs, for the reasons below.
 */
export function useDragResize({ open, openId, change, twoRowsFor, rowHeight, rowGap, remeasure, settle, writer }: DragResizeInputs) {
  /* Which container is being dragged or resized, if any — see `Frames.tsx` for why
     the pages stop taking the pointer for the duration, and why the one under
     the hand is hidden rather than chased. */
  const [moving, setMoving] = useState<string | null>(null)
  /* Which container's TOP edge a hand is pulling, if any: a top corner trades
     rows with what is on top of the container rather than with what is below
     it, so how far it may travel is a different number (`mostUp`). Known only
     once the press has landed on a handle, hence state and not a constant. */
  const [pulling, setPulling] = useState<string | null>(null)
  /* What the containers on top of the one whose top edge is being pulled have
     been given, by id: their new heights, and so their new wishes. Written by
     `onResize`, consumed by `onLayoutChange` on release like `resized`. */
  const traded = useRef<Map<string, number>>(new Map())
  /* The container whose corner a hand is on, from `onResizeStart` until
     `onLayoutChange` reads it on release. A ref and not state, because it is
     read inside a callback the grid calls synchronously on release, before any
     render could have delivered a state update. See `onLayoutChange`. */
  const resized = useRef<string | null>(null)
  /*
   * Whether the grid animates what changes in it. Only for what a person did
   * to the arrangement — a drag, a resize, and the glide of a container let go
   * of — and for a fold or an unfold; never for a switch, a load, a module
   * asking to grow or a window resized. See `.in-motion` in `index.css`.
   * `gliding` counts the glides asked for, so a second one restarts the timer.
   */
  const [gliding, setGliding] = useState(0)
  useEffect(() => {
    if (!gliding) return
    const done = setTimeout(() => setGliding(0), GLIDE_MS)
    return () => clearTimeout(done)
  }, [gliding])
  /* A drag or a resize let go of: once what the hand left is stored, agents may arrange again. The
     grid reports the layout in the same tick as the stop, so the write is queued after it. */
  const arrangedByHand = () => {
    const on = openId
    if (on === null) return
    setTimeout(() => void writer.flushAll().then(() => reportArranging(on, false)), 0)
  }
  /**
   * A module saying how tall it would like to be. Acted on only where asked.
   *
   * ## Why this is opt-in per container
   *
   * Honouring it everywhere was tried twice and fought the person both times.
   *
   * *Grow whenever asked* has a runaway in it. A module measures its own
   * document; its document is as tall as the frame the host gave it; so growing
   * the container grows the document, which asks for more. It does not oscillate, it
   * climbs — one container here reached eighty rows, two and a half thousand pixels,
   * pushing its own resize handle off the bottom of the canvas where nothing
   * could reach it.
   *
   * *Grow once per load* bounds the runaway and keeps the argument, just
   * slower: a container smaller than its module's content is grown again on every
   * refresh. You size a container, reload, and it is bigger. A disagreement that
   * resumes each time the page opens is not a compromise.
   *
   * What was wrong in both is that the host was deciding. Whether a container should
   * fit its contents or hold its size is a question about how somebody wants to
   * read this particular thing, and there is no answer that is right for every
   * container — a list you scan wants to stay put and scroll; a summary you want to
   * see all of wants to fit. So it is a switch on the container, off by default,
   * remembered with the arrangement.
   *
   * ## The brake stays even when it is on
   *
   * Opting in must not opt into the runaway. Two things prevent it. The container
   * only ever GROWS towards the requested height and never past the bottom of the
   * canvas, so the worst case is bounded and reachable. And growth stops as soon
   * as the request is no longer meaningfully larger than the container — a page
   * that fills whatever frame it is given reports the frame's own height, which
   * after one step is the height it already has, and the climb ends there instead
   * of continuing by a rounding error a step.
   *
   * ## A module cannot do what a person cannot
   *
   * The ceiling used to be `MOST_ROWS = 40` — "a tall container on any screen
   * and nowhere near a runaway" — which was a sensible invention when a canvas
   * had no bottom. It has one now, and more than that, growing has a PRICE:
   * `granted` in `columns.ts` draws every container at what its wish leaves
   * for the containers below it, from the free space under the column first
   * and then from the containers below, down to a floor.
   *
   * A module asking to grow goes through exactly that, so a request from a
   * program does the same thing to a canvas that a hand on the resize handle
   * would. The alternative — a separate ceiling here — would have meant a
   * module could quietly do what a person is not allowed to do, on a canvas the
   * person is looking at, which is the wrong way round for the one path where
   * nobody is holding the mouse.
   *
   * What a module that asks for more than the column can pay gets is the part
   * that was payable, and its own page scrolls for the rest. That is what a
   * container already at the bottom of a full column does today, and the
   * vertical twin of a container that cannot be widened past the last column.
   *
   * ## And the arithmetic uses the DRAWN row, which it could not before
   *
   * `fit.ts` used to forbid exactly this: converting pixels to rows with the
   * drawn height closed a loop — shorter rows, more rows for the same pixels, a
   * taller arrangement, shorter rows again. The loop needed the row height to
   * depend on the arrangement, and it no longer does; it depends on the window
   * and a constant. With that gone, using the nominal row would be plainly wrong:
   * on a small window a module asking for 300 pixels would be given rows that
   * draw 160, ask again, and be refused for asking for what it did not get.
   */
  const onHeight = useCallback(
    (id: string, px: number) => {
      const placements = open?.placements ?? []
      const container = placements.find((p) => p.i === id)
      if (!container?.grow) return

      /* How many rows hold `px`, at the height rows are actually drawn at.
         What the column will actually GRANT of that is `granted`'s answer, in
         `redrawn`; this is only the conversion. Bounded by the canvas, because
         a wish past it is simply "as much as there is" and a wish of ten
         thousand rows is not a height anybody chose. */
      const rowsFor = (wanted: number) => rowsHolding(wanted, rowHeight, rowGap)

      /*
       * A collapsed container does not grow, and the request is not thrown away.
       *
       * `kehikot.resize` is a module saying how tall its document is. A module
       * is not told anything about itself being folded — see `onCollapse` —
       * so it goes on measuring and asking, and honouring that here would let a
       * module force a container open that a person folded shut. The person's press
       * wins. What the module asked for becomes the wish, which is what the
       * container is unfolded towards, so a module that grew while folded is the
       * right size when it comes back rather than the size it was when it was
       * put away. `redrawn` is not needed: a folded container is drawn at one
       * row whatever it wishes.
       */
      /* A tile is drawn at a tile's height whatever it wishes, as a folded container is. */
      if (container.collapsed || container.tiled) {
        const wanted = rowsFor(px)
        if (wanted <= container.wish) return
        change({ placements: placements.map((p) => (p.i === id ? { ...p, wish: wanted } : p)) })
        return
      }

      const isNow = container.h * rowHeight + (container.h - 1) * rowGap
      if (px <= isNow + WORTH_GROWING_PX) return

      /*
       * Only a LARGER wish. A module measures its document and asks on every
       * change, and a container drawn short because a neighbour took its rows
       * is a container whose module is asking for what it already wishes for
       * — the wish is not the problem, the column is, and re-writing the same
       * wish would be a write per measurement for nothing.
       *
       * Then through the same rule a hand on the resize handle goes through:
       * the wish is written, and `redrawn` asks the column what every wish is
       * granted. A column with nothing to give draws the same heights, and
       * `change` is a no-op write of the wish alone.
       */
      const wanted = rowsFor(px)
      if (wanted <= container.wish) return
      change({ placements: redrawn(placements.map((p) => (p.i === id ? { ...p, wish: wanted } : p))) })
    },
    [change, open?.placements, rowHeight],
  )

  const onLayoutChange = useCallback(
    (next: Layout[]) => {
      /* `grow` is carried across from what is already stored, because the grid
         has never heard of it: `next` is react-grid-layout's own idea of the
         arrangement, and anything of ours not in its vocabulary would be
         dropped here on the first drag. */
      const was = open?.placements ?? []
      /*
       * Which container, if any, a hand has just let go of the corner of.
       *
       * `next` carries a new `h` for EVERY container a resize touched — the
       * one being pulled and every column-mate `onResize` squeezed or let back
       * out — and only one of those heights was chosen. `resized` was set on
       * `onResizeStart` and names it; the rest are what `granted` drew, and
       * writing THOSE into a wish would be the one thing `columns.ts` says no
       * caller may do. Consumed here rather than cleared on `onResizeStop`,
       * because the library calls that first and this second in the same
       * tick, and cleared at the start of the next gesture in case a release
       * changed nothing and this was never called.
       */
      const held = resized.current
      /* The rows a top edge took from, or gave to, the containers on top of
         it: those heights were chosen by the same hand, so they are wishes. */
      const given = traded.current
      const placements = fromGrid(was, next, held, given, twoRowsFor)
      /*
       * Then drawn at what the wishes are granted. A move can change who
       * shares a column with whom — a container dragged out of a full column
       * leaves room its mates wished for, one dragged in takes it — and a
       * fold by drag is a fold like any other: the folded container is drawn
       * at one row and its column-mates at their wishes. The heights the grid
       * reported were `onResize`'s answer to the same question with the same
       * wishes, so on a plain resize this changes nothing and costs a walk.
       *
       * react-grid-layout fires this during a drag as well as at the end.
       * Doing nothing when nothing changed keeps the write out of the drag
       * loop — and `Writer` merges what does get through, so a whole gesture
       * is one request rather than forty.
       */
      const drawn = redrawn(placements)
      if (!samePlacements(open?.placements ?? [], drawn)) {
        /* Spent only by a call that writes. The grid also reports a layout at
           the START of a gesture, when `maxH` changes as the press lands on a
           top corner, and that report changes nothing: clearing these then
           would lose what the hand has not yet said. */
        resized.current = null
        traded.current = new Map()
        change({ placements: drawn })
      }
    },
    [change, open?.placements],
  )


  /* The grid's own callbacks, spread onto it. */
  const gestures: {
    onDragStart: ItemCallback
    onDrag: ItemCallback
    onDragStop: ItemCallback
    onResizeStart: ItemCallback
    onResize: ItemCallback
    onResizeStop: ItemCallback
  } = {
    /* A container in motion moves by CSS transform, which resizes nothing and
       so tells a `ResizeObserver` nothing. Every move is therefore a
       measurement asked for explicitly, or the pages sit where the containers
       used to be and slide out from under them. `remeasure` is capped at
       once a frame, so a drag costs one measuring pass per painted frame
       and not one per mouse event. */
    onDragStart: (_all, _old, item) => {
      /* No agent arranges under a hand (`server/arranging.ts`). */
      if (openId !== null) reportArranging(openId, true)
      /* A move is not a resize; whatever a release that changed nothing
         left in `resized` must not be read as this gesture's. */
      resized.current = null
      setMoving(item.i)
    },
    onDrag: () => remeasure(),
    /* `settle`, not one more measurement, and the difference is the whole
       bug. A dropped container does not stay where it was dropped — the grid
       decides where it goes and then GLIDES it there. Measuring once on
       drop reads the spot the hand let go of, and the page is left
       standing there while its container slides away to the spot the grid
       chose. */
    onDragStop: () => {
      arrangedByHand()
      setMoving(null)
      /* The container let go of glides to where the grid puts it. */
      setGliding((n) => n + 1)
      settle()
    },
    onResizeStart: (_all, _old, item, _placeholder, event) => {
      if (openId !== null) reportArranging(openId, true)
      resized.current = item.i
      traded.current = new Map()
      setMoving(item.i)
      setPulling(cornerOf(event?.target)?.startsWith('n') ? item.i : null)
    },
    /*
     * The column pays for the growth, and it pays WHILE the handle is
     * moving rather than when it is let go.
     *
     * ## Why this can be done here at all
     *
     * Read `onResize` in `react-grid-layout/build/ReactGridLayout.js`: it
     * calls `this.props.onResize(finalLayout, …)` and then, on the very
     * next statement, runs `compact(finalLayout, …)` over the same array
     * and puts the result in its state. The items in that array are the
     * same objects it is about to compact. So a height written here is a
     * height the compaction sees, on this frame, and the neighbours give
     * up their rows as the pointer moves.
     *
     * This is a mutation of somebody else's array, which is not a thing
     * to do lightly, and the alternatives were each worse. The library's
     * answer to a collision is to PUSH — there is no configuration for
     * "take it from the thing below" — so a rule that ran anywhere else
     * would have to let the grid shove a column-mate off the bottom of
     * the canvas first and then correct it. Correcting it in
     * `onLayoutChange` means the correction lands on RELEASE, because
     * `getDerivedStateFromProps` returns `null` for the whole of an
     * `activeDrag`: the person would drag, watch the wrong thing happen,
     * let go, and see it snap. That is the edge discovered afterwards
     * instead of felt, which is the thing this was asked not to be.
     *
     * ## Computed from what is STORED, not from what the grid is holding
     *
     * `open?.placements` does not move during a gesture — the grid only
     * reports a layout change once the drag is over — so every frame of
     * this recomputes the same answer from the same base, and the result
     * is the same whether the pointer moved one pixel or forty. Feeding
     * it the grid's own in-flight layout would be feeding it a value this
     * function had already written, which is how a squeeze compounds into
     * a container that shrinks while you watch.
     *
     * ## What is asked each frame
     *
     * The in-flight height is this container's WISH for the duration of
     * the frame — or, at the folded height, its fold — and every other
     * container keeps the wish it has stored. `wishing` answers with what
     * every wish is granted, which is both directions at once: pulling
     * down squeezes the column below, and pulling back up lets it back
     * out towards its wishes as the pointer moves, rather than on
     * release. `maxH` below means `item.h` has already been clamped to
     * what the column can grant, so in practice the container is drawn
     * at what the hand asked; the map is applied to it anyway so that the
     * one rule decides, and the frame after a fold — when the two
     * disagree briefly — draws what the rule says.
     *
     * Nothing is written here. The wish and the fold land in
     * `onLayoutChange`, on release; this only draws.
     */
    onResize: (layout, _old, item) => {
      const stored = open?.placements ?? []
      const before = stored.find((p) => p.i === item.i)
      if (before && pulling === item.i) {
        /* A top corner: the bottom edge stays where it is and the
           container trades rows with what is on top of it. The grid
           swapped places with whatever the top edge ran into; this puts
           them back and gives each the rows it now has. */
        const pulled = topEdge(stored, item.i, item.h)
        traded.current = pulled.given
        for (const one of layout) {
          if (one.i === item.i) {
            one.h = pulled.h
            one.y = pulled.y
            continue
          }
          const height = pulled.given.get(one.i)
          const was = stored.find((p) => p.i === one.i)
          if (height !== undefined && was) {
            one.h = height
            one.y = was.y
          }
        }
        remeasure()
        return
      }
      const heights = before ? wishing(stored, item.i, dragged(before, item.h, twoRowsFor(item.i))) : granted(stored)
      for (const one of layout) {
        const height = heights.get(one.i)
        if (height !== undefined) one.h = height
      }
      remeasure()
    },
    onResizeStop: () => {
      arrangedByHand()
      setPulling(null)
      setMoving(null)
      setGliding((n) => n + 1)
      settle()
    },
  }

  /* A glide asked for from outside a gesture: a fold or an unfold, whoever made it. */
  const glide = useCallback(() => setGliding((n) => n + 1), [])

  return { moving, pulling, gliding, glide, onLayoutChange, onHeight, gestures }
}

/** Whether two arrangements draw the same: what a write is skipped on. */
export function samePlacements(a: readonly Placement[], b: readonly Placement[]): boolean {
  if (a.length !== b.length) return false
  return a.every((one, index) => {
    const other = b[index]
    return (
      other !== undefined &&
      one.i === other.i &&
      one.x === other.x &&
      one.y === other.y &&
      one.w === other.w &&
      one.h === other.h &&
      /* The two facts a drag can change besides the rectangle. A drag to the
         folded height changes `h` as well, so these are not strictly needed
         to notice it — but a comparison that ignored them would be one edit
         away from dropping a fold on the floor. */
      one.wish === other.wish &&
      one.collapsed === other.collapsed &&
      (one.tiled ?? false) === (other.tiled ?? false) &&
      (one.foldRows ?? 1) === (other.foldRows ?? 1)
    )
  })
}
