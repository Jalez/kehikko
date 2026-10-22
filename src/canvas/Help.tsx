import { CircleHelp, LayoutTemplate, Route, Sparkles } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { fetchOnboarding, openIntro, openLayouts, openTour, type Onboarding } from '@/host/onboarding.ts'
import { TOUR_STOPS } from '@/host/tour.ts'
import { Hint } from './Hint.tsx'

/**
 * The "?" in the bar: the introduction, the tour (resumed where it was left,
 * or from the start) and the suggested layouts, whenever they are wanted
 * again. Its own control, beside and apart from the Settings gear.
 */
export function HelpMenu({ read = fetchOnboarding }: { read?: () => Promise<Onboarding | null> }) {
  const [state, setState] = useState<Onboarding | null>(null)
  const leftAt = state?.tour.at ?? null
  const resumable = leftAt !== null && leftAt > 0 && leftAt < TOUR_STOPS.length

  return (
    <DropdownMenu onOpenChange={(open) => (open ? void read().then(setState) : undefined)}>
      <Hint label="Help — the introduction, a tour, suggested layouts">
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
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Help</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => openIntro()} data-help="intro">
          <Sparkles className="size-3.5" />
          Introduction
        </DropdownMenuItem>
        {resumable ? (
          <DropdownMenuItem onSelect={() => openTour('resume')} data-help="resume">
            <Route className="size-3.5" />
            Resume the tour
            <span className="text-muted-foreground ml-auto text-[11px] tabular-nums">
              {leftAt + 1}/{TOUR_STOPS.length}
            </span>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => openTour('over')} data-help="tour">
          <Route className="size-3.5" />
          {resumable ? 'Start the tour over' : 'Tour'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openLayouts('new')} data-help="layouts">
          <LayoutTemplate className="size-3.5" />
          New kehikko from a layout…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
