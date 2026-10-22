/**
 * The guided tour's stops: what each points at and what it says.
 *
 * Each stop names the element by selectors, in order of preference; the
 * first that matches an element on screen is the one shown, and a stop with
 * none on screen is left out of this run (no Inbox while nothing is held, no
 * container on an empty kehikko). `data-tour` attributes are put on the bar's
 * controls for this; a container's parts are found by the attributes they
 * already carry.
 *
 * Drawn by driver.js (`src/canvas/Tour.ts`); this file is what to test.
 */

export interface TourStop {
  id: string
  selectors: readonly string[]
  title: string
  body: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
}

export const TOUR_STOPS: readonly TourStop[] = [
  {
    id: 'project',
    selectors: ['[data-tour="project"]'],
    title: 'The project',
    body: 'The folder you are working in. Switch projects, add one, or say whether its .kehikot/ is committed with it.',
    side: 'bottom',
    align: 'start',
  },
  {
    id: 'epic',
    selectors: ['[data-tour="epic"]'],
    title: 'The epic',
    body: 'The piece of work every module is about. Pick one, make one, or pick All epics to see the whole project.',
    side: 'bottom',
    align: 'start',
  },
  {
    id: 'parts',
    selectors: ['[data-tour="parts"]'],
    title: 'Its parts',
    body: 'Pick one or a few parts of the epic and every module narrows to them. This is also where parts are made and renamed.',
    side: 'bottom',
    align: 'start',
  },
  {
    id: 'kehikko',
    selectors: ['[data-tour="kehikko"]'],
    title: 'The kehikko',
    body: 'One arrangement of modules. Make another for another kind of work — from a suggested layout — or save this one as a layout.',
    side: 'bottom',
    align: 'start',
  },
  {
    id: 'header',
    selectors: ['[data-module] header.container-grip'],
    title: 'A container’s header',
    body: 'Drag a container by its header. Tick the box to point an agent at it; fold it down to its header with the chevron.',
    side: 'bottom',
    align: 'start',
  },
  {
    id: 'frame',
    selectors: ['[data-module] [data-menu="frame"]'],
    title: 'The Frame menu',
    body: 'Everything about the container itself: its version, its tools for agents, its skills, refreshing, feedback.',
    side: 'bottom',
    align: 'end',
  },
  {
    id: 'menus',
    selectors: ['[data-module] [data-header-menus]'],
    title: 'The module’s own menus',
    body: 'View, Run and the rest are the module’s: switch what it shows, run what it offers.',
    side: 'bottom',
    align: 'end',
  },
  {
    id: 'corners',
    selectors: ['.react-grid-item:has([data-module])'],
    title: 'Resize from any corner',
    body: 'Every corner of a container is a handle. Neighbours make room, and get it back when you fold or shrink it.',
    side: 'right',
    align: 'start',
  },
  {
    id: 'inbox',
    selectors: ['[data-inbox-control]'],
    title: 'The Inbox',
    body: 'What modules need from you, are doing, and have finished. Alt+Shift+N goes to the next thing that needs you.',
    side: 'bottom',
    align: 'end',
  },
  {
    id: 'updates',
    selectors: ['[data-tour="updates"]'],
    title: 'Updates',
    body: 'Whether Kehikot and its modules have new releases, and what is new in them.',
    side: 'bottom',
    align: 'end',
  },
  {
    id: 'settings',
    selectors: ['[data-tour="settings"]', 'button[aria-label="Settings"]'],
    title: 'Settings',
    body: 'How Kehikot works with your agents. ⌘, (Ctrl+, elsewhere) opens it from anywhere.',
    side: 'bottom',
    align: 'end',
  },
  {
    id: 'help',
    selectors: ['[data-tour="help"]'],
    title: 'Help is here',
    body: 'The introduction, this tour and the suggested layouts are in this menu whenever you want them again.',
    side: 'bottom',
    align: 'end',
  },
]

/**
 * Is this element drawn: not hidden, and — where there is layout — with a
 * size. `layout: false` is for a DOM that measures nothing (a test).
 */
export function onScreen(element: Element | null, layout = true): element is HTMLElement {
  if (!element || typeof (element as HTMLElement).getBoundingClientRect !== 'function') return false
  if (element.closest('[hidden], [aria-hidden="true"]')) return false
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false
  if (!layout) return true
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

/** The element a stop points at now, or null when none of its selectors finds one on screen. */
export function resolveStop(stop: TourStop, root: ParentNode = document, layout = true): HTMLElement | null {
  for (const selector of stop.selectors) {
    let found: NodeListOf<Element>
    try {
      found = root.querySelectorAll(selector)
    } catch {
      /* A selector this engine does not know (`:has` in an old one). */
      continue
    }
    for (const element of found) if (onScreen(element, layout)) return element as HTMLElement
  }
  return null
}

/** The stops this run will show, with their elements, in order. */
export function stopsOnScreen(
  root: ParentNode = document,
  { stops = TOUR_STOPS, layout = true }: { stops?: readonly TourStop[]; layout?: boolean } = {},
): Array<{ stop: TourStop; element: HTMLElement }> {
  const out: Array<{ stop: TourStop; element: HTMLElement }> = []
  for (const stop of stops) {
    const element = resolveStop(stop, root, layout)
    if (element) out.push({ stop, element })
  }
  return out
}

/**
 * Where to start: resuming from a stop the person left at (an index into
 * `TOUR_STOPS`) goes to the first stop at or after it that is on screen now.
 */
export function startIndex(shown: ReadonlyArray<{ stop: TourStop }>, leftAt: number | null): number {
  if (leftAt === null) return 0
  const at = shown.findIndex(({ stop }) => TOUR_STOPS.indexOf(stop) >= leftAt)
  return at === -1 ? 0 : at
}

/** The class every tour popover carries, which `index.css` themes with the app's own tokens. */
export const TOUR_CLASS = 'kehikot-tour'
