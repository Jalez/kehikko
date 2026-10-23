import type { CSSProperties } from 'react'

import type { Framing, Rect } from '@/canvas/Frames.tsx'

/**
 * Switching kehikko, or project, without the fidget.
 *
 * ## What the person saw
 *
 * "The app fidgeting every time we change to a new kehikko/project … I'd
 * rather not see that." Measured on a scratch host with `dev/calm-switch.drive.mjs`,
 * which records where every container and every page is drawn on every
 * painted frame, a switch between two kept kehikot moved 7–11 visible things
 * in the 60 ms after the press, every time, and a first visit moved up to 88.
 * The causes, with what each contributed:
 *
 *   - **The grid was born 1280 pixels wide.** It is keyed by kehikko, so every
 *     switch is a new grid, and `WidthProvider` renders a new grid at its
 *     default width before it measures. Every container was drawn once in the
 *     wrong column and at the wrong width (40–120 px off at 1400) and moved a
 *     frame later: 3–6 moves per switch, on every switch.
 *   - **The pages trailed the containers by a frame.** They are positioned from
 *     measurements, and the correction above reached them one observation
 *     later, so each visible page moved twice: 3–6 moves per switch.
 *   - **The grid's own transitions.** react-grid-layout places a new item with
 *     `top`/`left` and then, once mounted, with `transform`, and its stylesheet
 *     transitions `transform`: unhidden, every container slides 200 ms in from
 *     the top left corner (38–47 moves per switch, measured by turning the
 *     old fixed `settling` window off). That window hid it for 250 ms and
 *     animated everything after — which is how a module's height report became
 *     a 200 ms grow-and-squeeze of its column (the next cause).
 *   - **Heights from a module's wish.** A container that follows its module's
 *     height grows when the module first reports, 300–500 ms after the switch:
 *     ~70 moves on a first visit, animated, with its neighbour squeezed. Once
 *     the wish is stored it is drawn at once, and this is 0.
 *   - **The project's epics being read again.** On a project switch the epic
 *     control said "reading epics…" for about 40 ms, a different width, and
 *     everything after it in the bar moved and moved back: 2–5 moves.
 *   - Compaction after load, fonts, and the canvas's own size: 0. The host
 *     stores arrangements already compacted (`laid`), the fonts are the
 *     system's, and the bar is one fixed row.
 *   - The kept frames (`Frames.tsx`) do not fidget themselves: a kept page is
 *     drawn at once rather than loading, which is why a second visit has no
 *     pop-in. A kept page that is on both kehikot is one of the pages that
 *     moved twice above.
 *
 * ## What is done about it
 *
 * The grid is told its width, so it is never born at the wrong one; layout the
 * person did not cause is not animated (`in-motion` in `index.css`); the grid
 * is handed the arrangement its stored wishes give (`arranged` in
 * `columns.ts`). And what is left is hidden: the kehikko being left stays on
 * screen, as a still copy of its chrome over its own pages held where they
 * were, while the one arriving is drawn underneath, invisible and inert, at its
 * final size. When its layout has not changed for `settledFrames` painted
 * frames — or after `capMs`, whichever is first — the two cross: the old chrome
 * fades out while the new fades in, and the pages fade through, out at their
 * old places and in at their new ones. A page cannot be in two places — it is
 * one document (`Frames.tsx`) — so the pages fade THROUGH where the chrome
 * fades ACROSS.
 *
 * This file is the rule, with nothing in it that touches a page: the phases, how
 * a frame moves them on, what each layer looks like in each, and which pages
 * are held where they were. `canvas/useCalmSwitch.ts` drives it.
 */

/**
 * Where a switch is.
 *
 * `preparing` — the incoming kehikko is drawn but not shown; the outgoing one
 * is on screen, still. `leaving` — settled; the outgoing chrome and pages fade
 * out, the incoming chrome fades in. `arriving` — the pages are released to
 * their new places and fade in. `shown` — nothing is happening.
 */
export type Phase = 'preparing' | 'leaving' | 'arriving' | 'shown'

