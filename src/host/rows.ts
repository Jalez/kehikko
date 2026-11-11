/**
 * A container's two rows — its header and its footer — and the two things
 * Settings › Appearance says about them, the same for every container
 * (`host/appearance.ts`).
 *
 * ## When the rows show
 *
 *   - `always`: the rows never hide.
 *   - `hover`: they hide, and come back while the pointer is over the
 *     container or the keyboard is in it.
 *   - `click`: they hide, and come back when the person clicks inside the
 *     container (into its page, or on its own chrome); clicking into another
 *     container moves them there, and Escape or a click on nothing hides
 *     them. One container at a time is "clicked" (`clickTo`).
 *   - `longpress`: as `click`, but only a press held `LONG_PRESS_MS` inside
 *     the container reveals them; a plain click does not. Closing is
 *     `click`'s. Inside a page that does not report its presses
 *     (`kehikot.pointer`, protocol 2.49.0) only a press on the container's
 *     own chrome can be held.
 *
 * These used to be a choice per container (its Container menu, the fold
 * control's held menu) over a default on the bar. They are one setting now,
 * and a choice a container stored before is ignored.
 *
 * ## How far a fold goes
 *
 * To the header alone, or to the header and the footer, so what is going on
 * in a container — the module's footer: status, location, usage — stays in
 * view while its page is out of the way. Two rows is drawn only for a module
 * whose footer the host draws; any other folds to its header.
 *
 * The words are the header-vs-footer rule's (`kehikot-module-protocol`,
 * docs/footer.md): the header is how the module is set up, the footer is what
 * is going on now. Pure; the page draws and the server stores.
 */

/** When a container's header and footer show. */
export const SHOW_ROWS = ['always', 'hover', 'click', 'longpress'] as const
export type ShowRows = (typeof SHOW_ROWS)[number]

/** How far a container folds: to its header alone, or to its header and footer. */
export const FOLD_ROWS = [1, 2] as const
export type FoldRows = (typeof FOLD_ROWS)[number]

/** Whether a container in this mode hides its rows until they are revealed. */
export function rowsHide(mode: ShowRows): boolean {
  return mode !== 'always'
}

/** How the fold is drawn: folded to two rows only when that was chosen AND the footer is drawn. */
export function foldDrawn(collapsed: boolean, foldRows: FoldRows | undefined, footerDrawn: boolean): 0 | 1 | 2 {
  if (!collapsed) return 0
  return foldRows === 2 && footerDrawn ? 2 : 1
}

/* ------------------------------------------------------------------------ *
 * Reveal on click: which one container is "clicked"
 * ------------------------------------------------------------------------ */

/**
 * What can move the click:
 *
 *   - `frame`: the keyboard went into a module's page — seen here as the
 *     window's blur, or a later change of the active element, with that
 *     container's frame left as the active element. Every press into a page
 *     that did not have the keyboard is one; a press into a page that already
 *     had it is not, which is why a page says its presses itself:
 *   - `press`: the page said the person pressed inside it (`kehikot.pointer`
 *     `down`, protocol 2.49.0);
 *   - `chrome`: a press on a container's own chrome (header, footer, edges);
 *   - `release`: the press ended (`up` or `cancel`, from a page or from this
 *     document), after `held` milliseconds when the page measured it;
 *   - `held`: a press held `LONG_PRESS_MS` (the timer in `Reveals`);
 *   - Escape, a press on nothing (the canvas between containers, the bar),
 *     and a container going away.
 *
 * `mode` is the container's (`rowsShown`), filled by whoever knows it; absent
 * is taken as `click`.
 */
export type ClickEvent =
  | { kind: 'frame'; id: string; mode?: ShowRows }
  | { kind: 'press'; id: string; mode?: ShowRows }
  | { kind: 'chrome'; id: string; mode?: ShowRows }
  | { kind: 'release'; held?: number }
  | { kind: 'held'; id: string }
  | { kind: 'escape' }
  | { kind: 'outside' }
  | { kind: 'forget'; id: string }

/**
 * The container clicked after an event: the one pressed into, nothing after
 * Escape or a press on nothing, and nothing when the clicked one goes away.
 * One at a time — pressing into another container moves it there, which is
 * what hides the previous one's rows.
 *
 * A press into a container revealed on LONG press reveals nothing by itself
 * (`held` does, later), but it still takes the click away from every other
 * container; one already revealed stays revealed. A `release` moves nothing:
 * the timer is `Reveals`'.
 */
export function clickTo(current: string | null, event: ClickEvent): string | null {
  switch (event.kind) {
    case 'frame':
    case 'press':
    case 'chrome':
      if (event.mode === 'longpress') return current === event.id ? current : null
      return event.id
    case 'held':
      return event.id
    case 'release':
      return current
    case 'escape':
    case 'outside':
      return null
    case 'forget':
      return current === event.id ? null : current
  }
}

/** The event with the container's mode filled in, for the events that name a container and may carry one. */
export function withMode(event: ClickEvent, modeOf: (id: string) => ShowRows): ClickEvent {
  if (event.kind === 'frame' || event.kind === 'press' || event.kind === 'chrome') return { ...event, mode: event.mode ?? modeOf(event.id) }
  return event
}

