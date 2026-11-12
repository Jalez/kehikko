/**
 * The guided tour: its steps, what each points at and says, and the rules
 * for where it is. Drawn by driver.js (`src/canvas/Tour.ts`); this file is
 * what to test.
 *
 * ## Two kinds of step
 *
 *   - WAIT — the first run's decisions, which the person makes: pick a
 *     project, create a space, (look at) making a space inside it, create a
 *     kehikko. The tour points at the control and waits; it moves on when
 *     the thing is DONE (`done`, judged from the app's facts), never on a
 *     press of Next. The space may be skipped ("Skip for now"); the space
 *     inside it is optional ("Next"). A step already done is passed over — a
 *     person who has projects, spaces and kehikot starts at the first one
 *     they have not, or goes straight to the explanations.
 *   - SHOW — the explanations after: what each control of the top bar is for
 *     (project, the space breadcrumb and spaces inside spaces, kehikko and
 *     its skills, Pinned, Kehikko modules), a container's header, fold, menus
 *     and corners, then the Inbox, Updates, Settings (with Appearance) and
 *     Help. Next and Back; a stop whose element is not on screen (a bar too
 *     narrow to draw one) is left out. Someone who already has a project, a
 *     space and a kehikko gets only these, so the bar is explained to them
 *     too; the waiting steps are the first run's.
 *
 * Every word shown says "space"; the facts keep their older names (`epic`:
 * a top-level space is chosen, `parts`: spaces inside it are picked).
 *
 * ## Frames
 *
 * A step has frames, most specific first, and the first whose element is on
 * screen is the one shown: inside the folder chooser, else inside the open
 * menu, else the control itself. So opening the project menu moves the tour
 * from "Pick a project to start" to "add a project…", and the folder chooser
 * moves it again — the tour follows the person rather than the other way
 * round. An element is found by `data-tour` attributes put on the controls for
 * this, or by attributes they already carry.
 *
 * ## Pausing
 *
 * Every step has "I've got this". Ticking it (or Escape, or ✕) pauses the
 * tour where it is and points at Help with `PAUSED`; Help → Continue tour
 * picks it up at the same step.
 */

/** What the app knows that decides whether a waiting step is done. */
export interface Facts {
  /** A project somebody picked is open — not the home folder a fresh host opens by itself. */
  project: boolean
  /** How many projects there are besides that home folder: the menu's words differ when there are some to pick. */
  projects: number
  /** A space is chosen (or "All spaces"). The name is the older one, for a top-level space. */
  epic: boolean
  /** Spaces inside the chosen space are picked. The name is the older one. */
  parts: boolean
  /** A kehikko in this project has at least one container on it. */
  kehikko: boolean
}

/**
 * Whether a project somebody picked is open. The home folder a fresh host opens
 * by itself is flagged `home` and is not one — the host writes nothing under
 * it, so the tour's project step waits until the person picks a folder (the
 * picker clears the flag, even when the folder picked is their home).
 */
export function projectPicked(projectId: number | null, project: { home?: boolean } | null | undefined): boolean {
  return projectId !== null && !project?.home
}

export const NO_FACTS: Facts = { project: false, projects: 0, epic: false, parts: false, kehikko: false }

export type Side = 'top' | 'right' | 'bottom' | 'left'
export type Align = 'start' | 'center' | 'end'

export interface TourFrame {
  /** What it points at, in order of preference: the first that finds an element on screen. */
  selectors: readonly string[]
  title: string
  body: string | ((facts: Facts) => string)
  side?: Side
  align?: Align
}

export type StepKind = 'wait' | 'show'

