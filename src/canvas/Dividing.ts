import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { NOT_GREETED } from '@/host/conversation.ts'
import {
  MAKER,
  PARTS_REF,
  WALK_WITHIN_MS,
  cramped,
  crampedSaid,
  makerOf,
  nextMove,
  unansweredSaid,
  unopenedSaid,
  type Going,
  type Maker,
} from '@/host/dividing.ts'
import { fetchOfficial, installOfficial, type OfficialModule } from '@/host/official.ts'
import type { Presses } from '@/host/presses.ts'

/** How often the official list and the registry are asked again while a module installs. `Modules.tsx`'s number. */
const POLL_MS = 1500

/** How often a walk is tried again while the container's page loads. */
const RETRY_MS = 350

/** How long an installed module may take to appear in the registry before this stops waiting for it. */
const REGISTER_WITHIN_MS = 30_000

/** How long the container a person was sent to stays marked. */
const MARK_FOR_MS = 2600

/**
 * The press that takes a person to where an epic is divided into parts, run
 * to its end.
 *
 * `host/dividing.ts` has the argument and the decisions; this is the half
 * with effects in it. It holds one thing — which epic, on which kehikko,
 * somebody pressed for — and on every change to where Journeys is it asks
 * `nextMove` what to do next and does that one thing: install it, wait for
 * the install, put it on the kehikko, unfold it, walk it. Nothing is
 * scripted ahead; after each step the registry and the kehikko are what they
 * are, and the next step is read off them.
 *
 * ## It stops when the person has gone elsewhere
 *
 * An install takes a minute. A person who pressed for one epic and has since
 * opened another, or another kehikko, did not ask for Journeys to arrive in
 * front of whatever they are looking at now. So the press is FOR an epic and
 * a kehikko, and is dropped the moment either changes. The install itself is
 * not undone — the module is on the computer, which is a fine thing to be
 * true — it is only the putting-in-front that is abandoned.
 *
 * ## Each step is done once
 *
 * A step changes the state this hook reads (a placement appears, a fold
 * opens), which runs the effect again. The guard is `done`: the moves already
 * made for THIS press. Without it a placement that takes two renders to
 * arrive would be asked for twice — harmless for `place`, which is
 * idempotent, and not for `install`.
 *
 * ## The walk is retried, because the page it is sent to is still loading
 *
 * A container put on the kehikko a moment ago has an iframe that has not
 * loaded and a conversation that has not been greeted. `Presses.walk` answers
 * null for the first and the conversation answers `NOT_GREETED` for the
 * second; both mean "not yet" and are tried again, for `WALK_WITHIN_MS`.
 * Anything else the module answers is its answer: found, and the container is
 * scrolled to and marked; or not found, and its own sentence is put in front
 * of the person. See `unopenedSaid` for why it is quoted.
 */