/** Whether this event starts a press a long-press container times (`Reveals`): a page's own press, or one on the chrome. */
export function startsHold(event: ClickEvent): event is { kind: 'press' | 'chrome'; id: string; mode?: ShowRows } {
  return (event.kind === 'press' || event.kind === 'chrome') && event.mode === 'longpress'
}

/** Overlays a press may land in without being "outside": a menu, a dialog, a list a container opened. */
const OVERLAY = '[data-radix-popper-content-wrapper], [role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"], [role="tooltip"]'

/**
 * What a pointerdown in the host's own document means for the click: on a
 * container's chrome (`[data-module]`), on an overlay (nothing), or outside.
 */
export function pressedAt(target: EventTarget | null): ClickEvent | null {
  const element = target && typeof (target as Element).closest === 'function' ? (target as Element) : null
  if (!element) return { kind: 'outside' }
  const container = element.closest('[data-module]')
  const id = container?.getAttribute('data-module')
  if (id) return { kind: 'chrome', id }
  if (element.closest(OVERLAY)) return null
  return { kind: 'outside' }
}

/** The container whose page the keyboard is in: the active element is the frame of `[data-frame]`. */
export function frameFocused(doc: Pick<Document, 'activeElement'>): string | null {
  const active = doc.activeElement
  if (!active || active.tagName !== 'IFRAME') return null
  return active.closest('[data-frame]')?.getAttribute('data-frame') ?? null
}

/** How often the active element is read while a module's page has the keyboard: see `watchClicks`. */
export const FRAME_POLL_MS = 120

/**
 * Listen for what moves the click, on this document and window, and hand each
 * move to `move`. Returns the cleanup.
 *
 * A press inside a module's page is no event here — the page is another
 * document. A page that speaks protocol 2.49.0 says it (`kehikot.pointer`,
 * handed to `Reveals` by the page as `press` and `release`); for one that
 * does not, the press is read from where the keyboard went:
 *
 *   - the window's `blur` with a container's frame left as the active element
 *     (and `focusin` on the frame, for an engine that tells the parent): a
 *     press from the host's own document into a page;
 *   - and, while the window stays blurred, the active element read every
 *     `FRAME_POLL_MS`: a press from one page into ANOTHER blurs nothing here,
 *     the window having no focus to lose, and the active element changing is
 *     all there is to see. Stopped when the window has the keyboard again.
 *
 * A press on the host's own chrome is a `pointerdown` here, and its end a
 * `pointerup` or `pointercancel` (`release`, for a press held on the chrome).
 * Escape is the host document's; a page that has the keyboard keeps its own
 * Escape.
 */
export function watchClicks(doc: Document, win: Window, move: (event: ClickEvent) => void, pollMs = FRAME_POLL_MS): () => void {
  let seen: string | null = null
  let poll: ReturnType<typeof setInterval> | null = null
  const fromFrame = () => {
    const id = frameFocused(doc)
    if (id === seen) return
    seen = id
    if (id) move({ kind: 'frame', id })
  }
  const stopPolling = () => {
    if (poll) clearInterval(poll)
    poll = null
  }
  const onBlur = (event: Event) => {
    if (event.target !== win && event.target !== null && typeof (event.target as Element).tagName === 'string') return
    /* A fresh blur is a fresh press into a page: the same page as last time is news again. */
    seen = null
    setTimeout(fromFrame, 0)
    if (!poll) poll = setInterval(fromFrame, pollMs)
  }
  const onFocus = (event: Event) => {
    if (event.target !== win && event.target !== null && typeof (event.target as Element).tagName === 'string') return
    stopPolling()
    seen = null
  }
  const onFocusIn = (event: Event) => {
    if ((event.target as Element | null)?.tagName === 'IFRAME') fromFrame()
  }
  const onDown = (event: Event) => {
    const moved = pressedAt(event.target)
    if (moved) move(moved)
  }
  const onUp = () => move({ kind: 'release' })
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !event.defaultPrevented) move({ kind: 'escape' })
  }
  win.addEventListener('blur', onBlur)
  win.addEventListener('focus', onFocus)
  doc.addEventListener('focusin', onFocusIn)
  doc.addEventListener('pointerdown', onDown, true)
  doc.addEventListener('pointerup', onUp, true)
  doc.addEventListener('pointercancel', onUp, true)
  doc.addEventListener('keydown', onKey)
  return () => {
    stopPolling()
    win.removeEventListener('blur', onBlur)
    win.removeEventListener('focus', onFocus)
    doc.removeEventListener('focusin', onFocusIn)
    doc.removeEventListener('pointerdown', onDown, true)
    doc.removeEventListener('pointerup', onUp, true)
    doc.removeEventListener('pointercancel', onUp, true)
    doc.removeEventListener('keydown', onKey)
  }
}

/** How long a press is held to reveal a container's rows on long press. */
export const LONG_PRESS_MS = 500
