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
 *
 * ## `disableHoverableContent`, and the tooltip that would not go away
 *
 * The one non-default on this component, and it is a bug fix rather than a
 * preference. In focus mode a container's header is revealed by hovering the
 * top of the container and hidden again when the pointer leaves — see the
 * essay in `index.css`. A tooltip opened on one of those header controls used
 * to stay on screen after the header had faded out from under it: a floating
 * sentence over the canvas, anchored to something invisible, with nothing to
 * press to dismiss it. That is what the person who owns this host reported.
 *
 * The obvious explanation is wrong, and it is worth writing down because it is
 * the one anybody would reach for. The header is not unmounted — it is faded
 * with `opacity: 0` and taken out of hit-testing with `pointer-events: none`
 * — so the natural guess is that the trigger never received a `pointerleave`.
 * It does. Instrumenting the button (`dev/tooltips.mjs` grew out of this)
 * shows `pointerout` and `pointerleave` both arriving on the way out, and the
 * tooltip staying open for as long as you like afterwards.
 *
 * What keeps it open is Radix's hoverable content. By default a tooltip may be
 * hovered — so that you can select the text in it, or reach a link — and to
 * make that possible Radix does not close on `pointerleave`. It installs a
 * grace-area polygon spanning the gap between the trigger and the content, and
 * dismisses on the first subsequent `pointermove` that lands outside it. The
 * dismissal is therefore owed to a FUTURE pointer event.
 *
 * On this canvas that event frequently never comes. The thing immediately
 * below a container's header is the module's own page, in an iframe on another
 * origin, and a document receives no pointer events at all once the pointer is
 * inside one — the same fact that makes `moving` necessary in `Frames.tsx`.
 * So the person moves off the header into the module they were reading, the
 * header fades, the grace area is never re-evaluated, and the label is stranded
 * on screen until something unrelated happens to move the pointer over the host
 * again. It is not a focus-mode bug so much as a bug focus mode makes constant:
 * with headers drawn, the tooltip is at least still attached to something you
 * can see.
 *
 * `disableHoverableContent` closes on `pointerleave` and owes nothing to a
 * later event. What it costs is the ability to hover into the tooltip, and
 * these tooltips are one short phrase naming an icon — there is nothing in one
 * to reach for, no link and nothing worth selecting.
 *
 * It is deliberately set here, on the Tooltip itself, rather than on a
 * provider: this component is what every control on the canvas and in the strip
 * goes through, so setting it here covers all of them, and a provider somewhere
 * up the tree would be a rule enforced at a distance from the only file that
 * has the argument for it.
 *
 * The keyboard path is untouched by this and was never broken — `:focus-within`
 * reveals the header too, and focus and blur are events the trigger receives
 * directly whatever the pointer is doing. `dev/tooltips.mjs` measures all four
 * cases, including the two that would be zero if a fix had simply stopped the
 * tooltips opening at all.
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
    <Tooltip disableHoverableContent>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} align={align}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
