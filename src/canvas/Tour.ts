import { driver, type AllowedButtons, type Driver } from 'driver.js'

import {
  bodyOf,
  firstUndone,
  frameOf,
  GOT_THIS,
  PAUSED,
  resolveFrame,
  shownExplanations,
  stepIndex,
  TOUR_CLASS,
  TOUR_STEPS,
  waitProgress,
  type Align,
  type Facts,
  type Side,
  type TourFrame,
} from '@/host/tour.ts'

/**
 * The guided tour, run. The steps and the rules for which is shown are
 * `src/host/tour.ts`; this is the part that watches the page and draws.
 *
 * `Guide` holds where the tour is and decides what to show; a `Drawer` draws
 * it. The drawer is driver.js (MIT, framework-free, pinned exactly in
 * `package.json`), dressed by `.kehikot-tour` in `index.css` in the app's own
 * tokens. A test hands the guide a drawer that records instead.
 *
 * ## Waiting without getting in the way
 *
 * A waiting step points at a control the person is meant to PRESS, and the
 * press opens a menu or a window the tour then points into. driver.js
 * normally dims the page and switches pointer events off everywhere but the
 * one element; for a waiting step the drawer turns both off
 * (`data-tour-mode="wait"` on <html>, `driver-active` taken off the body), and
 * stops the popover taking focus — a Radix menu closes when focus leaves it.
 * The explanations after are ordinary driver.js: dimmed, Next and Back.
 *
 * The guide re-reads the page whenever it changes (a MutationObserver, only
 * while the tour runs) and the app's facts whenever they change (`refresh`),
 * so it follows the person: a menu opened, a window closed, a project chosen.
 */

/** One popover, as the guide wants it drawn. */
export interface TourView {
  /** Changes when what is shown changes; the same key is not drawn twice. */
  key: string
  element: HTMLElement
  title: string
  body: string
  side?: Side
  align?: Align
  /** `wait`: no dimming, the page usable; `show`: dimmed, the element inert. */
  mode: 'wait' | 'show'
  progress: string | null
  /** The forward button's words, when there is one. */
  next?: string
  back?: boolean
  /** The "I've got this" box. */
  gotThis: boolean
  onNext(): void
  onBack(): void
  /** "I've got this", ✕. */
  onPause(): void
}

export interface Drawer {
  show(view: TourView): void
  hide(): void
}

export interface GuideOptions {
  /** What the app knows now: is a project open, an epic chosen, a kehikko made. */
  facts(): Facts
  /** The tour moved to this step: remember it. */
  onStep(step: string): void
  /** Paused at this step ("I've got this", Escape, ✕). */
  onPause(step: string): void
  /** The last explanation's Done. */
  onFinish(): void
  root?: Document
  /** False where nothing is measured (a test): every element counts as drawn. */
  layout?: boolean
  drawer?: Drawer
  /** How long the explanations wait for a just-made kehikko's containers to be drawn, in ms. */
  patience?: number
  /** How long the page is let settle after a change before it is read again, in ms. */
  settle?: number
}

type Mode = 'idle' | 'tour' | 'note'

export class Guide {
  private at = 0
  private mode: Mode = 'idle'
  private note: TourFrame | null = null
  private shown: string | null = null
  private direction: 1 | -1 = 1
  private patientUntil = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private watch: MutationObserver | null = null
  private readonly root: Document
  private readonly layout: boolean
  private readonly drawer: Drawer

  constructor(private readonly options: GuideOptions) {
    this.root = options.root ?? document
    this.layout = options.layout ?? true
    this.drawer = options.drawer ?? driverDrawer(this.root)
  }

  /** The step the tour is at, while it runs. */
  get step(): string | null {
    return this.mode === 'tour' ? (TOUR_STEPS[this.at]?.id ?? null) : null
  }

  get running(): Mode {
    return this.mode
  }

