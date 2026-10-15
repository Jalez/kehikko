import type { ActivityState } from 'kehikot-module-protocol'

import { cn } from '@/lib/utils'
import { markWords } from '@/host/activity.ts'

/**
 * What the modules are doing, drawn as small dots on what already exists —
 * the container's header, an epic's row, a part's row, a kehikko's row — and
 * as ONE control in the bar that opens the Inbox (`Inbox.tsx`). No standing
 * row anywhere; see `host/activity.ts` and `host/inbox.ts`.
 *
 * Yellow is "needs you", green is "finished and not yet seen", grey is
 * "working". A working dot pulses only where the person has not asked for
 * less motion (`motion-safe:`); otherwise it is a still ring. Colour is never
 * the only sign: each dot says its state in words, to assistive technology
 * and in its tooltip.
 */
const LOOK: Record<ActivityState, string> = {
  attention: 'bg-amber-500 dark:bg-amber-400',
  done: 'bg-emerald-500 dark:bg-emerald-400',
  /* A filled grey that breathes where motion is welcome, and a hollow ring
     where it is not. */
  working:
    'bg-neutral-500 dark:bg-neutral-400 motion-safe:animate-pulse motion-reduce:bg-transparent dark:motion-reduce:bg-transparent motion-reduce:ring-[1.5px] motion-reduce:ring-inset motion-reduce:ring-neutral-500 dark:motion-reduce:ring-neutral-400',
}

/** The classes a state's dot carries; exported for a test of the reduced-motion rule. */
export const dotClasses = (state: ActivityState): string => LOOK[state]

export function ActivityDot({
  state,
  what,
  className,
}: {
  state: ActivityState
  /** What it is about, put before the state's words in the tooltip. */
  what?: string
  className?: string
}) {
  const words = markWords(state, what)
  return (
    <span
      role="img"
      title={words}
      aria-label={words}
      data-activity={state}
      className={cn('inline-block size-1.5 shrink-0 rounded-full', LOOK[state], className)}
    />
  )
}
