import { useLayoutEffect, type RefObject } from 'react'

/**
 * A page drawn while its wrapper was `visibility: hidden` is, in WebKit,
 * sometimes not repainted when the wrapper turns visible again: the frame
 * stays black until something scrolls. Every way the host un-hides a page
 * (leaving a loading cover, switching back to a kehikko, unfolding, leaving a
 * tile) is the same flip of `seen`, so the refresh is done there, for every
 * module, rather than in each one.
 *
 * The wrapper's opacity is dropped by a hair for two animation frames, which
 * makes the compositor re-raster the layer. Opacity changes no box, so there
 * is no layout shift and the page is not resized or reflowed. The page is
 * never made `display: none` and never moved. Nothing here touches focus: the
 * hidden state's `inert` and `pointer-events: none` are unchanged.
 */
export const REPAINT_OPACITY = '0.99'

type Frame = (run: () => void) => unknown

export function nudgeRepaint(el: Pick<HTMLElement, 'style'>, frame: Frame = (run) => requestAnimationFrame(run)): void {
  el.style.opacity = REPAINT_OPACITY
  frame(() => frame(() => {
    el.style.opacity = ''
  }))
}

/** Refresh the wrapper each time `seen` turns true (not on first mount). */
export function useRepaintOnUncover(ref: RefObject<HTMLElement | null>, seen: boolean): void {
  useLayoutEffect(() => {
    if (!seen || !ref.current) return
    nudgeRepaint(ref.current)
  }, [ref, seen])
}
