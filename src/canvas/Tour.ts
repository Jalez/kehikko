import { driver, type Driver } from 'driver.js'

import { resolveStop, startIndex, stopsOnScreen, TOUR_CLASS, TOUR_STOPS } from '@/host/tour.ts'

/**
 * The guided tour, drawn by driver.js (MIT, framework-free, ~25 kB; pinned
 * exactly in `package.json`). Chosen over React-specific tour libraries
 * because it owns nothing of the page: it highlights elements by reference,
 * draws one popover, and is themed entirely from CSS — `.kehikot-tour` in
 * `index.css` dresses it in the app's own tokens (popover, border, radius,
 * font), so it is right in light and dark without a second palette.
 *
 * The stops and the rule for which are shown are `src/host/tour.ts`. Arrow
 * keys move, Escape (or ✕) leaves; leaving records the stop for "Resume
 * tour", and the last stop's Done records it finished.
 */

export interface TourRun {
  /** Where to start: from the beginning, or a stop (index into `TOUR_STOPS`) the person left at. */
  leftAt: number | null
  /** Each stop shown, as its index into `TOUR_STOPS` — to resume from. */
  onAt(at: number): void
  /** The tour closed: `finished` when the last stop's Done was pressed, else at the stop it was left. */
  onEnd(finished: boolean, at: number | null): void
}

/** Start the tour over what is on screen now. Null when nothing it points at is drawn. */
export function runTour({ leftAt, onAt, onEnd }: TourRun, root: Document = document): Driver | null {
  const shown = stopsOnScreen(root)
  if (shown.length === 0) return null
  const reduced = root.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  let finished = false
  let at: number | null = null

  const tour = driver({
    popoverClass: TOUR_CLASS,
    animate: !reduced,
    smoothScroll: !reduced,
    allowClose: true,
    allowKeyboardControl: true,
    showProgress: true,
    progressText: '{{current}} of {{total}}',
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Done',
    closeBtnLabel: 'Leave the tour',
    overlayColor: 'black',
    overlayOpacity: 0.45,
    stagePadding: 4,
    stageRadius: 8,
    /* The person is being shown the controls, not using them: a press on
       the highlighted one would open a menu under the popover. */
    disableActiveInteraction: true,
    steps: shown.map(({ stop, element }) => ({
      /* Found again when the stop is reached: a header re-rendered since is
         still the header. */
      element: () => resolveStop(stop, root) ?? element,
      data: { stop: stop.id },
      popover: { title: stop.title, description: stop.body, side: stop.side, align: stop.align },
      onHighlighted: () => {
        at = TOUR_STOPS.indexOf(stop)
        onAt(at)
      },
    })),
    onDoneClick: () => {
      finished = true
      tour.destroy()
    },
    onDestroyed: () => onEnd(finished, finished ? null : at),
  })
  tour.drive(startIndex(shown, leftAt))
  return tour
}
