import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { Framing, Rect } from '@/canvas/Frames.tsx'
import {
  ask,
  deadline,
  due,
  finish,
  interactive,
  layoutOf,
  looks,
  pagesHeld,
  seenAt,
  shown,
  slow as isSlow,
  stillCopy,
  step,
  timingFor,
  type Look,
  type Phase,
  type Switch,
} from '@/host/switching.ts'

/**
 * The switch between two kehikot, driven: see `host/switching.ts` for the
 * rule and for what was measured.
 *
 * The page calls `leaving()` BEFORE it changes which kehikko is open, while
 * the one being left is still in the DOM, and this takes the still copy of it
 * and remembers where its pages were seen. From then on every painted frame
 * reads the incoming layout and moves the switch on, until it is `shown`.
 *
 * `ready` is whether the incoming kehikko can be drawn at all — the kehikot
 * have been read and the canvas has a width. Until it is, nothing settles —
 * but the cap runs all the same: `capMs` after the newest press the kehikko
 * is shown and takes input, read or not. A canvas that stayed inert because a
 * reading never came is a canvas nobody can use, and that was once the
 * symptom people saw; see `deadline` in `host/switching.ts`.
 */
export function useCalmSwitch({
  ready,
  framings,
}: {
  ready: boolean
  /** The pages as the page would draw them now, to know where each was seen when a switch begins. */
  framings: readonly Framing[]
}): {
  phase: Phase
  /** Whether a still copy of a kehikko being left is what is on screen. */
  holding: boolean
  /** Whether to say, quietly, that the canvas is being arranged. */
  slow: boolean
  /** Whether the incoming kehikko takes the pointer and the keyboard. */
  interactive: boolean
  /** Whether the pages on screen are the ones being left, held, and take no input. */
  pagesStill: boolean
  incoming: Look
  outgoing: Look
  pages: Look
  /** Where the pages that were seen stay while they are held; `null` when they are not held. */
  seen: ReadonlyMap<string, Rect> | null
  /** Where the pages being left were seen, for the whole hand-over (the underlay); `null` at rest. */
  left: ReadonlyMap<string, Rect> | null
  /** The underlay's two sets of panels: where pages were, and where they are going. */
  underlay: { from: Look; to: Look }
  /** Give the element the incoming grid is drawn in. */
  incomingRef: (element: HTMLElement | null) => void
  /** Give the element the still copy of the outgoing grid is put in. */
  outgoingRef: (element: HTMLElement | null) => void
  /** Call before changing which kehikko (or project) is open. */
  leaving: () => void
  /** Run `then` once the kehikko is shown: at once if it is. */
  whenShown: (then: () => void) => void
} {
  const reduced = useReducedMotion()
  const timing = timingFor(reduced)
  /*
   * The switch itself lives in a ref, and moves on every frame; the page is
   * re-rendered only when what it draws changes — the phase, or what is being
   * left. Counting settled frames in state would re-render the whole canvas
   * once a frame for nothing.
   *
   * The first kehikko of a load is prepared like any other, with nothing to
   * leave.
   */
  const machine = useRef<Switch | null>(null)
  if (machine.current === null) machine.current = ask(shown(now()), now(), false)
  const stateRef = machine as { current: Switch }
  const [state, setState] = useState<Switch>(stateRef.current)
  const move = useCallback((next: Switch) => {
    const was = stateRef.current
    stateRef.current = next
    if (next.phase !== was.phase || next.asked !== was.asked || next.pressed !== was.pressed || next.outgoing !== was.outgoing) setState(next)
  }, [stateRef])
  const [slow, setSlow] = useState(false)

  const incoming = useRef<HTMLElement | null>(null)
  const outgoing = useRef<HTMLElement | null>(null)
  const seen = useRef<Map<string, Rect> | null>(null)
  const framingsRef = useRef(framings)
  framingsRef.current = framings
  const readyRef = useRef(ready)
  readyRef.current = ready
  const waiting = useRef<Array<() => void>>([])

  const incomingRef = useCallback((element: HTMLElement | null) => {
    incoming.current = element
  }, [])
  const outgoingRef = useCallback((element: HTMLElement | null) => {
    outgoing.current = element
  }, [])

  const clear = useCallback(() => {
    outgoing.current?.replaceChildren()
    seen.current = null
  }, [])

  const leaving = useCallback(() => {
    /* The press is now, before the still copy is made: the cap counts from the press, and copying
       a whole kehikko's grid is part of the switch it caps, not time before it. */
    const pressedAt = now()
    const was = stateRef.current
    /* Already preparing: what is on screen is already the kehikko being left,
       and the newest press is what will be waited for. */
    if (was.phase === 'preparing') {
      move(ask(was, pressedAt, false))
      return
    }
    /* Mid-fade: the fade is finished at once, and what is now on screen is
       what is left. */
    clear()
    const grid = incoming.current?.querySelector('.react-grid-layout') ?? null
    const host = outgoing.current
    if (grid && host) host.replaceChildren(stillCopy(grid))
    seen.current = grid && host ? seenAt(framingsRef.current) : null
    move(ask(stateRef.current, pressedAt, grid !== null && host !== null))
  }, [clear, move, stateRef])

  /* Every painted frame while a switch is under way, and a timer for when no
     frame will be painted (a hidden tab): read the layout, move the switch on. */
  const phase = state.phase
  useLayoutEffect(() => {
    if (phase === 'shown') return
    /* A fade is timed from when it is DRAWN, which is now, after the commit —
       not from the frame that decided on it. A render between the two (a
       heavy one: a whole kehikko) would otherwise eat the fade, and the pages
       would be moved while they could still be seen. */
    if (phase === 'leaving' || phase === 'arriving') stateRef.current = { ...stateRef.current, since: now() }
    let frame = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = () => {
      const layout = readyRef.current ? (layoutOf(incoming.current) ?? '') : null
      const next = step(stateRef.current, now(), layout, timing)
      move(next)
      /* A new phase is a new run of this effect, which schedules its own. */
      if (next.phase === phase) schedule()
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      frame = requestAnimationFrame(tick)
      const wait = due(stateRef.current, now(), timing)
      if (wait !== null) timer = setTimeout(tick, wait + 20)
    }
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [phase, timing, move, stateRef])

  /* The hard ceiling, on a timer of its own: whatever the frames and the
     layout readings did, the switch is over by `deadline`, the canvas takes
     input, and whatever waited for it runs. */
  const pressed = state.pressed
  useEffect(() => {
    if (phase === 'shown') return
    const timer = setTimeout(() => move(finish(stateRef.current, now())), Math.max(0, deadline(stateRef.current, timing) - now()) + 40)
    return () => clearTimeout(timer)
  }, [phase, pressed, timing, move, stateRef])

  /* The quiet word, only for a switch slower than `slowMs`. */
  const asked = state.asked
  useEffect(() => {
    if (phase !== 'preparing') {
      setSlow(false)
      return
    }
    const left = asked + timing.slowMs - now()
    const timer = setTimeout(() => setSlow(isSlow(stateRef.current, now(), timing)), Math.max(0, left))
    return () => clearTimeout(timer)
  }, [phase, asked, timing, stateRef])

  /* Shown: the copy goes, the pages are released, and whatever waited for it runs. */
  useLayoutEffect(() => {
    if (phase !== 'shown') return
    clear()
    const queued = waiting.current
    waiting.current = []
    for (const then of queued) then()
  }, [phase, clear])

  const whenShown = useCallback((then: () => void) => {
    if (stateRef.current.phase === 'shown') then()
    else waiting.current.push(then)
  }, [stateRef])

  const look = looks(state, timing)
  return {
    phase,
    holding: pagesHeld(phase) && state.outgoing,
    slow,
    interactive: interactive(phase),
    pagesStill: pagesHeld(phase),
    incoming: look.incoming,
    outgoing: look.outgoing,
    pages: look.pages,
    seen: pagesHeld(phase) ? seen.current : null,
    left: phase === 'shown' ? null : seen.current,
    underlay: look.underlay,
    incomingRef,
    outgoingRef,
    leaving,
    whenShown,
  }
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

/** `prefers-reduced-motion: reduce`, followed as it changes. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => motionQuery()?.matches ?? false)
  useEffect(() => {
    const query = motionQuery()
    if (!query) return
    const changed = () => setReduced(query.matches)
    query.addEventListener?.('change', changed)
    return () => query.removeEventListener?.('change', changed)
  }, [])
  return reduced
}

function motionQuery(): MediaQueryList | null {
  return typeof window === 'undefined' || !window.matchMedia ? null : window.matchMedia('(prefers-reduced-motion: reduce)')
}