export interface Timing {
  /** How many painted frames in a row the incoming layout must be unchanged to count as settled. */
  settledFrames: number
  /**
   * The longest the incoming kehikko is held back after the newest press,
   * settled or not, drawn or not. A ceiling and not a guess: past it the
   * kehikko is shown and takes the pointer whatever the layout says, so no
   * reading of the page (a layout that never reads, a frame never painted, a
   * window the system has stopped painting) can leave a canvas inert.
   */
  capMs: number
  /** How long the outgoing kehikko takes to fade. */
  leaveMs: number
  /** How long the incoming pages take to fade in, after the outgoing ones have gone. */
  arriveMs: number
  /** After this long without being shown, a quiet word says the canvas is being arranged. */
  slowMs: number
  /** How far what is being left is blurred as it fades out, in pixels. 0: no blur. */
  blurOutPx: number
  /** How blurred the incoming chrome starts as it fades in, in pixels. 0: no blur. */
  blurInPx: number
}

/**
 * About 200 ms, the chrome crossing in one movement over the whole of it, the
 * view being left blurring a little as it goes and the one arriving coming
 * into focus. Short enough that a switch feels like a switch and not like a
 * page loading; long enough that nothing is seen to jump.
 *
 * The blur is only ever on what takes no input: the still copy of the chrome
 * being left, the pages being left while they are held (`pagesHeld`, the
 * pointer off), and the incoming chrome before it is shown. The pages
 * arriving are never blurred — they take input the moment they are shown,
 * and a person about to click one sees it sharp.
 */
export const TIMING: Timing = { settledFrames: 2, capMs: 300, leaveMs: 90, arriveMs: 110, slowMs: 400, blurOutPx: 6, blurInPx: 4 }

/**
 * `prefers-reduced-motion`: the same waiting — nothing is shown before it has
 * settled — and a plain, short crossfade: opacity only, no blur, nothing that
 * moves or comes into focus.
 */
export const STILL: Timing = { ...TIMING, leaveMs: 50, arriveMs: 70, blurOutPx: 0, blurInPx: 0 }

/** One painted frame, roughly, at 60 Hz. */
const FRAME_MS = 20

export function timingFor(reduced: boolean): Timing {
  return reduced ? STILL : TIMING
}

export interface Switch {
  phase: Phase
  /** When the switch was asked for: what `slowMs` counts from. */
  asked: number
  /** When the newest press was: what `capMs` counts from. A second press while preparing moves it. */
  pressed: number
  /** When the incoming kehikko was first seen drawn, `null` until it has been. */
  drawn: number | null
  /** When the phase began. */
  since: number
  /** The incoming layout as last read, and for how many frames after that it has been the same. */
  last: string | null
  still: number
  /** Whether a kehikko is on screen to be left — false for the first one a page draws. */
  outgoing: boolean
}

/** Nothing happening: the state a page has once it has shown a kehikko. */
export function shown(now: number): Switch {
  return { phase: 'shown', asked: now, pressed: now, drawn: null, since: now, last: null, still: 0, outgoing: false }
}

/**
 * A switch asked for. `outgoing` is whether there is a kehikko on screen to
 * keep while the next is prepared. Asked again while preparing — a second
 * press before the first had shown — it waits for the newest, keeps what is
 * on screen, and keeps counting the slowness from the first press.
 */
export function ask(state: Switch, now: number, outgoing: boolean): Switch {
  if (state.phase === 'preparing') return { ...state, pressed: now, drawn: null, last: null, still: 0, outgoing: state.outgoing || outgoing }
  return { phase: 'preparing', asked: now, pressed: now, drawn: null, since: now, last: null, still: 0, outgoing }
}

/**
 * One painted frame, with the incoming layout as read on it — `null` when it
 * cannot be read yet (the kehikot are still being fetched, the canvas has no
 * width), which does not settle it. Nothing stops the cap: `capMs` after the
 * newest press the kehikko moves on, read or not.
 */
