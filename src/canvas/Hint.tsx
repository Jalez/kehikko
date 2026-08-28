import type { ReactElement, ReactNode } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'

/**
 * A label for a control that has no room for one.
 *
 * ## Why every control on this host has one
 *
 * The strip is thirty-two pixels tall and its controls are mostly icons,
 * because the design intent is that the host is almost absent while somebody is
 * working inside a module. An icon with no label is the cost of that, and it is
 * a real cost: a plus sign in a corner is a guess, and a person who guesses
 * wrong on a button that makes something has to undo it.
 *
 * The `title` attribute was doing this job and doing it badly. It appears after
 * a delay the person cannot change, it is styled by the operating system rather
 * than the page, it is invisible to touch entirely, and — the part that matters
 * — it does not appear on keyboard focus, so the one group of people who most
 * need the label are the ones who never see it. Radix's tooltip opens on focus
 * as well as hover, and it is the same component everywhere.
 *
 * The trigger is `asChild`, so this wraps a control rather than replacing it,
 * and the control keeps its own `aria-label`. The tooltip is not the accessible
 * name: a tooltip that has to be hovered to be read is not a name a screen
 * reader can rely on, and the two say the same thing anyway.
 */
export function Hint({
  children,
  side = 'bottom',
  align = 'center',
  label,
}: {
  children: ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  label: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} align={align}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