export function useDividing({
  epic,
  canvas,
  registered,
  placements,
  rows,
  presses,
  onPlace,
  onCollapse,
  onLookAgain,
}: {
  /** The open epic, or null. */
  epic: string | null
  /** The open kehikko's id, or null. */
  canvas: number | null
  /** Every module the sweep found. */
  registered: readonly { id: string; name?: string }[]
  /** What is on the open kehikko. */
  placements: readonly { i: string; collapsed?: boolean }[]
  /** The rows the column grants Journeys on the open kehikko, or null when it is not there. See `cramped`. */
  rows: number | null
  presses: Presses
  onPlace(id: string): void
  onCollapse(id: string, collapsed: boolean): void
  /** Sweep the registry again. */
  onLookAgain(): void
}): {
  maker: Maker
  going: Going
  trouble: string | null
  /** The control was opened: find out where Journeys is, if that is not known. */
  ask(): void
  /** The one press. */
  press(): void
} {
  const [official, setOfficial] = useState<OfficialModule[] | null>(null)
  const [unread, setUnread] = useState<string | null>(null)
  const [wanting, setWanting] = useState<{ epic: string; canvas: number } | null>(null)
  const [trouble, setTrouble] = useState<string | null>(null)
  /* Advanced by every poll, so that a poll which changed nothing — the list
     could not be read this time — is still followed by the next one. */
  const [polled, setPolled] = useState(0)
  const done = useRef<{ press: object | null; moves: Set<string>; since: number }>({ press: null, moves: new Set(), since: 0 })

  const maker = useMemo(() => makerOf(registered, placements, official, unread), [registered, placements, official, unread])
  const known = registered.some((one) => one.id === MAKER)

  const read = useCallback(
    () =>
      fetchOfficial().then(
        (got) => {
          setOfficial(got)
          setUnread(null)
        },
        (error: Error) => setUnread(error.message),
      ),
    [],
  )

  const ask = useCallback(() => {
    /* Only when it matters: a Journeys that is registered needs no list. */
    if (!known) void read()
  }, [known, read])

  const press = useCallback(() => {
    if (epic === null || canvas === null) return
    setTrouble(null)
    setWanting({ epic, canvas })
  }, [epic, canvas])

  const move = nextMove(maker)
  const name = maker.name
  /* Through refs: the effect below must re-run when the MOVE changes and not
     when a sweep hands back an equal list in a new array. */
  const act = useRef({ onPlace, onCollapse, onLookAgain, presses, read, rows })
  act.current = { onPlace, onCollapse, onLookAgain, presses, read, rows }

  useEffect(() => {
    if (!wanting) return
    if (wanting.epic !== epic || wanting.canvas !== canvas) {
      setWanting(null)
      return
    }
    if (done.current.press !== wanting) done.current = { press: wanting, moves: new Set(), since: Date.now() }
    const first = (what: string): boolean => {
      if (done.current.moves.has(what)) return false
      done.current.moves.add(what)
      return true
    }

    if (move === 'stop') {
      /* Nothing to press: the install failed, or Journeys cannot be found.
         What the bar says about that is `undividedSaid`'s, off the maker. */
      setWanting(null)
      return
    }
    if (move === 'install') {
      if (!first('install')) return
      void installOfficial(MAKER).then(
        () => act.current.read(),
        (error: Error) => {
          setTrouble(`${name} could not be installed: ${error.message}`)
          setWanting(null)
        },
      )
      return
    }
    if (move === 'wait') {
      if (Date.now() - done.current.since > REGISTER_WITHIN_MS && maker.at === 'looking') {
        setTrouble(`${name} was installed and has not registered itself on this computer yet. Open Kehikko modules to see what it says.`)
        setWanting(null)
        return
      }
      const timer = setTimeout(() => {
        void act.current.read()
        act.current.onLookAgain()
        setPolled((n) => n + 1)
      }, POLL_MS)
      return () => clearTimeout(timer)
    }
    /* From here Journeys is registered, so any wait above is over. */
    done.current.since = Date.now()
    if (move === 'place') {
      if (first('place')) act.current.onPlace(MAKER)
      return
    }
    if (move === 'unfold') {
      if (first('unfold')) act.current.onCollapse(MAKER, false)
      return
    }

    /* `walk`. */
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = Date.now()
    const attempt = async () => {
      if (stopped) return
      const asked = act.current.presses.walk(MAKER, { ref: PARTS_REF, epic: wanting.epic })
      const out = asked ? await asked : null
      if (stopped) return
      if (out?.found) {
        land(MAKER)
        /* Arrived, and in a strip: said, so the bar's entry stays open on the
           sentence instead of closing over a container nobody can work in. */
        if (cramped(act.current.rows)) setTrouble(crampedSaid(name))
        setWanting(null)
        return
      }
      if (out && out.why !== NOT_GREETED) {
        setTrouble(unopenedSaid(name, out.why))
        setWanting(null)
        return
      }
      if (Date.now() - started > WALK_WITHIN_MS) {
        setTrouble(unansweredSaid(name))
        setWanting(null)
        return
      }
      timer = setTimeout(() => void attempt(), RETRY_MS)
    }
    void attempt()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanting, move, maker.at, epic, canvas, name, polled])

  const going: Going = wanting
    ? { epic: wanting.epic, step: move === 'install' || move === 'wait' ? 'installing' : move === 'place' ? 'placing' : 'opening' }
    : null

  return { maker, going, trouble, ask, press }
}

/**
 * Bring the container a person was sent to into view, and mark it.
 *
 * On the element rather than through state, for the reason the Journeys page
 * marks a card that way: it is a fact about one DOM node for two and a half
 * seconds, and routing it through the canvas's state would redraw every
 * container twice to say it. The reflow between removing and adding restarts
 * the animation when the same container is landed on twice.
 */
function land(id: string): void {
  const container = document.querySelector<HTMLElement>(`[data-module="${id}"]`)
  if (!container) return
  container.scrollIntoView({ block: 'nearest' })
  container.removeAttribute('data-landed')
  void container.offsetWidth
  container.setAttribute('data-landed', 'true')
  setTimeout(() => container.removeAttribute('data-landed'), MARK_FOR_MS)
}
