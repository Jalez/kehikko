/**
 * A container's two rows — its header and its footer — and the two choices a
 * person makes about them per container.
 *
 * ## When the rows show
 *
 * The bar's focus control used to be the only say: on, every container's rows
 * hid and came back while the pointer was over it (`host/reveal.ts`); off,
 * they always showed. That stays as the DEFAULT, and each container may
 * now say otherwise (`showRows` on the placement, next to `collapsed`):
 *
 *   - `always`: the rows never hide.
 *   - `hover`: they hide, and come back while the pointer is over the
 *     container or the keyboard is in it — what focus mode always did.
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
 * `null` follows the bar: `hover` with focus mode on, `always` with it off.
 *
 * The choice is in two places: the Container menu's "Header and footer", and the
 * second group of the fold control's held-press menu, under the fold choice.
 *
 * ## How far a fold goes
 *
 * Folding used to leave the header alone. A container may now fold to its
 * header and its footer (`foldRows: 2`), so what is going on in it — the
 * module's footer: status, location, usage — stays in view while its page is
 * out of the way. Two rows is offered only for a module whose footer the host
 * draws; a container that was folded to two and has no footer now draws its
 * header in the room it has, and keeps the choice for when the footer is back.
 * A plain press on the fold control folds to the remembered choice; a long
 * press (or Shift+Enter, the context-menu key, Shift+F10, a right click)
 * opens the choice.
 *
 * The words are the header-vs-footer rule's (`kehikot-module-protocol`,
 * docs/footer.md): the header is how the module is set up, the footer is what
 * is going on now. Pure; the page draws and the server stores.
 */

import type { Focus } from './focus.ts'

/** When a container's header and footer show. */
export const SHOW_ROWS = ['always', 'hover', 'click', 'longpress'] as const
export type ShowRows = (typeof SHOW_ROWS)[number]

/** How far a container folds: to its header alone, or to its header and footer. */
export const FOLD_ROWS = [1, 2] as const
export type FoldRows = (typeof FOLD_ROWS)[number]

/** A stored or posted value, or `null` (follow the bar) for anything else. */
export function showRowsIn(value: unknown): ShowRows | null {
  return typeof value === 'string' && (SHOW_ROWS as readonly string[]).includes(value) ? (value as ShowRows) : null
}

/** A stored or posted value, or `1` for anything that is not a literal 2. */
export function foldRowsIn(value: unknown): FoldRows {
  return value === 2 ? 2 : 1
}

/** What the bar's focus control means for a container that has not said: the default. */
export function barRows(focus: Focus): ShowRows {
  return focus === 'on' ? 'hover' : 'always'
}

/** When this container's rows show: its own choice, or the bar's. */
export function rowsShown(placement: { showRows?: ShowRows | null }, focus: Focus): ShowRows {
  return placement.showRows ?? barRows(focus)
}

/** Whether a container in this mode hides its rows until they are revealed. */
export function rowsHide(mode: ShowRows): boolean {
  return mode !== 'always'
}

/** The words for each mode, in the container's menu. */
export const SHOW_ROWS_SAID: Readonly<Record<ShowRows, { label: string; hint: string }>> = {
  always: { label: 'Always shown', hint: 'the header and footer never hide' },
  hover: { label: 'Reveal on hover', hint: 'they hide, and come back while the pointer is over this container' },
  click: { label: 'Reveal on click', hint: 'they hide, and come back when you click inside this container; Escape or a click elsewhere hides them' },
  longpress: {
    label: 'Reveal on long press',
    hint: 'they hide, and come back when you hold a press inside this container (a plain click does not); Escape or a click elsewhere hides them. In a module too old to report presses, hold on the header',
  },
}

/** The words for each fold, in the fold control's menu: the header-vs-footer rule, one line each. */
export const FOLD_ROWS_SAID: Readonly<Record<FoldRows, { label: string; line: string }>> = {
  1: { label: 'One row', line: 'only the header: how this module is set up.' },
  2: { label: 'Two rows', line: 'header and footer: also what’s going on now (status, location, usage).' },
}

/**
 * Which fold choices are offered: two rows only when the host draws this
 * module's footer. With one choice the fold group is left out of the fold
 * control's menu; the menu still holds when the rows show.
 */
export function foldChoices(footerDrawn: boolean): readonly FoldRows[] {
  return footerDrawn ? FOLD_ROWS : [1]
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

/* ------------------------------------------------------------------------ *
 * The fold control's choice: a long press, or the keyboard
 * ------------------------------------------------------------------------ */

/** How long a press on the fold control is held before it opens the choice instead of folding. */
export const LONG_PRESS_MS = 500

/** Whether a key on the fold control opens the choice: Shift+Enter, the context-menu key, Shift+F10. */
export function opensFoldChoice(event: { key: string; shiftKey: boolean }): boolean {
  if (event.key === 'ContextMenu') return true
  return event.shiftKey && (event.key === 'Enter' || event.key === 'F10')
}

/**
 * A long press, as a small machine: `down` arms a timer, `up` before it
 * fires is a click, and the timer firing opens the choice and swallows the
 * click that follows the release. A pointer that leaves or is cancelled
 * disarms it. `now` and the timer are injected so a test needs no clock.
 */
export class LongPress {
  #timer: ReturnType<typeof setTimeout> | null = null
  #fired = false
  readonly #ms: number
  readonly #open: () => void

  constructor(open: () => void, ms = LONG_PRESS_MS) {
    this.#open = open
    this.#ms = ms
  }

  down(): void {
    this.cancel()
    this.#fired = false
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#fired = true
      this.#open()
    }, this.#ms)
  }

  /** The pointer left or was cancelled before the timer: nothing happens. */
  cancel(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }

  /** Whether the click that arrives now is a plain click (true) or the end of a long press (false). */
  click(): boolean {
    this.cancel()
    const plain = !this.#fired
    this.#fired = false
    return plain
  }
}
