import { ArrowLeft, ArrowRight, XIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.tsx'

/**
 * The introduction dialog: the one modal both the app's own introduction (`Intro.tsx`) and a
 * module's (protocol 2.57.0, `ModuleIntro.tsx`) are shown in — the same frame, controls and look.
 * The slides are a parameter, never content here.
 *
 * A row at the top with whose introduction it is (an icon and a name) and the ✕; the picture; the
 * title and words; then the dots, Skip or Back, and Next — or, on the last slide, `last`. `action`
 * is a button kept in the footer on EVERY slide (a module's "Add to this kehikko").
 *
 * Arrow keys move between slides. With `prefers-reduced-motion` the pictures stand still
 * (`data-motion="still"`, and the media query in `index.css`), every one drawn so that its still
 * frame says the same thing.
 */

export interface ModalSlide {
  id: string
  title: string
  body: string
  /** Drawn as a list under the body. */
  points?: readonly string[]
  art?: () => ReactNode
}

/** Does the person ask for less motion? Read on each open; a test stubs `matchMedia`. */
export function prefersStill(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function IntroModal({
  open,
  onOpenChange,
  slides,
  icon,
  name,
  closeLabel,
  last,
  action,
  label,
}: {
  open: boolean
  /** Closing in any way — Skip, ✕, Escape, or a last-slide button — is `false`. */
  onOpenChange(open: boolean): void
  slides: readonly ModalSlide[]
  /** Whose introduction it is, at the top. */
  icon: ReactNode
  name: string
  closeLabel: string
  /** The buttons on the last slide. Given `last` that renders nothing, the slide has none. */
  last(close: () => void): ReactNode
  /** A button in the footer on every slide, before the slide's own. */
  action?(lastSlide: boolean): ReactNode
  /** A name for the dialog itself, beside the slide's title. */
  label?: string
}) {
  const [at, setAt] = useState(0)
  const [still, setStill] = useState(false)
  useEffect(() => {
    if (!open) return
    setAt(0)
    setStill(prefersStill())
  }, [open])
  const count = Math.max(1, slides.length)
  const now = Math.min(at, count - 1)
  const slide = slides[now]
  const isLast = now === count - 1
  if (!slide) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showClose={false}
        className="max-w-[calc(100%-2rem)] gap-0 overflow-hidden p-0 sm:max-w-lg [&>*]:min-w-0"
        data-intro={slide.id}
        data-motion={still ? 'still' : 'moving'}
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' && !isLast) setAt(now + 1)
          if (event.key === 'ArrowLeft' && now > 0) setAt(now - 1)
        }}
      >
        {/* The close has this row to itself: the picture starts below it. */}
        <div className="flex h-11 items-center gap-2 pr-2 pl-4" data-intro-top="">
          {icon}
          <span className="text-muted-foreground min-w-0 truncate text-xs font-medium" data-intro-name="">
            {name}
          </span>
          <span className="flex-1" />
          <span className="text-muted-foreground text-[11px] tabular-nums" aria-hidden>
            {now + 1} / {count}
          </span>
          <DialogClose asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground size-7"
              aria-label={closeLabel}
              data-intro-close=""
            >
              <XIcon className="size-4" />
            </Button>
          </DialogClose>
        </div>

        {slide.art ? (
          <div className="px-4" data-intro-art="">
            {/* Keyed, so each slide's picture plays from its start. */}
            <div key={slide.id}>{slide.art()}</div>
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5 px-5 pt-4">
          <DialogTitle className={now === 0 ? 'text-lg [overflow-wrap:anywhere]' : '[overflow-wrap:anywhere]'}>{slide.title}</DialogTitle>
          {slide.body ? <DialogDescription className="[overflow-wrap:anywhere]">{slide.body}</DialogDescription> : null}
          {slide.points?.length ? (
            <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm leading-relaxed" data-intro-points="">
              {slide.points.map((point, i) => (
                <li key={i} className="[overflow-wrap:anywhere]">
                  {point}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 px-5 pt-4 pb-4">
          <div className="flex min-w-24 flex-1 items-center gap-1.5" role="group" aria-label={`slide ${now + 1} of ${count}`}>
            {slides.map((one, i) => (
              <button
                key={one.id}
                type="button"
                aria-label={one.title}
                aria-current={i === now ? 'step' : undefined}
                onClick={() => setAt(i)}
                data-intro-dot=""
                className={`h-1.5 rounded-full transition-all ${i === now ? 'bg-primary w-4' : 'bg-muted-foreground/30 hover:bg-muted-foreground/60 w-1.5'}`}
              />
            ))}
          </div>
          {action?.(isLast)}
          {isLast ? (
            last(() => onOpenChange(false))
          ) : (
            <>
              {now === 0 ? (
                <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} data-intro-skip="">
                  Skip
                </Button>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setAt(now - 1)} aria-label="back">
                  <ArrowLeft className="size-3.5" />
                  Back
                </Button>
              )}
              <Button size="sm" onClick={() => setAt(now + 1)} data-intro-next="">
                Next
                <ArrowRight className="size-3.5" />
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