export function step(state: Switch, now: number, layout: string | null, timing: Timing = TIMING): Switch {
  switch (state.phase) {
    case 'shown':
      return state
    case 'preparing': {
      let next: Switch = state
      if (layout === null) next = state
      else if (state.drawn === null) next = { ...state, drawn: now, last: layout, still: 0 }
      else if (layout === state.last) next = { ...state, still: state.still + 1 }
      else next = { ...state, last: layout, still: 0 }
      const settled = next.still >= timing.settledFrames || now - next.pressed >= preparingMs(next, timing)
      return settled ? after(next, 'preparing', now, timing) : next
    }
    case 'leaving':
      return now - state.since >= timing.leaveMs ? after(state, 'leaving', now, timing) : state
    case 'arriving':
      return now - state.since >= timing.arriveMs ? after(state, 'arriving', now, timing) : state
  }
}

/** The phase after `from`, skipping one that has nothing to do (nothing to leave, no time to fade). */
function after(state: Switch, from: Phase, now: number, timing: Timing): Switch {
  const order: Phase[] = ['preparing', 'leaving', 'arriving', 'shown']
  for (let at = order.indexOf(from) + 1; at < order.length; at += 1) {
    const phase = order[at]!
    if (phase === 'leaving' && (!state.outgoing || timing.leaveMs <= 0)) continue
    if (phase === 'arriving' && timing.arriveMs <= 0) continue
    return { ...state, phase, since: now }
  }
  return state
}

/**
 * How long until something should be looked at again even if no frame is
 * painted — a hidden tab paints none, and a switch made in one must still
 * end. `null` when nothing is waiting on time.
 */
export function due(state: Switch, now: number, timing: Timing = TIMING): number | null {
  switch (state.phase) {
    case 'shown':
      return null
    case 'preparing':
      return Math.max(0, state.pressed + preparingMs(state, timing) - now)
    case 'leaving':
      return Math.max(0, state.since + timing.leaveMs - now)
    case 'arriving':
      return Math.max(0, state.since + timing.arriveMs - now)
  }
}

/** Whether to say the canvas is being arranged: preparing, and for longer than `slowMs` since the press. */
export function slow(state: Switch, now: number, timing: Timing = TIMING): boolean {
  return state.phase === 'preparing' && now - state.asked >= timing.slowMs
}

/** Whether the pages are held where they were on the kehikko being left. */
export function pagesHeld(phase: Phase): boolean {
  return phase === 'preparing' || phase === 'leaving'
}

/**
 * Whether the incoming kehikko takes the pointer and the keyboard: from the
 * moment it starts being shown, which is at most `preparingMs` after the
 * newest press. Its pages wait for `pagesHeld` to end as well — until then the pages
 * on screen are the ones being left.
 */
export function interactive(phase: Phase): boolean {
  return phase !== 'preparing'
}

/**
 * The latest a switch may still be under way, from its newest press: the cap
 * and both fades. `useCalmSwitch` holds a timer to it of its own, apart from
 * the frames and from `step`, and shows the kehikko when it fires — so a
 * driver that stopped (an effect that threw, a frame never painted) cannot
 * leave the canvas inert either.
 */
export function deadline(state: Switch, timing: Timing = TIMING): number {
  return state.pressed + timing.capMs + timing.arriveMs
}

/**
 * The longest a switch prepares, from the newest press: the cap, less the
 * fade out when there is something to fade out. So the pages being left are
 * released — to their new places, and to the context they are now told —
 * by `capMs` after the press whatever happened, and the incoming chrome takes
 * input before that. On an epic switch that is how long a module waits for
 * its new epic, at most.
 */
export function preparingMs(state: Pick<Switch, 'outgoing'>, timing: Timing = TIMING): number {
  return timing.capMs - (state.outgoing ? timing.leaveMs : 0)
}

/** The switch ended where it stands: shown, and taking input. */
export function finish(state: Switch, now: number): Switch {
  return state.phase === 'shown' ? state : { ...state, phase: 'shown', since: now }
}

/**
 * One layer's opacity, how long it takes to get there (`ms: 0` is no
 * transition), and the curve. The pages leave on `ease-in` and arrive on
 * `ease-out` — they stay up as long as they can and come back as soon as they
 * can — so the moment with no page on screen is as short as it can be. The
 * chrome crosses on `ease-in-out`.
 */