export interface TourStep {
  id: string
  kind: StepKind
  /** A waiting step: has the person done what it asks? */
  done?(facts: Facts): boolean
  /** A waiting step the person may move past without doing it: the button's words. */
  pass?: string
  /**
   * Points into the one example container the tour uses (`pickExample`).
   * `header`: at its header, which the tour makes visible first; `corners`:
   * at its four corner handles.
   */
  example?: 'header' | 'corners'
  frames: readonly TourFrame[]
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'project',
    kind: 'wait',
    done: (facts) => facts.project,
    frames: [
      {
        selectors: ['[data-tour="add-folder"]'],
        title: 'Choose its folder',
        body: 'Walk into the folder you work in — a repository, a paper, a thesis — and press add this folder. Or press add on its row.',
        /* Below the window: above the button it would cover the folders. */
        side: 'bottom',
        align: 'end',
      },
      {
        selectors: ['[data-tour="add-project"]'],
        title: 'Add your project',
        body: (facts) =>
          facts.projects > 0
            ? 'Pick one of your projects above, or choose add a project… to open another folder.'
            : 'Kehikot works on a folder you already have. Choose add a project… to find it.',
        side: 'right',
        align: 'center',
      },
      {
        selectors: ['[data-tour="project"]'],
        title: 'Pick a project to start',
        body: 'A project is a folder you work in. Open this menu to choose one.',
        side: 'bottom',
        align: 'start',
      },
    ],
  },
  {
    id: 'space',
    kind: 'wait',
    done: (facts) => facts.epic,
    pass: 'Skip for now',
    frames: [
      {
        selectors: ['[data-tour="space-form"]'],
        title: 'Name your space',
        body: 'What is the piece of work? A feature, a chapter, a study. Give it a name and press Enter.',
        side: 'right',
        align: 'start',
      },
      {
        selectors: ['[data-tour="new-space"]'],
        title: 'Create your first space',
        body: 'Choose new space… to make one — or pick a space the project already has.',
        side: 'right',
        align: 'center',
      },
      {
        selectors: ['[data-tour="space"]'],
        title: 'Create your first space',
        body: 'A space is one piece of work in this project, and every module works in the space picked here. Open this menu to make one.',
        side: 'bottom',
        align: 'start',
      },
    ],
  },
  {
    id: 'sub-space',
    kind: 'wait',
    /* Optional: passed by Next. Counted done once there is a kehikko with
       something on it — a person past their first run is not walked here. */
    done: (facts) => facts.parts || facts.kehikko,
    pass: 'Next',
    frames: [
      {
        selectors: ['[data-tour="space-form"]'],
        title: 'Name the space inside it',
        body: 'Give it a name and press Enter. Pick it, or a few side by side, and every module narrows to them. Press Next when you are ready.',
        side: 'right',
        align: 'start',
      },
      {
        selectors: ['[data-tour="space-add"]'],
        title: 'A space inside a space',
        body: 'Press + on a row to make a space inside it. Spaces nest as deep as the work does. Press Next when you are ready.',
        side: 'right',
        align: 'center',
      },
      {
        selectors: ['[data-tour="space"]'],
        title: 'Spaces hold spaces — if you like',
        body: 'A space can be divided into spaces of its own. Open this menu and press + on a row to make one. This one is optional.',
        side: 'bottom',
        align: 'start',
      },
    ],
  },
  {
    id: 'kehikko',
    kind: 'wait',
    done: (facts) => facts.kehikko,
    frames: [
      {
        selectors: ['[data-layout-install]'],
        title: 'Install what it needs',
        body: 'These modules come from the official list. Install them and the kehikko is made with them; Create without them leaves them out.',
        side: 'top',
        align: 'end',
      },
      {
        /* The button the step ends on, from above: the first row of cards —
           Blank, Design, Research — stays clear, and a window this tall
           leaves no room beside it. */
        selectors: ['[data-layout-create]'],
        title: 'Create your first kehikko',
        body: 'Pick the way you want to work — Design, Research, Development, Review or Learning — then press Create kehikko. You can change everything afterwards.',
        side: 'top',
        align: 'end',
      },
      {
        selectors: ['[data-tour="new-kehikko"]'],
        title: 'Create your first kehikko',
        body: 'Choose new kehikko… and start it from a suggested layout.',
        side: 'right',
        align: 'center',
      },
      {
        selectors: ['[data-tour="kehikko"]'],
        title: 'Your kehikot live here',
        body: 'A kehikko is a set of modules side by side, all on this project and space — one for each way you work. Open this menu.',
        side: 'bottom',
        align: 'start',
      },
    ],
  },
  {
    id: 'project-bar',
    kind: 'show',
    frames: [
      {
        selectors: ['[data-tour="project"]', 'button[aria-label="switch project"]'],
        title: 'Your projects',
        body:
          'Switch project here, or add another folder with add a project…. Order the list A–Z or by Recent.',
        side: 'bottom',
        align: 'start',
      },
    ],
  },
  {
    id: 'space-bar',
    kind: 'show',
    frames: [
      {
        selectors: ['[data-tour="space"]', 'button[aria-label="the space this project is on"]'],
        title: 'Where you are',
        body:
          'The path to the space you are in: the project, then each space it sits in. Every module works in the space picked here. Open it for every space as a tree — pick one at any depth, or All spaces for the whole project.',
        side: 'bottom',
        align: 'start',
      },
    ],
  },
  {
    id: 'sub-space-bar',
    kind: 'show',
    frames: [
      {
        selectors: ['[data-tour="space-add"]', '[data-tour="space"]', 'button[aria-label="the space this project is on"]'],
        title: 'Spaces inside spaces',
        body:
          'Any space can hold spaces of its own: in the tree, + on a row makes one inside it. Pick one or a few side by side and every module narrows to them.',
        side: 'bottom',
        align: 'start',
      },
    ],
  },
  {
    id: 'kehikko-bar',
    kind: 'show',
    frames: [
      {
        selectors: ['[data-tour="kehikko"]', 'button[aria-label="switch kehikko"]'],
        title: 'Your kehikot',
        body:
          'A space can have several kehikot, each its own arrangement of modules. Switch between them here, or choose new kehikko… to make another.',
        side: 'bottom',
        align: 'start',
      },
    ],
  },
  {
    id: 'kehikko-skills',
    kind: 'show',
    frames: [
      {
        selectors: ['[data-tour="kehikko"]', 'button[aria-label="switch kehikko"]'],
        title: 'Kehikko settings',
        body: 'The gear on a kehikko’s row in this menu opens its settings: its name, skills of your own that every agent on it follows, and which agent is primary when it has more than one.',
        side: 'bottom',
        align: 'start',
      },
    ],
  },
  {
    id: 'pinned',
    kind: 'show',
    frames: [
      {
        selectors: ['[data-tour="pinned"]', '[data-testid="pinned-menu"]'],
        title: 'Pinned places',
        body:
          'Pin the place you are on — project, space and kehikko — with the pin button or Alt+Shift+P. Come back to it in one click from this menu.',
        side: 'bottom',
        align: 'start',
      },
    ],
  },
  {
    id: 'modules',
    kind: 'show',
    frames: [
      {
        selectors: ['[data-tour="modules"]', 'button[aria-label="Kehikko modules"]'],
        title: 'Kehikko modules',
        body:
          'Install, add and update modules here: the official list, or Install from repository… for one that is not on it.',
        side: 'bottom',
        align: 'end',
      },
    ],
  },
  {
    id: 'header',
    kind: 'show',
    example: 'header',
    frames: [
      {
        selectors: ['[data-tour-example] header.container-grip'],
        title: 'A container’s header',
        body: 'Drag a container by its header to move it. Tick its box to point your agents at it.',
        side: 'bottom',
        align: 'start',
      },
    ],
  },
  {
    id: 'fold',
    kind: 'show',
    example: 'header',
    frames: [
      {
        selectors: ['[data-tour-example] [data-tour="fold"]'],
        title: 'Fold it out of the way',
        body: 'Press the chevron to fold the container. How far a fold goes, and when every header and footer shows, are in Settings › Appearance.',
        side: 'bottom',
        align: 'end',
      },
    ],
  },
  {
    id: 'frame',
    kind: 'show',
    example: 'header',
    frames: [
      {
        selectors: ['[data-tour-example] [data-menu="frame"]'],
        title: 'The Container menu',
        body: 'Everything about the container itself: its scope, its settings, Use inbox, and Remove from this kehikko. The ? beside it is its Help: the same menu as the app’s own, for this module.',
        side: 'bottom',
        align: 'end',
      },
    ],
  },
  {
    id: 'menus',
    kind: 'show',
    example: 'header',
    frames: [
      {
        selectors: ['[data-tour-example] [data-header-menus]'],
        title: 'The module’s own menus',
        body: 'View, Go and Run belong to the module: switch what it shows, run what it offers. Each kehikko keeps its own view.',
        side: 'bottom',
        align: 'end',
      },
    ],
  },
  {
    id: 'corners',
    kind: 'show',
    example: 'corners',
    frames: [
      {
        /* One corner anchors the popover; all four are lit (`data-tour-corners`
           in `index.css`), so the container's whole outline is not. */
        selectors: ['[data-tour-example] > .react-resizable-handle-se'],
        title: 'Resize from any corner',
        body: 'Every corner of a container is a handle. Neighbours make room, and get it back when you fold or shrink it.',
        side: 'top',
        align: 'end',
      },
    ],
  },
  {
    id: 'inbox',
    kind: 'show',
    frames: [
      {
        selectors: ['[data-inbox-count]'],
        title: 'The Inbox',
        body: 'How many things need you, in every project. Add the Inbox to a kehikko to see them all there and answer an agent’s question; Alt+Shift+N goes to the next thing that needs you.',
        side: 'bottom',
        align: 'end',
      },
    ],
  },
  {
    id: 'updates',
    kind: 'show',
    frames: [
      {
        selectors: ['[data-tour="updates"]'],
        title: 'Updates',
        body: 'Whether Kehikot and its modules have new releases, and what is new in them.',
        side: 'bottom',
        align: 'end',
      },
    ],
  },
  {
    id: 'settings',
    kind: 'show',
    frames: [
      {
        selectors: ['[data-tour="settings"]', 'button[aria-label="Settings"]'],
        title: 'Settings',
        body: 'What your agent uses outside Kehikot, how the Inbox tells you, and how it looks: Appearance has the headers and footers, the theme, and the containers’ borders and background. ⌘, (Ctrl+, elsewhere) opens it from anywhere.',
        side: 'bottom',
        align: 'end',
      },
    ],
  },
  {
    id: 'help',
    kind: 'show',
    frames: [
      {
        selectors: ['[data-tour="help"]'],
        title: 'Help is here',
        body: 'The introduction, this tour, What’s new and feedback are in this menu whenever you want them. Every container has the same ? for its module.',
        side: 'bottom',
        align: 'end',
      },
    ],
  },
]

