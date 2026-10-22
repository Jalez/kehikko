import { CircleHelp, Play, RotateCcw, Sparkles } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { continuable, fetchOnboarding, openIntro, openTour, type Onboarding } from '@/host/onboarding.ts'
import { TOUR_STEPS } from '@/host/tour.ts'
import { Hint } from './Hint.tsx'

/**
 * The "?" in the bar: the introduction and the tour, whenever they are wanted
 * again. "Continue tour" is here only while the tour is paused, and picks it
 * up at the step it was paused on; "Restart tour" starts it from the first
 * thing not yet done. Its own control, beside and apart from the Settings
 * gear. Layouts are not here: they are the kehikko menu's (new kehikko…).
 */
export function HelpMenu({ read = fetchOnboarding }: { read?: () => Promise<Onboarding | null> }) {
  const [state, setState] = useState<Onboarding | null>(null)
  const paused = continuable(state)
  const at = TOUR_STEPS.findIndex((step) => step.id === state?.tour.step)
  const started = state !== null && (state.tour.step !== null || state.tour.finished || state.tour.paused)

  return (
    <DropdownMenu onOpenChange={(open) => (open ? void read().then(setState) : undefined)}>
      <Hint label="Help — the introduction and the tour">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Help"
            data-tour="help"
            className="text-muted-foreground hover:text-foreground size-6"
          >
            <CircleHelp className="size-3" />
          </Button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="w-56" data-help-menu="">
        <DropdownMenuLabel>Help</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => openIntro()} data-help="intro">
          <Sparkles className="size-3.5" />
          Introduction
        </DropdownMenuItem>
        {paused ? (
          <DropdownMenuItem onSelect={() => openTour('resume')} data-help="continue">
            <Play className="size-3.5" />
            Continue tour
            {at >= 0 ? (
              <span className="text-muted-foreground ml-auto text-[11px] tabular-nums">
                {at + 1}/{TOUR_STEPS.length}
              </span>
            ) : null}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => openTour('over')} data-help="restart">
          <RotateCcw className="size-3.5" />
          {started ? 'Restart tour' : 'Take the tour'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
