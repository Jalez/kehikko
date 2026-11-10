import { CircleHelp, MessageSquare, Newspaper, Play, RotateCcw } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { APP_HELP_HINT, HELP_SAID, HELP_TITLE, TOUR_SAID } from '@/host/helpMenu.ts'
import { continuable, fetchOnboarding, openIntro, openTour, type Onboarding } from '@/host/onboarding.ts'
import { TOUR_STEPS } from '@/host/tour.ts'
import { openWhatsNew } from '@/host/whatsNew.ts'
import { FeedbackDialog, FeedbackRows, useFeedback } from './Feedback.tsx'
import { Hint } from './Hint.tsx'
import { KehikkoMark } from './Mark.tsx'

/**
 * The "?" in the bar: help with Kehikot itself, whenever it is wanted. Every container has the same
 * menu for its module (`ContainerHelpMenu` in `HeaderMenus.tsx`), with the same icon, title, order
 * and words (`host/helpMenu.ts`): Introduction…, then the tour where a module has "How to use…",
 * then What's new…, then Feedback.
 *
 * "Continue tour" is here only while the tour is paused, and picks it up at the step it was paused
 * on; "Restart tour" starts it from the first thing not yet done. Its own control, beside and apart
 * from the Settings gear. Layouts are not here: they are the kehikko menu's (new kehikko…).
 * Feedback is filed in the host's own repository (`server/feedback.ts`), as a container's is filed
 * in its module's.
 */
export function HelpMenu({
  read = fetchOnboarding,
  kehikko = null,
  epic = null,
}: {
  read?: (signal?: AbortSignal, fresh?: boolean) => Promise<Onboarding | null>
  /** The open kehikko's name and epic slug, for the line under an issue filed from here. */
  kehikko?: string | null
  epic?: string | null
}) {
  const [state, setState] = useState<Onboarding | null>(null)
  const feedback = useFeedback('host')
  const paused = continuable(state)
  const at = TOUR_STEPS.findIndex((step) => step.id === state?.tour.step)
  const started = state !== null && (state.tour.step !== null || state.tour.finished || state.tour.paused)

  return (
    <>
      <DropdownMenu onOpenChange={(open) => (open ? void read(undefined, true).then(setState) : undefined)}>
        <Hint label={APP_HELP_HINT}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={HELP_TITLE}
              data-tour="help"
              className="text-muted-foreground hover:text-foreground size-6"
            >
              <CircleHelp className="size-3" />
            </Button>
          </DropdownMenuTrigger>
        </Hint>
        <DropdownMenuContent align="end" className="w-56" data-help-menu="">
          <DropdownMenuLabel>{HELP_TITLE}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => openIntro()} data-help="intro">
            <KehikkoMark working={false} className="size-3.5" />
            {HELP_SAID.intro}
          </DropdownMenuItem>
          {paused ? (
            <DropdownMenuItem onSelect={() => openTour('resume')} data-help="continue">
              <Play className="size-3.5" />
              {TOUR_SAID.resume}
              {at >= 0 ? (
                <span className="text-muted-foreground ml-auto text-[11px] tabular-nums">
                  {at + 1}/{TOUR_STEPS.length}
                </span>
              ) : null}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => openTour('over')} data-help="restart">
            <RotateCcw className="size-3.5" />
            {started ? TOUR_SAID.restart : TOUR_SAID.take}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openWhatsNew()} data-help="notes">
            <Newspaper className="size-3.5" />
            {HELP_SAID.notes}
          </DropdownMenuItem>
          <DropdownMenuSub onOpenChange={feedback.opened}>
            <DropdownMenuSubTrigger data-help="feedback">
              <MessageSquare className="size-3.5" />
              {HELP_SAID.feedback}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-72 max-w-[calc(100vw-1rem)]">
              <FeedbackRows feedback={feedback} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
      <FeedbackDialog feedback={feedback} module="host" name="Kehikot" kehikko={kehikko} epic={epic} />
    </>
  )
}
