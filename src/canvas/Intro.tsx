import { ArrowLeft, ArrowRight, LayoutTemplate, Route } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.tsx'

/**
 * The introduction: what Kehikot is made of, one idea a step, each with a
 * small schematic drawn in the theme's own colours (no images — nothing to
 * load, and it is right in dark as in light).
 *
 * Opened by itself once (`introDue` in `src/host/onboarding.ts`), and again
 * from the "?" menu. Closing it any way — Skip, the ✕, Escape or the last
 * step — counts as seen. The last step offers the tour and the suggested
 * layouts.
 */

/** A schematic's frame: a rounded panel in the muted colour, the drawing inside it. */
function Picture({ children, label }: { children: ReactNode; label: string }) {
  return (
    <svg viewBox="0 0 240 120" className="bg-muted/40 h-32 w-full rounded-md border" role="img" aria-label={label} data-intro-picture="">
      {children}
    </svg>
  )
}

const box = 'fill-card stroke-border'
const strong = 'fill-primary/20 stroke-primary'
const line = 'fill-muted-foreground/40'

export interface IntroStep {
  id: string
  title: string
  body: string
  picture: ReactNode
}

export const INTRO_STEPS: readonly IntroStep[] = [
  {
    id: 'project',
    title: 'A project is a folder',
    body: 'Open a folder you work in — a repository, a paper, a thesis. Kehikot keeps what it knows about it in the folder’s own .kehikot/, so it goes wherever the folder goes.',
    picture: (
      <Picture label="a folder holding a .kehikot folder">
        <path d="M60 30 h40 l8 8 h72 a6 6 0 0 1 6 6 v52 a6 6 0 0 1 -6 6 H60 a6 6 0 0 1 -6 -6 V36 a6 6 0 0 1 6 -6 z" className={box} strokeWidth="1.5" />
        <rect x="74" y="54" width="44" height="10" rx="2" className={strong} strokeWidth="1" />
        <rect x="74" y="70" width="70" height="6" rx="2" className={line} />
        <rect x="74" y="82" width="56" height="6" rx="2" className={line} />
      </Picture>
    ),
  },
  {
    id: 'epics',
    title: 'Epics, and their parts',
    body: 'An epic is one piece of work in the project. Pick it in the bar, or All epics. An epic can be divided into parts; pick one or a few and every module narrows to them.',
    picture: (
      <Picture label="an epic divided into three parts, one picked">
        <rect x="30" y="22" width="180" height="20" rx="4" className={box} strokeWidth="1.5" />
        <rect x="38" y="29" width="70" height="6" rx="2" className="fill-foreground/60" />
        {[0, 1, 2].map((i) => (
          <g key={i}>
            <rect x={30 + i * 62} y="58" width="54" height="38" rx="4" className={i === 1 ? strong : box} strokeWidth="1.5" />
            <rect x={38 + i * 62} y="66" width="30" height="5" rx="2" className={line} />
          </g>
        ))}
        <path d="M120 42 v12" className="stroke-muted-foreground/60" strokeWidth="1.5" />
      </Picture>
    ),
  },
  {
    id: 'kehikko',
    title: 'A kehikko holds containers',
    body: 'A kehikko is one arrangement of modules side by side — one for writing, one for review. Each module sits in a container: drag it by its header, resize it from any corner, fold it to its header.',
    picture: (
      <Picture label="a kehikko with three containers">
        <rect x="16" y="14" width="208" height="92" rx="5" className="fill-background stroke-border" strokeWidth="1.5" />
        {[
          [22, 20, 82, 80],
          [108, 20, 110, 38],
          [108, 62, 110, 38],
        ].map(([x, y, w, h], i) => (
          <g key={i}>
            <rect x={x} y={y} width={w} height={h} rx="4" className={box} strokeWidth="1.5" />
            <rect x={x} y={y} width={w} height="9" rx="4" className={i === 0 ? 'fill-primary/30' : 'fill-muted-foreground/25'} />
          </g>
        ))}
        <path d="M212 96 l6 0 l0 -6" className="stroke-primary fill-none" strokeWidth="2" />
      </Picture>
    ),
  },
  {
    id: 'inbox',
    title: 'The Inbox',
    body: 'When a module needs you, is working, or has finished, it says so in the Inbox in the bar. Alt+Shift+N jumps to the next thing that needs you.',
    picture: (
      <Picture label="an inbox with three rows">
        <rect x="56" y="18" width="128" height="86" rx="5" className={box} strokeWidth="1.5" />
        {[0, 1, 2].map((i) => (
          <g key={i}>
            <circle cx="72" cy={38 + i * 24} r="4" className={i === 0 ? 'fill-amber-500' : i === 1 ? 'fill-sky-500' : 'fill-emerald-500'} />
            <rect x="84" y={34 + i * 24} width={i === 0 ? 80 : 64} height="7" rx="2" className={line} />
          </g>
        ))}
      </Picture>
    ),
  },
  {
    id: 'settings',
    title: 'Settings and Updates',
    body: 'The gear opens Settings: how Kehikot works with your agents. Updates says when Kehikot or a module has a new release, and what is new in it.',
    picture: (
      <Picture label="a gear beside an update arrow">
        <g transform="translate(88 60)">
          <circle r="22" className={box} strokeWidth="1.5" />
          <circle r="8" className={strong} strokeWidth="1.5" />
          {Array.from({ length: 8 }, (_, i) => (
            <rect key={i} x="-3" y="-30" width="6" height="9" rx="1.5" className="fill-border" transform={`rotate(${i * 45})`} />
          ))}
        </g>
        <g transform="translate(160 60)">
          <circle r="22" className={box} strokeWidth="1.5" />
          <path d="M0 -11 v20 M-8 2 l8 8 l8 -8" className="stroke-primary fill-none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      </Picture>
    ),
  },
]

