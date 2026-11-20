import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { STEPS, crowded, fitFor, stepDown, type HeaderFit } from '@/host/headerFit.ts'

/**
 * A container's header width, kept as the container is resized, and what its
 * left side has room for at it (`host/headerFit.ts`): what the width allows,
 * less the steps taken because the name was crowded. Steps are taken in a
 * layout effect, so none is ever painted.
 *
 * `content` is what is drawn on the left — the words, the version and the
 * source — and a change to it starts from the most again, as a change of
 * width does. `grip` goes on the header.
 */
export function useContainerResize(content: string): { grip: RefObject<HTMLElement | null>; width: number | null; fit: HeaderFit } {
  const grip = useRef<HTMLElement>(null)
  const [width, setWidth] = useState<number | null>(null)
  const [steps, setSteps] = useState(0)
  useLayoutEffect(() => {
    const header = grip.current
    if (!header) return
    const measure = () => setWidth((was) => (header.offsetWidth || null) === was ? was : header.offsetWidth || null)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const watching = new ResizeObserver(measure)
    watching.observe(header)
    return () => watching.disconnect()
  }, [])
  const fit = stepDown(fitFor(width), steps)
  /* What is drawn changes with the words, the width and the source: start from the most again. */
  useLayoutEffect(() => setSteps(0), [width, content])
  useLayoutEffect(() => {
    const label = grip.current?.querySelector<HTMLElement>('[data-testid="header-name"]')
    if (label && steps < STEPS && crowded(label.clientWidth, label.scrollWidth)) setSteps(steps + 1)
  }, [steps, width, content])
  return { grip, width, fit }
}