  /**
   * Start, or pick up. `from` null starts at the first step not already done;
   * a step's id picks up there (and moves on at once if it has been done
   * since).
   */
  start(from: string | null): void {
    const facts = this.options.facts()
    const resumed = stepIndex(from)
    this.mode = 'tour'
    this.note = null
    this.direction = 1
    this.patientUntil = 0
    this.go(resumed >= 0 ? resumed : firstUndone(facts, 0))
    this.listen()
    this.render()
  }

  /** Point at Help with a note — after a pause, or "I'll explore myself" — until Got it, or Help is opened. */
  point(frame: TourFrame): void {
    this.mode = 'note'
    this.note = frame
    this.listen()
    this.render()
  }

  /** The facts changed, or something else the guide cannot see: read everything again. */
  refresh(): void {
    this.schedule()
  }

  /** "I've got this", Escape, ✕: remember the step, and say where to pick it up. */
  pause(): void {
    if (this.mode !== 'tour') return
    const step = TOUR_STEPS[this.at]
    if (step) this.options.onPause(step.id)
    this.point(PAUSED)
  }

  /** Take everything down without recording anything (the page is going). */
  stop(): void {
    this.mode = 'idle'
    this.note = null
    this.shown = null
    clearTimeout(this.timer)
    this.watch?.disconnect()
    this.watch = null
    this.root.defaultView?.removeEventListener('keydown', this.onKey, true)
    this.root.documentElement.removeAttribute('data-tour-running')
    this.drawer.hide()
  }

  /** Move on from a waiting step without doing it: "Skip for now", "Next". */
  pass(): void {
    if (this.mode !== 'tour') return
    this.direction = 1
    this.go(this.at + 1)
    this.render()
  }

  next(): void {
    if (this.mode !== 'tour') return
    const shown = shownExplanations(this.root, this.layout)
    const after = shown.find((index) => index > this.at)
    if (after === undefined) return this.finish()
    this.direction = 1
    this.go(after)
    this.render()
  }

  back(): void {
    if (this.mode !== 'tour') return
    const shown = shownExplanations(this.root, this.layout)
    const before = shown.filter((index) => index < this.at).at(-1)
    if (before === undefined) return
    this.direction = -1
    this.go(before)
    this.render()
  }

  private finish(): void {
    this.options.onFinish()
    this.stop()
  }

  private go(index: number): void {
    const from = TOUR_STEPS[this.at]
    this.at = index
    const to = TOUR_STEPS[index]
    if (!to) return
    /* Off the waiting steps and onto the explanations: a kehikko made a
       moment ago is still drawing its containers. */
    if (to.kind === 'show' && from?.kind === 'wait') this.patientUntil = Date.now() + (this.options.patience ?? 1500)
    this.options.onStep(to.id)
  }