/** Where the tour points once paused: Help, which is where it is picked up. */
export const PAUSED: TourFrame = {
  selectors: ['[data-tour="help"]'],
  title: 'Tour paused!',
  body: 'If you’d like to continue where you left off, open the Help menu and click Continue tour.',
  side: 'bottom',
  align: 'end',
}

/** Where it points after "I'll explore myself": the same place, for the same reason. */
export const EXPLORING: TourFrame = {
  selectors: ['[data-tour="help"]'],
  title: 'Explore away',
  body: 'The tour is in the Help menu whenever you want it, and so is the introduction.',
  side: 'bottom',
  align: 'end',
}

/** The words of the box on every step. */
export const GOT_THIS = 'I’ve got this'

export function stepIndex(id: string | null | undefined): number {
  return id ? TOUR_STEPS.findIndex((step) => step.id === id) : -1
}

/** Is this step done? A waiting step by the facts; an explanation never is (it is shown or left out). */
export function isDone(step: TourStep, facts: Facts): boolean {
  return step.kind === 'wait' && step.done !== undefined && step.done(facts)
}

/**
 * The step to be at: the first at or after `from` that is not done. Once no
 * project is open nothing after the project step can be done, so a tour
 * standing further on goes back to it.
 */
export function firstUndone(facts: Facts, from = 0): number {
  if (!facts.project) return 0
  const at = TOUR_STEPS.findIndex((step, index) => index >= from && !isDone(step, facts))
  return at === -1 ? TOUR_STEPS.length : at
}

