import { Minimize2 } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { EXPANDED_SHARE, SHRINK_WORD } from '@/host/expand.ts'
import { ModuleIcon } from './ModuleIcon.tsx'
import { FindBar } from './FindBar.tsx'
import type { FindControls } from './Container.tsx'

/**
 * The large panel a container is shown in while it is expanded (`host/expand.ts`): a dimmed canvas
 * behind, and a panel taking most of what the canvas shows, with the module's icon, its name and
 * "Shrink back" along the top. The panel's body is HOLLOW: the module's own page is laid over it by
 * the frames layer, measured under `EXPANDED_BODY` like any container's body, so the page is the
 * same document it was in its square. A press on the dimmed canvas puts it back.
 *
 * Anchored to what the canvas shows now, in the canvas's own coordinates, and moved with it when the
 * canvas scrolls (`onMoved` measures the page again: a move resizes nothing an observer sees).
 */
export function Expanded({
  id,
  name,
  icon,
  body,
  onShrink,
  onMoved,
  find = null,
}: {
  /** The find bar over the page (protocol 2.69.0), drawn here while the container is shown large. */
  find?: FindControls | null
  id: string
  name: string
  icon?: string | null
  /** The body's ref, from `useRects().body(EXPANDED_BODY)`. */
  body: (element: HTMLElement | null) => void
  onShrink(): void
  onMoved(): void
}) {
  const panel = useRef<HTMLDivElement | null>(null)
  const shrink = useRef<HTMLButtonElement | null>(null)
  const [box, setBox] = useState<{ top: number; left: number; width: number; height: number } | null>(null)
  const moved = useRef(onMoved)
  moved.current = onMoved

  useLayoutEffect(() => {
    const surface = panel.current?.parentElement
    if (!surface) return
    const place = () => {
      const width = surface.clientWidth
      const height = surface.clientHeight
      const next = {
        top: Math.round(surface.scrollTop + (height * (1 - EXPANDED_SHARE)) / 2),
        left: Math.round(surface.scrollLeft + (width * (1 - EXPANDED_SHARE)) / 2),
        width: Math.round(width * EXPANDED_SHARE),
        height: Math.round(height * EXPANDED_SHARE),
      }
      setBox((was) => (was && was.top === next.top && was.left === next.left && was.width === next.width && was.height === next.height ? was : next))
      moved.current()
    }
    place()
    surface.addEventListener('scroll', place, { passive: true })
    window.addEventListener('resize', place)
    return () => {
      surface.removeEventListener('scroll', place)
      window.removeEventListener('resize', place)
    }
  }, [])

  /* The keyboard to "Shrink back" once the panel is up, unless the person is already in the page. */
  useLayoutEffect(() => {
    if (!box) return
    const active = document.activeElement
    if (!active || active === document.body) shrink.current?.focus({ preventScroll: true })
  }, [box !== null])

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/40" data-expanded-backdrop={id} aria-hidden onClick={onShrink} />
      <div
        ref={panel}
        role="dialog"
        aria-label={`${name}, shown large`}
        data-expanded={id}
        className="bg-card absolute z-40 flex flex-col overflow-hidden rounded-lg border shadow-2xl"
        style={box ? { top: box.top, left: box.left, width: box.width, height: box.height } : { visibility: 'hidden' }}
      >
        <header className="flex h-8 shrink-0 items-center gap-2 border-b px-2.5 select-none">
          <ModuleIcon id={id} icon={icon} name={name} />
          <span className="min-w-0 flex-1 truncate text-xs font-medium" title={name}>
            {name}
          </span>
          <Button ref={shrink} variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" title={`${SHRINK_WORD} to its place on the kehikko (Esc)`} onClick={onShrink} data-shrink>
            <Minimize2 className="size-3.5" aria-hidden />
            {SHRINK_WORD}
          </Button>
        </header>
        <div ref={body} className="pointer-events-none relative min-h-0 flex-1" data-expanded-body>
          {find?.bar.open ? (
            <FindBar bar={find.bar} name={name} width={box?.width ?? null} mac={find.mac} onQuery={find.onQuery} onCase={find.onCase} onStep={find.onStep} onClose={find.onClose} />
          ) : null}
        </div>
      </div>
    </>
  )
}