export interface Look {
  opacity: number
  ms: number
  easing?: 'ease-in' | 'ease-out' | 'ease-in-out'
  /**
   * A blur in pixels, animated over the same `ms` as the opacity. Absent: no
   * filter at all — not `blur(0)`, which still makes the layer a compositing
   * group and a containing block for anything fixed inside it.
   */
  blur?: number
}

/**
 * What each layer looks like in a phase: the incoming grid, the still copy of
 * the outgoing one, and the pages.
 *
 * The chrome crosses in ONE movement over `leaveMs + arriveMs`, starting when
 * the layout settles. The pages cannot cross — each is one document — so they
 * fade out where they were over `leaveMs` and in where they are over
 * `arriveMs`. With no outgoing kehikko (the first one drawn) the incoming
 * pages are not shown before the chrome is, so nothing appears in an empty box.
 *
 * Fading THROUGH leaves a moment with neither page on screen, and the
 * containers' bodies are hollow: that moment showed the canvas through every
 * body — in a dark theme a black frame in the middle of every switch,
 * measured at a tenth of the brightness either side of it
 * (`dev/switch-frames.drive.mjs`). So under the pages, for the hand-over
 * only, the underlay draws a plain panel in the card colour at each place a
 * page was (`from`) and is going (`to`): the page being left blurs out into
 * a panel, and the page arriving fades in over one. Between the containers
 * the canvas stays as it is.
 */
export function looks(
  state: Switch,
  timing: Timing = TIMING,
): { incoming: Look; outgoing: Look; pages: Look; underlay: { from: Look; to: Look } } {
  const cross = (state.outgoing ? timing.leaveMs : 0) + timing.arriveMs
  /* A blur of 0 is said as no blur, so reduced motion carries no filter. */
  const blur = (px: number) => (px > 0 ? { blur: px } : {})
  const sharp = (px: number) => (px > 0 ? { blur: 0 } : {})
  switch (state.phase) {
    case 'preparing':
      return {
        incoming: { opacity: 0, ms: 0, ...blur(timing.blurInPx) },
        outgoing: { opacity: 1, ms: 0, ...sharp(timing.blurOutPx) },
        pages: { opacity: state.outgoing ? 1 : 0, ms: 0, ...(state.outgoing ? sharp(timing.blurOutPx) : {}) },
        underlay: { from: { opacity: 1, ms: 0 }, to: { opacity: 0, ms: 0 } },
      }
    case 'leaving':
      /* The pages' fade ends a frame before the phase does, so they are gone
         — not nearly gone — when they are moved. They are held, and take no
         input, so they may blur as they go. */
      return {
        incoming: { opacity: 1, ms: cross, easing: 'ease-in-out', ...sharp(timing.blurInPx) },
        outgoing: { opacity: 0, ms: cross, easing: 'ease-in-out', ...blur(timing.blurOutPx) },
        pages: { opacity: 0, ms: Math.max(0, timing.leaveMs - FRAME_MS), easing: 'ease-in', ...blur(timing.blurOutPx) },
        underlay: { from: { opacity: 1, ms: 0 }, to: { opacity: 1, ms: timing.leaveMs, easing: 'ease-out' } },
      }
    case 'arriving':
      /* The pages are live from here: never a filter on them. */
      return {
        incoming: { opacity: 1, ms: state.outgoing ? cross : timing.arriveMs, easing: 'ease-in-out', ...sharp(timing.blurInPx) },
        outgoing: { opacity: 0, ms: cross, easing: 'ease-in-out', ...blur(timing.blurOutPx) },
        pages: { opacity: 1, ms: timing.arriveMs, easing: 'ease-out' },
        underlay: { from: { opacity: 0, ms: timing.arriveMs, easing: 'ease-in' }, to: { opacity: 1, ms: 0 } },
      }
    case 'shown':
      return {
        incoming: { opacity: 1, ms: 0 },
        outgoing: { opacity: 0, ms: 0 },
        pages: { opacity: 1, ms: 0 },
        underlay: { from: { opacity: 0, ms: 0 }, to: { opacity: 0, ms: 0 } },
      }
  }
}