export function bodyOf(frame: TourFrame, facts: Facts): string {
  return typeof frame.body === 'function' ? frame.body(facts) : frame.body
}

/** "Getting started · 2 of 4" for a waiting step; null for an explanation (counted where it is drawn). */
export function waitProgress(step: TourStep): string | null {
  const waits = TOUR_STEPS.filter((one) => one.kind === 'wait')
  const at = waits.indexOf(step)
  return at === -1 ? null : `Getting started · ${at + 1} of ${waits.length}`
}

/**
 * Is this element drawn: not hidden, and — where there is layout — with a
 * size. `layout: false` is for a DOM that measures nothing (a test). Behind a
 * modal window (`aria-hidden` on everything else) counts as not drawn: the
 * tour then points into the window instead.
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

/** The element a frame points at now, or null when none of its selectors finds one on screen. */
export function resolveFrame(frame: TourFrame, root: ParentNode = document, layout = true): HTMLElement | null {
  for (const selector of frame.selectors) {
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

/** The frame of a step shown now, with its element — the first, most specific, that is on screen. */
export function frameOf(
  step: TourStep,
  root: ParentNode = document,
  layout = true,
): { frame: TourFrame; index: number; element: HTMLElement } | null {
  for (const [index, frame] of step.frames.entries()) {
    const element = resolveFrame(frame, root, layout)
    if (element) return { frame, index, element }
  }
  return null
}

/**
 * Is a stop that points into the example container one the tour can make? Judged
 * from the page, not from where the tour stands: the example is marked, and the
 * headers shown, only while one of these stops is up, yet the stops BEFORE them
 * (the top bar's) must count them in their "n of m" and walk on to them.
 * Hidden headers count (the tour shows them); a control the container does not
 * have does not.
 */
function exampleHas(step: TourStep, root: ParentNode, layout: boolean): boolean {
  const example = pickExample(root, layout)
  if (!example) return false
  const prefix = `[${EXAMPLE_ATTR}]`
  return step.frames.some((frame) =>
    frame.selectors.some((selector) => {
      if (!selector.startsWith(prefix)) return false
      try {
        return example.querySelector(`:scope${selector.slice(prefix.length)}`) !== null
      } catch {
        return false
      }
    }),
  )
}

/** The explanations on screen now, as indexes into `TOUR_STEPS`. */
export function shownExplanations(root: ParentNode = document, layout = true): number[] {
  return TOUR_STEPS.flatMap((step, index) => {
    if (step.kind !== 'show') return []
    const shown = step.example !== undefined ? exampleHas(step, root, layout) : frameOf(step, root, layout) !== null
    return shown ? [index] : []
  })
}

/** The class every tour popover carries, which `index.css` themes with the app's own tokens. */
export const TOUR_CLASS = 'kehikot-tour'

/** What the first header stop adds when the tour has switched the headers on. */
export const HEADERS_NOTE = 'Headers are shown for the tour; they’ll hide again afterwards.'

/** The attribute that marks the grid item the tour uses as its example. */
export const EXAMPLE_ATTR = 'data-tour-example'

/** Is all of this element in the window? Unmeasured (all zero) counts as in. */
export function inView(element: Element, view: Window | null = element.ownerDocument.defaultView): boolean {
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return true
  const height = view?.innerHeight || 0
  const width = view?.innerWidth || 0
  if (!height || !width) return true
  return rect.top >= 0 && rect.left >= 0 && rect.bottom <= height && rect.right <= width
}

/**
 * The container the header, fold, Container, menus and corner stops all point at: an
 * unfolded one that is drawn, whose header has menus (and a Container menu), the
 * one in the window before one that is not. Null when no container is
 * unfolded: those stops are then left out.
 */
export function pickExample(root: ParentNode = document, layout = true): HTMLElement | null {
  let best: { item: HTMLElement; score: number } | null = null
  for (const item of root.querySelectorAll<HTMLElement>('.react-grid-item')) {
    const module = item.querySelector('[data-module]')
    const header = module?.querySelector<HTMLElement>('header.container-grip')
    if (!module || !header) continue
    if (header.dataset.dense === 'true' || item.querySelector('[data-collapsed]')) continue
    if (!onScreen(item, layout)) continue
    const menus = module.querySelector('[data-header-menus]') ? 1 : 0
    const frame = module.querySelector('[data-menu="frame"]') ? 1 : 0
    const score = menus * 8 + frame * 4 + (inView(item) ? 1 : 0)
    if (!best || score > best.score) best = { item, score }
  }
  return best?.item ?? null
}