  private listen(): void {
    /* What would open by itself waits while this stands (`tourStanding`). */
    this.root.documentElement.setAttribute('data-tour-running', '')
    if (!this.watch) {
      const View = this.root.defaultView
      if (View && 'MutationObserver' in View) {
        this.watch = new View.MutationObserver(() => this.schedule())
        this.watch.observe(this.root.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['aria-hidden', 'hidden', 'data-state', 'disabled'],
        })
      }
      this.root.defaultView?.addEventListener('keydown', this.onKey, true)
    }
  }

  private schedule(wait = this.options.settle ?? 40): void {
    if (this.mode === 'idle') return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.render(), wait)
  }

  /** Is a menu or a window open? Escape and the arrows are theirs then. */
  private modalOpen(): boolean {
    return this.root.querySelector('[role="menu"], [role="dialog"]:not(.driver-popover), [role="alertdialog"]') !== null
  }

  private readonly onKey = (event: KeyboardEvent) => {
    if (this.mode === 'idle' || this.modalOpen()) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (this.mode === 'tour') this.pause()
      else this.stop()
      return
    }
    const step = TOUR_STEPS[this.at]
    if (this.mode !== 'tour' || step?.kind !== 'show') return
    if (event.key === 'ArrowRight') this.next()
    if (event.key === 'ArrowLeft') this.back()
  }

  /* As a press outside it, not Escape: Escape gives focus back to the
     menu's trigger, which raises its tooltip under the next step. */
  private shutMenu(): void {
    if (!this.root.querySelector('[role="menu"]')) return
    const View = this.root.defaultView
    if (!View) return
    /* Read, and taken off, by the menu as it closes (`dropdown-menu.tsx`). */
    this.root.documentElement.setAttribute('data-tour-shut', '')
    setTimeout(() => this.root.documentElement.removeAttribute('data-tour-shut'), 1000)
    this.root.body.dispatchEvent(new View.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }))
  }

  private hide(): void {
    if (this.shown === null) return
    this.shown = null
    this.drawer.hide()
  }

  private render(): void {
    clearTimeout(this.timer)
    if (this.mode === 'note') return this.renderNote()
    if (this.mode !== 'tour') return
    const facts = this.options.facts()
    const step = TOUR_STEPS[this.at]
    if (!step) return this.finish()

    if (step.kind === 'wait') {
      const want = firstUndone(facts, facts.project ? this.at : 0)
      if (want !== this.at) {
        /* Done inside a menu that stays open (a new epic is made in the epic
           menu, which then shows the list again): shut it, so the next step's
           control is not behind it. */
        if (want > this.at) this.shutMenu()
        this.direction = 1
        this.go(want)
        return this.render()
      }
      const found = frameOf(step, this.root, this.layout)
      /* Between one window and the next nothing may be on screen: wait. */
      if (!found) return this.hide()
      const waits = step.pass
      return this.draw({
        key: `${step.id}:${found.index}:${bodyOf(found.frame, facts)}`,
        element: found.element,
        title: found.frame.title,
        body: bodyOf(found.frame, facts),
        side: found.frame.side,
        align: found.frame.align,
        mode: 'wait',
        progress: waitProgress(step),
        next: waits,
        back: false,
        gotThis: true,
        onNext: () => this.pass(),
        onBack: () => {},
        onPause: () => this.pause(),
      })
    }

    const found = frameOf(step, this.root, this.layout)
    if (!found) {
      if (Date.now() < this.patientUntil) {
        this.hide()
        return this.schedule(Math.max(50, this.patientUntil - Date.now()))
      }
      /* Not on screen: the next one that is, in the direction of travel. */
      const shown = shownExplanations(this.root, this.layout)
      const onward = this.direction === 1 ? shown.find((index) => index > this.at) : shown.filter((index) => index < this.at).at(-1)
      const other = onward ?? shown.find((index) => index > this.at)
      if (other === undefined) return this.finish()
      this.go(other)
      return this.render()
    }
    const shown = shownExplanations(this.root, this.layout)
    const position = shown.indexOf(this.at)
    const last = position === shown.length - 1
    this.draw({
      key: `${step.id}:${found.index}`,
      element: found.element,
      title: found.frame.title,
      body: bodyOf(found.frame, facts),
      side: found.frame.side,
      align: found.frame.align,
      mode: 'show',
      progress: `${position + 1} of ${shown.length}`,
      next: last ? 'Done' : 'Next',
      back: position > 0,
      gotThis: true,
      onNext: () => this.next(),
      onBack: () => this.back(),
      onPause: () => this.pause(),
    })
  }

  private renderNote(): void {
    const frame = this.note
    /* Help opened: the note has done its job. */
    if (!frame || this.root.querySelector('[data-help-menu]')) return this.stop()
    const element = resolveFrame(frame, this.root, this.layout)
    /* Behind a window still open (paused from inside one): shown once it closes. */
    if (!element) return this.hide()
    this.draw({
      key: `note:${frame.title}`,
      element,
      title: frame.title,
      body: bodyOf(frame, this.options.facts()),
      side: frame.side,
      align: frame.align,
      mode: 'wait',
      progress: null,
      next: 'Got it',
      back: false,
      gotThis: false,
      onNext: () => this.stop(),
      onBack: () => {},
      onPause: () => this.stop(),
    })
  }

  private last: HTMLElement | null = null

  private draw(view: TourView): void {
    if (this.shown === view.key && this.last === view.element && view.element.isConnected) return
    this.shown = view.key
    this.last = view.element
    this.drawer.show(view)
  }
}