/**
 * A layer's opacity and blur, and the fade to them, as a style.
 *
 * No blur is NO `filter` — not `blur(0)` — and there is never a
 * `will-change`: a layer that keeps a filter, even an identity one, is drawn
 * as a group of its own, and WebKit may go on showing it from a raster of
 * lower resolution than the screen. At rest every layer is plain.
 */
export function layerStyle(look: Look): CSSProperties {
  const easing = look.easing ?? 'ease'
  const blurred = look.blur !== undefined
  return {
    opacity: look.opacity,
    ...(blurred ? { filter: `blur(${look.blur}px)` } : {}),
    transition: look.ms
      ? blurred
        ? `opacity ${look.ms}ms ${easing}, filter ${look.ms}ms ${easing}`
        : `opacity ${look.ms}ms ${easing}`
      : 'none',
  }
}

/**
 * Where each page was SEEN on the kehikko being left: the pages that were
 * shown and placed, by module. A page that was hidden is not here, and is
 * free to be resized for where it is going while nobody can see it.
 */
export function seenAt(framings: readonly Framing[]): Map<string, Rect> {
  const seen = new Map<string, Rect>()
  for (const one of framings) if (one.shown && one.rect) seen.set(one.module.id, one.rect)
  return seen
}

/**
 * The pages as drawn while they are held: each one that was seen stays where
 * it was, and every other one is hidden — at its NEW place, so it is laid out
 * at its final size before it is shown. Everything else about a page (its
 * context, its filters, whether it is away) is the live one: only where it is
 * drawn waits.
 */
export function held(framings: readonly Framing[], seen: ReadonlyMap<string, Rect> | null): readonly Framing[] {
  if (!seen) return framings
  return framings.map((one) => {
    const was = seen.get(one.module.id)
    return was ? { ...one, rect: was, shown: true } : { ...one, shown: false }
  })
}

/**
 * The layout of the incoming kehikko as one string: where every container's
 * body is, and how tall the grid is. Two frames with the same string are two
 * frames in which nothing moved.
 */
export function layoutOf(root: ParentNode | null): string | null {
  if (!root) return null
  const parts: string[] = []
  for (const body of root.querySelectorAll<HTMLElement>('[data-body]')) {
    const box = body.getBoundingClientRect()
    parts.push(`${body.dataset.body}:${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.width)},${Math.round(box.height)}`)
  }
  return parts.join(' ')
}

/** The attributes a still copy must not carry: ids, and every hook something else finds a container by. */
const NOT_COPIED = ['id', 'data-module', 'data-body', 'data-tour', 'data-frame', 'data-activity-flash', 'data-start-layout']

/**
 * A still copy of the kehikko being left, to keep on screen while the next is
 * prepared. Its chrome only — the pages are not inside the grid — so the
 * pages held where they were show through its hollow bodies as they did
 * through the real ones.
 *
 * It is a picture, not a second canvas: `inert` and hidden from readers, so
 * nothing in it takes a click, a Tab or a screen reader's attention, and
 * stripped of ids and of every attribute something else looks a container up
 * by — the tour's stops, the Inbox's go-to-place, the corner handles' owners
 * — so nothing finds the copy instead of the real one.
 */
export function stillCopy(grid: Element): HTMLElement {
  const copy = grid.cloneNode(true) as HTMLElement
  for (const element of [copy, ...copy.querySelectorAll('*')]) {
    for (const name of NOT_COPIED) element.removeAttribute(name)
  }
  copy.setAttribute('data-outgoing', '')
  copy.setAttribute('aria-hidden', 'true')
  copy.setAttribute('inert', '')
  copy.classList.remove('in-motion')
  return copy
}

/**
 * Whether the change from `before` to `after` folds or unfolds a container
 * that is in both: what the grid animates whoever asked for it. Anything else
 * that changed with it — the heights its column-mates are granted — is part
 * of the same fold and glides with it.
 */
export function foldsOnlyChanged(
  before: readonly { i: string; collapsed?: boolean }[],
  after: readonly { i: string; collapsed?: boolean }[],
): boolean {
  const was = new Map(before.map((one) => [one.i, one.collapsed ?? false]))
  return after.some((one) => was.has(one.i) && was.get(one.i) !== (one.collapsed ?? false))
}