export function IntroDialog({
  open,
  onOpenChange,
  onTour,
  onLayouts,
}: {
  open: boolean
  /** Closing in any way — Skip, ✕, Escape, or one of the last step's buttons — is `false`. */
  onOpenChange(open: boolean): void
  onTour(): void
  onLayouts(): void
}) {
  /* One past the steps is the last page: what to do next. */
  const [at, setAt] = useState(0)
  useEffect(() => {
    if (open) setAt(0)
  }, [open])
  const last = at >= INTRO_STEPS.length
  const step = INTRO_STEPS[at]
  const pages = INTRO_STEPS.length + 1

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md gap-4"
        data-intro={last ? 'last' : step!.id}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' && !last) setAt((n) => n + 1)
          if (event.key === 'ArrowLeft' && at > 0) setAt((n) => n - 1)
        }}
      >
        {last ? (
          <>
            <Picture label="the bar above a kehikko">
              <rect x="16" y="14" width="208" height="14" rx="4" className={box} strokeWidth="1.5" />
              {[0, 1, 2].map((i) => (
                <rect key={i} x={24 + i * 40} y="18" width="32" height="6" rx="2" className={i === 0 ? 'fill-primary/50' : line} />
              ))}
              <rect x="16" y="34" width="100" height="72" rx="4" className={box} strokeWidth="1.5" />
              <rect x="122" y="34" width="102" height="34" rx="4" className={box} strokeWidth="1.5" />
              <rect x="122" y="72" width="102" height="34" rx="4" className={box} strokeWidth="1.5" />
            </Picture>
            <div className="flex flex-col gap-1.5">
              <DialogTitle>Ready</DialogTitle>
              <DialogDescription>
                Take a short tour of the bar and a container, or start from a suggested layout. Both are in the ? menu
                whenever you want them again.
              </DialogDescription>
            </div>
          </>
        ) : (
          <>
            {step!.picture}
            <div className="flex flex-col gap-1.5">
              <DialogTitle>{step!.title}</DialogTitle>
              <DialogDescription>{step!.body}</DialogDescription>
            </div>
          </>
        )}

        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center gap-1.5" role="group" aria-label={`step ${at + 1} of ${pages}`}>
            {Array.from({ length: pages }, (_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`step ${i + 1}`}
                aria-current={i === at ? 'step' : undefined}
                onClick={() => setAt(i)}
                data-intro-dot=""
                className={`h-1.5 rounded-full transition-all ${i === at ? 'bg-primary w-4' : 'bg-muted-foreground/30 hover:bg-muted-foreground/60 w-1.5'}`}
              />
            ))}
          </div>
          {last ? (
            <>
              <Button
                variant="outline"
                size="sm"
                data-intro-layouts=""
                onClick={() => {
                  onOpenChange(false)
                  onLayouts()
                }}
              >
                <LayoutTemplate className="size-3.5" />
                Start with a suggested layout
              </Button>
              <Button
                size="sm"
                data-intro-tour=""
                onClick={() => {
                  onOpenChange(false)
                  onTour()
                }}
              >
                <Route className="size-3.5" />
                Take the tour
              </Button>
            </>
          ) : (
            <>
              {at === 0 ? (
                <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} data-intro-skip="">
                  Skip
                </Button>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setAt((n) => n - 1)} aria-label="back">
                  <ArrowLeft className="size-3.5" />
                  Back
                </Button>
              )}
              <Button size="sm" onClick={() => setAt((n) => n + 1)} data-intro-next="">
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
