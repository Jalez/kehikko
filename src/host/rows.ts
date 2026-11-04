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
 *
 * `null` follows the bar: `hover` with focus mode on, `always` with it off.
 *
 * The choice is in two places: the Frame menu's "Header and footer", and the
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
export const SHOW_ROWS = ['always', 'hover', 'click'] as const
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
 * What can move the click: the keyboard or the pointer going into a module's
 * page (seen here as the window's blur with that container's frame left as
 * the active element), a press on a container's own chrome, Escape, a press
 * on nothing (the canvas between containers, the bar), and a container going
 * away.
 */
export type ClickEvent =
  | { kind: 'frame'; id: string }
  | { kind: 'chrome'; id: string }
  | { kind: 'escape' }
  | { kind: 'outside' }
  | { kind: 'forget'; id: string }

/**
 * The container clicked after an event: the one pressed into, nothing after
 * Escape or a press on nothing, and nothing when the clicked one goes away.
 * One at a time — clicking into another container moves it there, which is
 * what hides the previous one's rows.
 */
export function clickTo(current: string | null, event: ClickEvent): string | null {
  switch (event.kind) {
    case 'frame':
    case 'chrome':
      return event.id
    case 'escape':
    case 'outside':
      return null
    case 'forget':
      return current === event.id ? null : current
  }
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

/**
 * Listen for what moves the click, on this document and window, and hand each
 * move to `move`. Returns the cleanup.
 *
 * A click inside a module's page is no event here — the page is another
 * document — so it is read the way the menus read it: the window's `blur`
 * with that container's frame left as the active element (and `focusin` on
 * the frame, for an engine that tells the parent). A press on the host's own
 * chrome is a `pointerdown` here. Escape is the host document's; a page that
 * has the keyboard keeps its own Escape.
 */
export function watchClicks(doc: Document, win: Window, move: (event: ClickEvent) => void): () => void {
  const fromFrame = () => {
    const id = frameFocused(doc)
    if (id) move({ kind: 'frame', id })
  }
  const onBlur = (event: Event) => {
    if (event.target !== win && event.target !== null && typeof (event.target as Element).tagName === 'string') return
    setTimeout(fromFrame, 0)
  }
  const onFocusIn = (event: Event) => {
    if ((event.target as Element | null)?.tagName === 'IFRAME') fromFrame()
  }
  const onDown = (event: Event) => {
    const moved = pressedAt(event.target)
    if (moved) move(moved)
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !event.defaultPrevented) move({ kind: 'escape' })
  }
  win.addEventListener('blur', onBlur)
  doc.addEventListener('focusin', onFocusIn)
  doc.addEventListener('pointerdown', onDown, true)
  doc.addEventListener('keydown', onKey)
  return () => {
    win.removeEventListener('blur', onBlur)
    doc.removeEventListener('focusin', onFocusIn)
    doc.removeEventListener('pointerdown', onDown, true)
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
