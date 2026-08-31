import { useCallback, useLayoutEffect, useRef, useState } from 'react'

import type { Rect } from '@/canvas/Frames.tsx'

/**
 * Where each container's body is, in the canvas's own coordinates.
 *
 * ## Why this is measured rather than calculated
 *
 * `react-grid-layout` positions its items with arithmetic anybody can repeat:
 * a column width from the container, a row height, two margins. Repeating it
 * here would give exact numbers with no DOM reads at all, and it was tempting.
 *
 * It is the wrong answer, because the number this needs is not where the ITEM
 * is — it is where the container's BODY is, which is the item minus a header, a
 * border and whatever rounding the card has. Calculating that means encoding
 * `Container.tsx`'s padding in a second file, and the day somebody makes the header
 * a pixel taller, every module on the canvas is a pixel out of place and
 * nothing in either file looks wrong. Measuring asks the browser where the
 * element actually ended up, and the answer stays right through any restyling.
 *
 * ## Coordinates
 *
 * Relative to the scroll container's content, not the viewport, because the
 * layer that uses these is inside that container and scrolls with it. Adding
 * the scroll offset back is what makes them agree: a viewport-relative number
 * would drift by exactly one scroll position the moment anybody scrolled.
 */
export function useRects(): {
  rects: Record<string, Rect>
  /** Give the surface — the scrolling element the layer sits inside. */
  surface: (element: HTMLElement | null) => void
  /** Give one container's body, or `null` when that container goes away. */
  body: (id: string) => (element: HTMLElement | null) => void
  /** Measure now, before the next paint. */
  measure: () => void
  /**
   * Measure on the next frame, at most once per frame.
   *
   * For things that move a container without resizing it — a drag, mainly. A grid
   * item being dragged is moved with a CSS transform, and a transform changes
   * nothing a `ResizeObserver` watches: the element is the same size, so
   * nothing fires, so the page stays where the container used to be while the container
   * slides out from under it. Compaction makes it worse than one stray container,
   * because dragging one container pushes the others and every one of them moves
   * without resizing too.
   */
  remeasure: () => void
  /**
   * Keep measuring for a moment, because the layout is still moving.
   *
   * For everything that ENDS a gesture rather than continuing one. Dropping a
   * container does not put it where it was dropped: the grid decides where it
   * actually goes, and then it glides there over about a fifth of a second, on
   * a CSS transition of `transform`. Containers that were pushed out of the way
   * glide too.
   *
   * A transform is invisible to a `ResizeObserver` — nothing resized — so
   * measuring once when the drag ends reads the position the container was dropped
   * at and never the one it settles into. The page then sits at the dropped
   * spot while its own container slides out from under it and stops somewhere else,
   * which is precisely the wrong half of "the module stayed where I put it".
   *
   * So this measures every frame for a window comfortably longer than the
   * animation, and then stops. A fixed window rather than a check for
   * stillness: the animation has a known, short duration, and a loop that ran
   * until nothing moved would be a loop that runs forever the first time
   * something on the canvas animates on its own.
   */
  settle: (ms?: number) => void
} {
  const [rects, setRects] = useState<Record<string, Rect>>({})
  const surfaceRef = useRef<HTMLElement | null>(null)
  const bodies = useRef(new Map<string, HTMLElement>())
  /* One observer for every container body and the surface itself. A container resized by
     anything at all — a drag, a window, a module asking to be taller — is a
     measurement, and there is no list of causes worth maintaining. */
  const observer = useRef<ResizeObserver | null>(null)
  const scheduled = useRef(false)

  const measure = useCallback(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const base = surface.getBoundingClientRect()

    const next: Record<string, Rect> = {}
    for (const [id, element] of bodies.current) {
      const box = element.getBoundingClientRect()
      next[id] = {
        x: Math.round(box.left - base.left + surface.scrollLeft),
        y: Math.round(box.top - base.top + surface.scrollTop),
        width: Math.round(box.width),
        height: Math.round(box.height),
      }
    }

    setRects((was) => (same(was, next) ? was : next))
  }, [])

  /* Coalesced to one measurement per frame. A drag fires a resize observation
     and a layout change and a mouse move for the same pixel; measuring three
     times reads the same numbers three times and forces layout doing it. */
  const soon = useCallback(() => {
    if (scheduled.current) return
    scheduled.current = true
    requestAnimationFrame(() => {
      scheduled.current = false
      measure()
    })
  }, [measure])

  const watcher = useCallback(() => {
    if (!observer.current) observer.current = new ResizeObserver(soon)
    return observer.current
  }, [soon])

  const surface = useCallback(
    (element: HTMLElement | null) => {
      if (surfaceRef.current) watcher().unobserve(surfaceRef.current)
      surfaceRef.current = element
      if (element) watcher().observe(element)
      soon()
    },
    [soon, watcher],
  )

  /* One callback per module, kept, because React reads a ref callback by
     identity: a fresh function every render is a detach and an attach every
     render, which here means unobserving and re-observing an element that never
     moved and measuring the canvas for nothing. */
  const callbacks = useRef(new Map<string, (element: HTMLElement | null) => void>())

  const body = useCallback(
    (id: string) => {
      const existing = callbacks.current.get(id)
      if (existing) return existing
      const made = (element: HTMLElement | null) => {
        const was = bodies.current.get(id)
        if (was) watcher().unobserve(was)
        if (element) {
          bodies.current.set(id, element)
          watcher().observe(element)
        } else {
          bodies.current.delete(id)
        }
        soon()
      }
      callbacks.current.set(id, made)
      return made
    },
    [soon, watcher],
  )

  useLayoutEffect(() => {
    const onScrollOrResize = () => soon()
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('resize', onScrollOrResize)
      observer.current?.disconnect()
      observer.current = null
    }
  }, [soon])

  /* When the current settle window ends, and whether a loop is already running.
     Two gestures in quick succession extend the window rather than starting a
     second loop measuring the same elements twice a frame. */
  const until = useRef(0)
  const settling = useRef(false)

  const settle = useCallback(
    /* Longer than react-grid-layout's own 200ms transition, with room for a
       frame or two on either side. Cheap: a few `getBoundingClientRect` calls
       per frame for a third of a second, once per gesture. */
    (ms = 400) => {
      until.current = performance.now() + ms
      if (settling.current) return
      settling.current = true
      const tick = () => {
        measure()
        if (performance.now() < until.current) requestAnimationFrame(tick)
        else settling.current = false
      }
      requestAnimationFrame(tick)
    },
    [measure],
  )

  return { rects, surface, body, measure, remeasure: soon, settle }
}

function same(a: Record<string, Rect>, b: Record<string, Rect>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => {
    const one = a[key]
    const other = b[key]
    return (
      one !== undefined &&
      other !== undefined &&
      one.x === other.x &&
      one.y === other.y &&
      one.width === other.width &&
      one.height === other.height
    )
  })
}