/**
 * Stop a just-drawn popover taking focus. driver.js focuses the first thing
 * it can in the popover, synchronously, right after `onPopoverRender`; for a
 * waiting step that would close the menu the person just opened. Each
 * focusable's `focus` is a no-op until the current task has finished.
 */
function holdFocus(elements: Iterable<HTMLElement>): void {
  const held: HTMLElement[] = []
  for (const element of elements) {
    Object.defineProperty(element, 'focus', { value: () => {}, configurable: true, writable: true })
    held.push(element)
  }
  queueMicrotask(() => {
    for (const element of held) delete (element as { focus?: unknown }).focus
  })
}

/** The drawer: driver.js, one popover at a time through `highlight`. */
export function driverDrawer(root: Document = document): Drawer {
  let tour: Driver | null = null
  let settle: ReturnType<typeof setTimeout> | undefined
  const reduced = root.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

  return {
    show(view) {
      tour ??= driver({
        popoverClass: TOUR_CLASS,
        animate: !reduced,
        smoothScroll: !reduced,
        allowClose: true,
        /* Escape and the arrows are the guide's (`onKey`): Escape pauses. */
        allowKeyboardControl: false,
        overlayClickBehavior: 'none',
        overlayColor: 'black',
        overlayOpacity: 0.45,
        stagePadding: 4,
        stageRadius: 8,
        showProgress: false,
      })
      root.documentElement.dataset.tourMode = view.mode
      const buttons: AllowedButtons[] = [...(view.next ? (['next'] as const) : []), ...(view.back ? (['previous'] as const) : []), 'close']
      tour.highlight({
        element: view.element,
        disableActiveInteraction: view.mode === 'show',
        /* A menu opening grows into place: measure again once the move to it
           has finished (a refresh during the move measures the old element). */
        onHighlighted: () => {
          clearTimeout(settle)
          settle = setTimeout(() => tour?.refresh(), 120)
        },
        popover: {
          title: view.title,
          description: view.body,
          side: view.side,
          align: view.align,
          showButtons: buttons,
          nextBtnText: view.next ?? 'Next',
          prevBtnText: 'Back',
          closeBtnLabel: view.gotThis ? 'Pause the tour' : 'Close',
          onNextClick: () => view.onNext(),
          onPrevClick: () => view.onBack(),
          onCloseClick: () => view.onPause(),
          onPopoverRender: (popover) => {
            popover.wrapper.dataset.tourStep = view.key.split(':')[0]
            if (view.progress) {
              /* driver.js leaves the footer's buttons as they were when it
                 hides the footer; shown again for the progress, each is
                 shown only if this view has it. */
              popover.footer.style.display = 'flex'
              popover.progress.style.display = 'block'
              popover.progress.textContent = view.progress
              popover.nextButton.style.display = view.next ? 'block' : 'none'
              popover.previousButton.style.display = view.back ? 'block' : 'none'
            }
            if (view.gotThis) {
              const label = root.createElement('label')
              label.className = 'tour-got-this'
              const box = root.createElement('input')
              box.type = 'checkbox'
              box.dataset.tourGotThis = ''
              box.addEventListener('change', () => {
                if (box.checked) view.onPause()
              })
              const words = root.createElement('span')
              words.textContent = GOT_THIS
              label.append(box, words)
              popover.wrapper.append(label)
            }
            if (view.mode === 'wait') {
              holdFocus([...popover.wrapper.querySelectorAll<HTMLElement>('button, input, a[href]'), view.element])
            }
          },
        },
      })
      /* driver.js puts `driver-active` on the body once, when it starts; it
         is what switches the page's pointer events off. */
      if (view.mode === 'wait') root.body.classList.remove('driver-active')
      else root.body.classList.add('driver-active')
    },
    hide() {
      clearTimeout(settle)
      tour?.destroy()
      tour = null
      delete root.documentElement.dataset.tourMode
    },
  }
}
