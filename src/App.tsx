import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Responsive, WidthProvider, type Layout } from 'react-grid-layout'
import { REFRESH_EVERY_MAX, REFRESH_EVERY_MIN, own } from 'roadmap-module-protocol'
import type { FilterChoice, FilterGroup, ModuleCondition, Passage, Showing } from 'roadmap-module-protocol'

import { Bar } from './canvas/Bar.tsx'
import { Footer } from './canvas/Footer.tsx'
import { Frames, type Framing } from './canvas/Frames.tsx'
import { Picking } from './canvas/Picking.tsx'
import { Prompts } from './canvas/Prompts.tsx'
import { ToolsDialog } from './canvas/Tools.tsx'
import { Container } from './canvas/Container.tsx'
import { Missing } from './canvas/Missing.tsx'
import type { CanvasControls } from './host/ask.ts'
import { EventBus } from './host/events.ts'
import { Presses } from './host/presses.ts'
import {
  chooseOpen,
  COLUMNS,
  createCanvas,
  editCanvas,
  everyPlaced,
  fetchCanvases,
  inProject,
  place,
  promptFor,
  readOpen,
  removeCanvas,
  reportOpen,
  unplace,
  watchCanvases,
  writeOpen,
  type Canvas,
  type Placement,
} from './host/canvases.ts'
import type { ConversationWatcher } from './host/conversation.ts'
import {
  addProject,
  chooseProject,
  createEpic,
  fetchEpics,
  fetchProjects,
  forgetProject,
  retitleEpic,
  shareProject,
  readOpenProject,
  writeOpenProject,
  type Epics as HeldEpics,
  type Project,
} from './host/projects.ts'
import { containersKey, containersOf } from '@/host/showing.ts'
import { toWireContext, type Subject } from './host/context.ts'
/* `settle` is imported under another name: this file already has a `settle`,
   which is the measuring pass after a grid animation, and two of them would be
   one of the least readable name collisions available. */
import { chosen, sameChoice, settle as settleFilters } from './host/filters.ts'
import type { Filtered, Picked } from './host/ask.ts'
import { useRects } from './host/rects.ts'
import { fetchRegistry, type Presence, type RegistryView } from './host/registry.ts'
import { isNotAnswering, notAnswering } from './host/reachable.ts'
import { dragged, granted, mostFor, wishing } from './host/columns.ts'
import { CANVAS_ROWS, rowHeightFor } from './host/fit.ts'
import { applyFocus, focused, otherFocus, type Focus } from './host/focus.ts'
import { apply, current, other, type Theme } from './host/theme.ts'
import { Writer } from './host/writer.ts'

/**
 * The canvas.
 *
 * A black surface with modules on it, and above it one hairline strip that is
 * the whole of the host's own interface. There is nothing else, and the absence
 * is the design: this program holds no data about anybody's work, so it has
 * nothing to put on a dashboard; it installs nothing, so it has no marketplace;
 * it updates nothing, so it has no news. What it has is other people's
 * programs, arranged the way one person wanted them.
 *
 * ## Where the arrangement lives
 *
 * On the server, in a small database — see the essay in `server/canvases.ts`
 * for what changed and why. This component is the optimistic side of that: an
 * edit lands in local state immediately and is written a beat later by
 * `Writer`, because a canvas that waited for a round trip before showing a container
 * where it was dropped would feel broken on a machine that is not busy at all.
 */

const Grid = WidthProvider(Responsive)

/**
 * `measureBeforeMount`, and why it is off.
 *
 * It is tempting, and it was on for an hour. `WidthProvider` renders once at a
 * hardcoded default of 1280 pixels, measures the element it rendered into, and
 * renders again with the real width — so the first paint of every load places
 * the containers with the wrong column width. `measureBeforeMount` is the library's
 * own answer: render nothing until the measurement exists.
 *
 * With it on, the measurement never arrives. The grid stays at 1280 for the
 * life of the page, on a canvas of any other width, and the damage is not a
 * subtle misalignment — column six lands at four pixels instead of seven
 * hundred, so a container placed beside another is drawn on top of it, and a container
 * cannot be dragged to a column that is not where it appears to be. Widths
 * computed from `1280` and positions from a container of some other size do not
 * merely look wrong, they make the grid unusable.
 *
 * The reposition-on-reload it was brought in to fix had a different cause
 * entirely — the height feedback loop described on `onHeight` — and fixing that
 * fixed the symptom. So this stays off, and the one frame at the default width
 * stays, which is a frame nobody has ever mentioned seeing.
 */
const MEASURE_FIRST = false

/*
 * Grid geometry. The gaps, and only the gaps.
 *
 * There is no `ROW_HEIGHT` here any more. A row is not a size this file
 * chooses; it is `room / CANVAS_ROWS`, decided in `fit.ts` for the same reason
 * a column is `room / 12` — see the essay there, and the two wrong answers it
 * records. What is left in this constant is the one piece of vertical geometry
 * that really is fixed: the eight pixels of air between rows, above the first
 * and below the last, which the fit has to subtract before it divides.
 */
const MARGIN: [number, number] = [8, 8]

/* How tall a folded container is, in grid rows, is `FOLDED_ROWS` in
   `host/columns.ts`, beside the floor a neighbour may be squeezed to — the two
   are one judgement seen from two sides, and the essay is there. */

/**
 * What the canvas currently believes about one module, which is not always what
 * the server last said.
 *
 * The server establishes a condition by asking for a manifest. The frame
 * establishes one by being greeted and answering — or not. Both are true
 * observations of the same program at different moments, and the later one
 * wins: a module whose manifest answered and whose page then said nothing is
 * silent, whatever the sweep concluded thirty seconds ago.
 */
interface Live {
  condition: ModuleCondition
  /**
   * The sentence the conversation itself produced, or `null` when it has not
   * produced one — a module that simply answered has nothing to say about
   * itself, and the container falls back to what discovery wrote.
   *
   * Null rather than an empty string, because an empty string is a sentence as
   * far as `??` is concerned, and the container would show nothing where it meant to
   * show the server's line.
   */
  line: string | null
  fault: string | null
  /**
   * What this module last said it can be narrowed by, or nothing.
   *
   * Here rather than in the arrangement, and the split is the point: the OFFER
   * belongs to a running program and dies with it, while the CHOICE belongs to
   * a container on a canvas and outlives everything — see `filters` on the
   * placement schema. A module that is stopped stops offering, its control
   * disappears, and what somebody chose is still in the database waiting for it
   * to come back.
   *
   * Absent for every module that has never said anything, which is almost all
   * of them, and absence is what draws no control at all.
   */
  filters?: FilterGroup[]
  /**
   * What this module last said could be cleared of what it is showing, in its
   * own words — or `null`, which is the module saying there is nothing on
   * screen to clear right now.
   *
   * Here beside the filter offer and for the same reason: it belongs to a
   * running program and dies with it. Unlike the filter, there is no matching
   * CHOICE stored anywhere, because there is nothing to remember — a press is
   * an event, not a state, and a container does not carry "somebody once
   * cleared this" from one day to the next.
   *
   * Three values and they are three different things. Absent is a module that
   * has never said anything, which is almost all of them and draws no control.
   * `null` is a module that HAS said something and is currently offering
   * nothing, which also draws no control but arrived there deliberately. A
   * string is an offer. The host draws the same nothing for the first two, and
   * the distinction is kept because `Live` is what a person reads when working
   * out why a control is missing.
   */
  clear?: string | null
  /**
   * What this module last said about being refreshed, or nothing.
   *
   * The third offer, held here beside the other two and for the same reason:
   * all three belong to a running program and die with it, while what a person
   * chose about the container outlives everything. For the filter that split is
   * offer-here / choice-in-the-placement; for this it is state-here /
   * INTERVAL-in-the-placement, which is the same split with different words.
   *
   * `at` is the part that could not have come from anywhere else. This host
   * knows when it asked; it does not know whether the module answered out of a
   * cache, whether the read failed over a reading still on screen, or whether
   * the module refreshed itself for a reason nothing here can see. So the
   * module says, and `null` — "I cannot say" — draws no time rather than a
   * guess.
   *
   * Absent for every module that has never mentioned the idea, which is almost
   * all of them, and absence draws no control at all.
   */
  refresh?: { can: boolean; at: string | null; busy: boolean }
}

/**
 * How long after a sweep the canvas stops re-sweeping on focus.
 *
 * Three seconds, and the number is chosen for one behaviour: a person moving
 * between an editor and the canvas and back again in the same breath. Without a
 * floor, every one of those passes is another round of manifest requests to
 * every registered program, none of which can have changed in the second since
 * the last round. It is deliberately short — long enough to absorb a flurry of
 * window switching, far too short to make "I just started a module" wait.
 */
const QUIET_BETWEEN_SWEEPS_MS = 3000

/**
 * How long the page waits before looking again while its own server is silent.
 *
 * ## Why this is not the polling loop this host refuses everywhere else
 *
 * `look` is deliberately tied to attention — see the essay on the focus sweep
 * below — because a sweep is N requests to N programs and paying for it while
 * nobody is looking is paying for nothing. This is the one case that rule gets
 * wrong, and it is wrong for the reason `server/wake.ts` was written about: the
 * moment worth catching is a person SITTING and WATCHING while something
 * changes underneath them. `run.sh` now starts the API again a second or two
 * after it dies, and without this the canvas would go on saying the server is
 * not answering until they happened to alt-tab away and back — a fault that has
 * already fixed itself, still on screen, which is exactly as misleading as a
 * fault that has not.
 *
 * Three properties keep it from becoming the request-per-tick this host argues
 * against. It runs ONLY while the host's own server is silent, which is
 * normally never. It DOUBLES to half a minute, so a host left broken overnight
 * makes a couple of requests a minute rather than thousands. And it stops while
 * the tab is not visible, which is the focus sweep's own argument: nobody is
 * reading the line, so nothing is gained by clearing it.
 */
const FIRST_RETRY_MS = 2000
const LONGEST_RETRY_MS = 30_000

export function App() {
  const [registry, setRegistry] = useState<RegistryView | null>(null)
  const [trouble, setTrouble] = useState<string | null>(null)
  const [looking, setLooking] = useState(true)
  const [canvases, setCanvases] = useState<Canvas[]>([])
  const [openId, setOpenId] = useState<number | null>(null)
  /**
   * The projects, and which one is open.
   *
   * Every canvas from every project is held in `canvases`; this is what the
   * header shows a slice of. Keeping the whole set is what makes switching
   * project free — see `fetchCanvases`, and `Frames.tsx` on why a module's page
   * must outlive the container that asked for it.
   */
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<number | null>(null)
  /**
   * What the open project holds, or null while it is being read.
   *
   * Null is "not known yet" and is not the same as `{ holds: false }`, which is
   * "this project has no data/epics". The epic picker draws a different
   * sentence for each — see `Epics.tsx` — because an empty box is what a
   * project with none and a read that failed both look like.
   */
  const [held, setHeld] = useState<HeldEpics | null>(null)
  const [live, setLive] = useState<Record<string, Live>>({})
  /* Which container is being dragged or resized, if any — see `Frames.tsx` for why
     the pages stop taking the pointer for the duration, and why the one under
     the hand is hidden rather than chased. */
  const [moving, setMoving] = useState<string | null>(null)
  /* The container whose corner a hand is on, from `onResizeStart` until
     `onLayoutChange` reads it on release. A ref and not state, because it is
     read inside a callback the grid calls synchronously on release, before any
     render could have delivered a state update. See `onLayoutChange`. */
  const resized = useRef<string | null>(null)
  /* Read from the document rather than worked out again. The blocking script in
     `index.html` already decided this before anything was painted, and a second
     implementation of that decision is a second thing that can be wrong — see
     `host/theme.ts`. */
  const [theme, setTheme] = useState<Theme>(() => current())
  /* Whether the container headers are out of the layout. Read from the document for
     the same reason the theme is: a blocking script in `index.html` already
     decided this before anything was painted, and a second implementation of
     that decision is a second thing that can be wrong. See `host/focus.ts`. */
  const [focus, setFocus] = useState<Focus>(() => focused())
  /* Whether the grid is still finding its width. While it is, its own
     transitions are off — see `.settling` in `index.css` for the slide that
     otherwise happens on every load. */
  const [settling, setSettling] = useState(true)
  /* Which container's prompts are being written, if any. The dialog belongs to the
     host rather than to a module — see `Prompts.tsx` for why a modal inside an
     iframe is not a modal. */
  const [prompting, setPrompting] = useState<string | null>(null)
  /* Which module's tools are being looked at, if any. The host's window for the
     same reason the prompt one is: a module cannot open a modal bigger than its
     own container, and what this window shows is not the module's material anyway —
     it is what the AGENT has been told. See `Tools.tsx`. */
  const [toolsFor, setToolsFor] = useState<string | null>(null)

  /* Where each container's body ended up, measured. The module pages are positioned
     over these from a layer that outlives the containers. */
  const { rects, room, surface, body, measure, remeasure, settle } = useRects()

  /*
   * How tall a row is DRAWN: the room, divided into `CANVAS_ROWS` of them.
   *
   * A canvas is twelve columns wide and twenty-eight rows tall, and both are
   * COUNTS rather than pixel sizes. That is the whole of it, and `fit.ts` has
   * the argument — including the two versions of this that were wrong: one that
   * shrank every container on the canvas whenever any container grew, and one
   * that fixed that by letting the canvas overflow again.
   *
   * `room` and a constant are the ONLY inputs, and nothing about the
   * arrangement may ever join them. The moment it does, growing one container
   * starts resizing the others again and the feedback loop `fit.ts` warns about
   * has somewhere to close.
   *
   * Up here, rather than beside the grid it is handed to, because `onHeight`
   * converts a module's requested pixels into rows with it — which is safe now
   * that this depends on nothing the layout can change, and is the only
   * conversion that gives a module the height it actually asked for.
   */
  const rowHeight = useMemo(() => rowHeightFor({ room, gap: MARGIN[1] }), [room])

  /* Whether the canvases have been read from the server yet. Nothing is written
     before they have been, or the first render would save an empty canvas over
     a person's arrangement. */
  const loaded = useRef(false)
  /* Whether this browser has never opened this host — see the effect below. */
  const firstVisit = useRef(false)

  const writer = useMemo(() => new Writer(editCanvas, setTrouble), [])
  /* A page being closed mid-drag still has an unsent arrangement. This is the
     one place where "send it now" is worth more than "send it once". */
  useEffect(() => {
    const flush = () => writer.flushAll()
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [writer])

  /* The canvases, once, before anything is drawn. */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const found = await fetchCanvases()
        if (cancelled) return
        const remembered = readOpen(window.localStorage)
        firstVisit.current = remembered === null
        const project = chooseProject(found.projects, readOpenProject(window.localStorage))
        setProjects(found.projects)
        setProjectId(project)
        setCanvases(found.canvases)
        /* Within the project, and only within it. A remembered kehikko that
           belongs to another project is not the one to open: the switcher
           beside it would not list it, and a canvas its own switcher cannot see
           is one nobody can get back to. */
        setOpenId(chooseOpen(found.canvases, remembered, project))
        loaded.current = true
        /* A project's `kehikot.json` that would not read. Said in the footer,
           where the host's own line is, because the person who edited that
           file is the person looking at this page, and it stays until a load
           finds the file reads again. See `server/kehikot.ts`. */
        if (found.trouble.length) setTrouble(found.trouble.join(' '))
      } catch (error) {
        if (cancelled) return
        setTrouble(
          `The canvases could not be read: ${(error as Error).message}. Nothing can be arranged until they can.`,
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /* Which canvas is open, remembered per browser rather than per person. See
     `canvases.ts` for why this one fact is not on the server with the rest. */
  useEffect(() => {
    if (openId !== null) writeOpen(window.localStorage, openId)
  }, [openId])

  /**
   * And said out loud to the server, which is not the same as storing it there.
   *
   * The paragraph above is still true: which kehikko is open belongs to this
   * tab, and a server that STORED it would make two windows fight over it. What
   * the server keeps is a report, per page, in memory, withdrawn when this page
   * goes away — and the only thing that reads it is the host's own MCP door,
   * which has to answer "which kehikko did you mean" for an agent that named
   * none. Two pages reporting two kehikot is not a fight; it is a refusal with
   * both ids in it. See `server/open.ts`.
   *
   * Withdrawn on `pagehide` rather than only on unmount, because a tab being
   * closed does not unmount anything — and a report left standing by a browser
   * that is no longer running would have an agent told a kehikko is on somebody's
   * screen when there is no screen.
   *
   * The report is followed by a sweep, and the ORDER is the whole of that. The
   * server now decides which modules to have running from what pages say they
   * have open — see `server/lifecycle.ts` — so a sweep sent before the report
   * is a sweep asking about a kehikko the server has not heard of yet. The two
   * requests are otherwise unordered, so they are ordered here rather than
   * hoped about. Switching kehikko is exactly the moment "which modules matter"
   * changes, which makes it exactly the moment worth asking again — the same
   * argument the sweep-on-focus below makes, about a different act of attention.
   *
   * `lookRef` rather than `look` itself, because `look` is declared further down
   * and this effect is where the report belongs. What is wanted is "whatever
   * looking means right now", which is what a ref holds and a stale closure
   * does not.
   */
  useEffect(() => {
    let here = true
    void reportOpen(openId).then(() => {
      if (here) void lookRef.current?.()
    })
    const gone = () => void reportOpen(null)
    window.addEventListener('pagehide', gone)

    /*
     * And said AGAIN whenever this page comes back.
     *
     * `pagehide` withdraws unconditionally, which is right for a tab that is
     * closing — the page is the authority on its own going away. But macOS does
     * not fire it only for that. Switching to a full-screen app occludes this
     * window, the webview hides the page, and the report is withdrawn for a
     * screen that still exists and is still showing its containers. Nothing
     * restored it: `openId` had not changed, so this effect never re-ran.
     *
     * What that cost is the whole of `server/lifecycle.ts`. The host decides
     * which modules to keep running from these reports, so a withdrawn report
     * makes every container on the canvas unneeded, and five minutes later
     * everything the host started is stopped — while somebody is looking at it.
     * The only modules that survived were the ones the host cannot stop because
     * it did not start them, which made it look like one module was special
     * rather than like the report was gone.
     *
     * Re-asserting is one POST on the same events the sweep below uses, and
     * deliberately NOT behind that sweep's quiet floor. A sweep is N requests to
     * N programs and is worth rate-limiting; this is one request that decides
     * whether those programs keep running at all, and a saved request that
     * stops a module somebody is looking at is not a saving.
     */
    const back = () => {
      if (document.visibilityState !== 'visible') return
      void reportOpen(openId)
    }
    window.addEventListener('pageshow', back)
    window.addEventListener('focus', back)
    document.addEventListener('visibilitychange', back)

    return () => {
      here = false
      window.removeEventListener('pagehide', gone)
      window.removeEventListener('pageshow', back)
      window.removeEventListener('focus', back)
      document.removeEventListener('visibilitychange', back)
    }
  }, [openId])

  /**
   * Something other than this page changed a kehikko: read it again.
   *
   * The sweep-on-focus below is deliberately tied to attention, and that is
   * exactly why it cannot serve here. An agent selecting containers through the
   * host's MCP door does it while somebody WATCHES — the tab is focused the
   * whole time, no `focus` or `visibilitychange` ever fires, and the ring on the
   * container would appear whenever the person next happened to alt-tab away and
   * back. The one moment that mechanism cannot catch is the only moment this
   * needs, so it gets its own path: see `server/wake.ts`.
   *
   * Everything is re-read rather than the one kehikko patched, and pending
   * writes are flushed first. The flush is the ordering that matters: an
   * arrangement still sitting in the `Writer` would be sent AFTER this re-read
   * and would overwrite it with what the page thought a moment ago, which is
   * the tool call being silently undone half a second later.
   *
   * ## The second callback: a module died while somebody was watching it
   *
   * The paragraph above turns out to describe a whole family of faults rather
   * than one, and this is the second member of it. A module's server can go
   * away — a crash, a stray kill, a terminal closed — and every mechanism this
   * page has for finding that out is tied to an act of attention that does not
   * happen: the person is already looking. Focus never fires, nothing is
   * `starting`, and the container kept its green light while the module's own
   * page inside the frame said the connection had ended. The host and the frame
   * disagreeing about the same program is the exact shape this workspace keeps
   * having to fix.
   *
   * The answer is the same one `wake.ts` already is: the half that CAN notice
   * says so, and this page sweeps when told. Nothing here polls. The host asks
   * about the containers on the open kehikko and nothing else — see
   * `WATCH_EVERY_MS` in `server/lifecycle.ts` for why that is a check rather
   * than a heartbeat — and sends this only when an answer came back different.
   * The container then draws whatever it already draws for a module that is not
   * answering: `silent`, or `starting` if the host has just run it again.
   *
   * Through `lookRef` rather than `look` itself, so that this effect does not
   * list the sweep among its dependencies. What is wanted is "whatever looking
   * means right now", and a dependency here would mean tearing down and
   * reopening the SSE connection — and with it the report `open.ts` reads off
   * it — for a reason that has nothing to do with what this page has open.
   */
  useEffect(() => {
    const stop = watchCanvases(
      openId,
      () => {
        void (async () => {
          if (!loaded.current) return
          writer.flushAll()
          try {
            const found = await fetchCanvases()
            setCanvases(found.canvases)
          } catch {
            /* The next wake, or the next load, will do. A canvas that could not
               be re-read is the arrangement the person already has on screen. */
          }
        })()
      },
      () => void lookRef.current?.(),
      /* A project's epics changed — an agent's `create_epic`, or a `+` in
         another window. Re-read only when it is THIS page's project: the
         dropdown of a page standing in the thesis folder has nothing to learn
         from an epic made in the roadmap's. Through `projectRef`, for the
         reason `lookRef` is a ref: the stream must not be reopened because the
         open project changed. `held` is not cleared first, as `onRetitleEpic`
         explains — the list stays until the new one lands. */
      (project) => {
        if (project !== projectRef.current) return
        void (async () => {
          try {
            setHeld(await fetchEpics(project))
          } catch {
            /* The list the page has is the list it had. Nothing was lost. */
          }
        })()
      },
    )
    return stop
    /* `openId` too, so the stream is reopened when the open kehikko changes.
       The stream's URL carries what this page has open — see `watchCanvases` —
       and a socket left open on a stale kehikko would tell the server the wrong
       thing for as long as it lived. Reopening it costs one request. */
  }, [writer, openId])

  /* Which project is open, remembered the same way and for the same reason: two
     windows on two screens showing two projects is a reasonable thing to do,
     and a server storing "the current project" would make them fight over it. */
  useEffect(() => {
    if (projectId !== null) writeOpenProject(window.localStorage, projectId)
  }, [projectId])

  const project = useMemo(
    () => projects.find((one) => one.id === projectId) ?? null,
    [projects, projectId],
  )

  /**
   * The open project's epics, re-read whenever the project changes.
   *
   * Cleared to null first, so the picker says "reading epics…" rather than
   * showing the previous project's list for as long as the request takes. A
   * picker that briefly offers epics from somewhere else is a picker somebody
   * can click during that moment.
   *
   * Not cached per project. `data/epics` is rewritten underneath a running host
   * by anything that refreshes the roadmap, and a cache here would be this page
   * showing what was on disk when the project was first opened.
   */
  useEffect(() => {
    if (projectId === null) {
      setHeld(null)
      return
    }
    const stop = new AbortController()
    setHeld(null)
    void (async () => {
      try {
        const found = await fetchEpics(projectId, stop.signal)
        if (!stop.signal.aborted) setHeld(found)
      } catch {
        if (stop.signal.aborted) return
        /* The picker stays at "reading epics…", which is honest: nothing was
           read. It is not turned into `{ holds: false }`, because that sentence
           — "this project has no epics" — is a claim, and a failed read is not
           grounds for making it. */
      }
    })()
    return () => stop.abort()
  }, [projectId])

  /*
   * One sweep at a time, and a record of when the last one finished.
   *
   * Refs rather than state, because neither of these should cause a render:
   * they exist to stop a second sweep starting, and a component that re-rendered
   * every time it decided NOT to do something would be doing the thing it is
   * avoiding. A sweep asks every registered module for its manifest — eleven
   * localhost requests here — so two of them overlapping is eleven wasted
   * requests and two answers racing to be the one that lands.
   */
  const sweeping = useRef(false)
  const sweptAt = useRef(0)
  /** The current `look`, for the effects declared above it. See `reportOpen`. */
  const lookRef = useRef<(() => Promise<void>) | null>(null)

  const look = useCallback(async () => {
    if (sweeping.current) return
    sweeping.current = true
    setLooking(true)
    try {
      const view = await fetchRegistry()
      setRegistry(view)
      setTrouble(null)
      /* A sweep replaces what the server knew; it does not replace what a frame
         has since found out. Live findings are kept for modules still present
         and dropped for the rest. */
      setLive((was) => {
        const kept: Record<string, Live> = {}
        for (const presence of view.presences) {
          const previous = was[presence.id]
          if (previous) kept[presence.id] = previous
        }
        return kept
      })
    } catch (error) {
      /* The sentence, and the recognition of it, both come from
         `host/reachable.ts`. Four places in this program used to write their own
         wording of this one fault and none of them said what to do about it —
         see the essay there. The extra clause is this caller's alone: a failed
         sweep means the host knows nothing about what is registered, which is
         not true of the other three. */
      setTrouble(notAnswering(error, 'Nothing is known about what is registered until it does.'))
    } finally {
      sweeping.current = false
      sweptAt.current = Date.now()
      setLooking(false)
    }
  }, [])

  lookRef.current = look

  useEffect(() => {
    void look()
  }, [look])

  /**
   * Look again when the window comes back to the front.
   *
   * ## Why this is here and why there is no longer a button
   *
   * There was a ↻ in the strip and it was the only thing in the program that
   * could re-read the registry. That capability is not redundant, and this is
   * not its removal — it is the same sweep, moved to the moment somebody would
   * have pressed it.
   *
   * The sweep matters because the alternative is a reload, and a reload of this
   * page destroys every module's document: a terminal mid-command, a half-typed
   * item, every scroll position on the canvas. `Frames.tsx` exists in the shape
   * it does entirely to prevent that, and re-asking eleven programs what they
   * are without touching their pages is the whole point of having a host.
   *
   * What was wrong was the button. Its purpose was not guessable from an icon —
   * the person who owns this asked what it was for — and a control nobody can
   * name is one that is pressed by accident or never pressed at all. Meanwhile
   * the thing it fixed happens on a schedule anybody could predict: you start a
   * module in a terminal, you come back to the canvas, and it should simply be
   * right.
   *
   * ## Why focus and not an interval
   *
   * A sweep is N requests to N localhost programs. Cheap, not free, and paid
   * forever by a canvas nobody is looking at. Tying it to attention means the
   * cost is paid when somebody is there to benefit from it, and a canvas left
   * open overnight makes no requests at all.
   *
   * Both events are listened for because neither covers the case alone:
   * `visibilitychange` fires for a tab switch and not for another window taking
   * focus over the top of this one, and `focus` fires for the second and not
   * reliably for the first. The floor below is what keeps a person alt-tabbing
   * between an editor and the canvas from sweeping on every pass.
   */
  useEffect(() => {
    const maybe = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - sweptAt.current < QUIET_BETWEEN_SWEEPS_MS) return
      void look()
    }
    window.addEventListener('focus', maybe)
    document.addEventListener('visibilitychange', maybe)
    return () => {
      window.removeEventListener('focus', maybe)
      document.removeEventListener('visibilitychange', maybe)
    }
  }, [look])

  /**
   * Look again, on a widening interval, while the host's own server is silent.
   *
   * The exception to the rule directly above, and the argument for it is in
   * `FIRST_RETRY_MS`. In short: the focus sweep is right about a canvas nobody
   * is looking at and wrong about a person watching a fault that is in the
   * middle of repairing itself, which is what this fault now is.
   *
   * ## Why the effect keys on the message
   *
   * `trouble` is what a failed sweep wrote, and `isNotAnswering` is the module
   * that wrote it recognising its own line. Keying on it means the timer exists
   * exactly while the fault does: the sweep that succeeds calls `setTrouble(null)`,
   * this effect's cleanup runs, and the timer is gone without anything having to
   * remember to cancel it.
   *
   * A retry that fails writes the SAME string again, so React bails out of the
   * render, the effect is not torn down, and the backoff keeps widening —
   * which is the behaviour wanted. A retry that fails DIFFERENTLY restarts the
   * effect and the backoff with it. That is not ideal and it is not worth
   * machinery: two different failures in a row means something is changing, and
   * asking again sooner is the right response to that.
   */
  useEffect(() => {
    if (!isNotAnswering(trouble)) return

    let waiting = FIRST_RETRY_MS
    let timer = 0

    const again = () => {
      /* Not while nobody is looking. The same argument the focus sweep makes,
         and it matters more here: this is the one timer in the program that
         would otherwise run forever on a canvas left open on a dead host. */
      if (document.visibilityState === 'visible') void look()
      waiting = Math.min(waiting * 2, LONGEST_RETRY_MS)
      timer = window.setTimeout(again, waiting)
    }

    timer = window.setTimeout(again, waiting)
    return () => window.clearTimeout(timer)
  }, [trouble, look])

  /**
   * Look again while the host is starting something.
   *
   * The host starts a module when a kehikko that has it is opened — see
   * `server/lifecycle.ts` — and a start takes a second or two of a dev server
   * binding a port. Without this, the container would say "starting" and stay
   * that way until somebody happened to alt-tab, which is the same complaint
   * `wake.ts` was written about: the one moment the focus mechanism cannot
   * catch is the only moment this needs.
   *
   * It is a loop and it is bounded, which is the pair of properties that makes
   * it allowed at all. It runs only while some presence says `starting`; the
   * server stops saying that after `STARTING_FOR_MS` whatever happens, so the
   * loop has an end even if the module never comes up — and the end is a
   * container saying the module was run and did not answer, with the button on
   * it. The same argument `ConnectingPanel` makes: it may move because it
   * resolves, both ways, on its own.
   */
  useEffect(() => {
    const starting = (registry?.presences ?? []).some((presence) => presence.lifecycle === 'starting')
    if (!starting) return
    /* An interval rather than one timeout, because `look` declines to run while
       another sweep is in flight — and a single dropped retry would leave the
       container saying "starting" with nothing left to ask again. An interval
       simply asks at the next tick instead. */
    const again = setInterval(() => void look(), 1500)
    return () => clearInterval(again)
  }, [registry, look])

  /**
   * Every container is kept, whatever is registered here.
   *
   * ## What this effect no longer does
   *
   * It used to reconcile every canvas against the registry: a module whose
   * registration was gone came off every canvas that held it, and the
   * arrangement was written back without it. That write is now the most
   * dangerous thing this page could do. The arrangement lives in the project's
   * own `.kehikot/kehikko/kehikot.json` and travels with the project — see
   * `server/kehikot.ts` — and the other computer will not have every module
   * registered. Reconciling there would have written machine A's containers
   * out of the file on machine B, and the next push would have deleted them
   * from A. So no placement is ever taken off by this page on its own; a
   * container for a module this computer lacks is drawn as one — see
   * `Missing.tsx` and `missing()` in `host/canvases.ts` — and comes off only
   * when a person presses the button on it.
   *
   * ## What it still does
   *
   * On a browser's first visit — and only then — an empty first canvas is
   * filled with whatever is registered, so that a person who has just started
   * this thing sees their own programs instead of a black rectangle. Every
   * visit after that respects the arrangement exactly, including an empty one.
   */
  useEffect(() => {
    if (!loaded.current || !registry) return
    const registered = registry.presences.map((p) => p.id)

    setCanvases((was) =>
      was.map((canvas, index) => {
        const fill = firstVisit.current && index === 0 && canvas.placements.length === 0
        if (!fill) return canvas
        const placements = registered.reduce<Placement[]>((acc, id) => place(acc, id), [])
        if (same(canvas.placements, placements)) return canvas
        writer.write(canvas.id, { placements })
        return { ...canvas, placements }
      }),
    )
    firstVisit.current = false
  }, [registry, writer])

  const open = useMemo(() => canvases.find((canvas) => canvas.id === openId) ?? null, [canvases, openId])

  /** Change the open canvas, on screen now and in the database shortly. */
  const change = useCallback(
    (edit: {
      name?: string
      epic?: string | null
      project?: number | null
      selection?: string[]
      placements?: Placement[]
    }) => {
      const id = openId
      if (id === null) return
      setCanvases((was) => was.map((canvas) => (canvas.id === id ? { ...canvas, ...edit } : canvas)))
      writer.write(id, edit)
    },
    [openId, writer],
  )

  /**
   * What the canvas is about: one epic, and the project it is standing in.
   *
   * The project comes from `project` rather than from the open canvas's own
   * `project` id, and they are the same thing said twice on purpose — the
   * canvas holds the key, the header holds the row, and the subject wants the
   * row because both of its fields go out on the wire. Split by value rather
   * than by identity, like the selection and the kehikko below it, so that a
   * re-render for any other reason does not look like a context change and
   * re-point every frame.
   */
  const subject = useMemo<Subject>(
    () => ({ epic: open?.epic ?? null, project }),
    [open?.epic, project],
  )

  /* The epic only. The project is not a property of the subject a person edits
     here — it is where the whole kehikko is, changed by opening a project, and
     changing it from this direction would mean the epic picker could move a
     kehikko between projects. */
  const setSubject = useCallback((next: Subject) => change({ epic: next.epic }), [change])

  /* What every module on the canvas is told. One object, memoised, so that a
     re-render caused by anything else does not look like a context change and
     re-point every frame. */
  /* The theme is part of it, so switching sends every framed module a new
     context and a module that honours it changes with the host. It used to be
     the literal 'dark', which made `roadmap.context.theme` a field this host
     filled in with a constant and never revisited — a lie that happened to be
     true. */
  /**
   * The selection, as a value rather than as an array identity.
   *
   * `open.selection` is a fresh array on every read of the canvases — a `.map`
   * over the rows produces new objects — so depending on it directly rebuilt
   * the context whenever anything about any canvas changed, and every rebuild
   * is a `roadmap.context` posted to every framed module. Measured on a canvas
   * with three modules on it: seventeen identical broadcasts during startup,
   * all carrying the same selection.
   *
   * Nothing was visibly wrong, which is why it survived being written. Every
   * module already ignores a context that tells it nothing new — Journeys keeps
   * what it was standing on, References re-asks only when the epic changes —
   * so the cost was noise on the wire and re-renders nobody asked for. It is
   * still a host telling three programs something seventeen times, and the
   * first module to react to context arriving rather than to context CHANGING
   * would have had a bug that looked like its own.
   *
   * A newline joins them because a ref cannot contain one, so two different
   * selections cannot produce the same key.
   */
  const picked = (open?.selection ?? []).join('\n')
  /**
   * Which canvas is open, as the wire spells it.
   *
   * Split out of `open` by value rather than by identity, exactly like the
   * selection above and for exactly the same reason: `open` is a fresh object
   * on every read of the canvases, so depending on it here would rebuild the
   * context — and post a `roadmap.context` to every framed module — whenever
   * anything about any canvas changed.
   */
  const kehikko = useMemo(
    () => (open ? { id: open.id, name: open.name } : null),
    [open?.id, open?.name],
  )
  /**
   * Where somebody is pointing inside a document, per canvas, in memory only.
   *
   * ## Per-canvas, and not per-host
   *
   * The subject is per-canvas and the selection is per-canvas, and a passage is
   * the same kind of fact one step narrower: it is what THIS arrangement of
   * containers is looking at. The consumer it exists for is another container beside the
   * one that pointed — a paper on the left, its notes on the right — and both
   * of those are on one canvas. A passage held per-host would mean a highlight
   * made in a paper on one canvas narrowing a notes container on another, where the
   * paper is not even open; the reader would see a container filter itself down to a
   * paragraph they cannot see, on a canvas they are not on, and nothing on
   * screen would explain it. So it is keyed by canvas, and switching canvases
   * shows what that canvas was pointing at.
   *
   * ## Not written down, which is the one place it differs from the selection
   *
   * The selection is stored in the canvases table and survives a reload. This
   * is not, and the reason is what the two things ARE. A ref is an identifier:
   * `gh#131` means the same thing tomorrow, and the module that reads it looks
   * it up afresh. A passage is a claim about a mutable file — these bytes, in
   * that file, said this — made by a module that had the document open at the
   * moment it said so.
   *
   * Restore one and there is nobody to renew it. The reader comes back an hour
   * later, the frames reload, and the canvas asserts to every container that
   * somebody is pointing at bytes 4120–4380 of a chapter that has been edited
   * twice since, quoting words no longer at that offset — with no pointing
   * module in a position to notice, because the module that made the claim may
   * not even be on the canvas any more. The protocol's own essay says a
   * consumer can tell a good anchor from a rotten one by comparing the quote,
   * and a host storing this would be manufacturing rotten anchors on purpose.
   *
   * Nothing is lost by letting it die with the page: the pointing module is
   * loaded, shows its document, and points again. That is a passage somebody is
   * actually making, which is the only kind this field is meant to carry.
   */
  const [passages, setPassages] = useState<Record<number, Passage | null>>({})

  /**
   * What each container says it is showing, per canvas, in memory only.
   *
   * Keyed like `passages` and held like `passages`, for the reason given at
   * length above it: this is a claim about a running program's own state — "I
   * have chapter three open" — and once the program is gone nobody is left to
   * renew it. A host that wrote it down would be asserting, after a restart,
   * that a module which may not even be running is showing a file it may have
   * closed a week ago. So it lives with the page, and a module that reloads
   * says it again.
   *
   * Beside it, who POINTED and who PICKED on each canvas. The host always knew
   * — `passage.set` and `selection.set` arrive from a window — and never wrote
   * it down, because nothing needed it. `context.containers` does: the
   * container that pointed is showing what it pointed at, and its row says so
   * without the module having learned a new word. `host/showing.ts` composes
   * the three into one list and has the argument for why that is a projection
   * and not a second source.
   *
   * `selectedBy` is honest about one gap: a selection read back out of the
   * database after a reload has no setter here, and goes into nobody's row. It
   * is still `context.selection`. Inventing who picked it would be the host
   * stating who said something it did not hear.
   */
  const [said, setSaid] = useState<Record<number, Record<string, Showing>>>({})
  const [pointedBy, setPointedBy] = useState<Record<number, string | null>>({})
  const [selectedBy, setSelectedBy] = useState<Record<number, string | null>>({})

  /**
   * Moving to a different PROJECT clears every passage. Moving to a different
   * EPIC does not, and the difference is the whole of the decision.
   *
   * The selection is dropped on an epic change because a ref was picked out of
   * one epic's references and means nothing in another. Run the same test on a
   * passage and it comes out the other way: a passage names a file and a range
   * of bytes in it, and neither of those belongs to an epic. A reader with
   * chapter three of a thesis open and a paragraph highlighted has not stopped
   * reading that paragraph because the bar now says a different epic — the
   * document is still on screen, the highlight is still on it, and clearing the
   * passage would make the host contradict what the reader can see.
   *
   * A PROJECT is different, and it is different for a reason that only exists
   * now that projects do: a path belongs to one. `projectPath` is the folder
   * every module takes its root from, and switching it re-roots all of them at
   * once. A passage carried across would name a file in the tree they have all
   * just stopped working in — every consumer resolving it would either fail to
   * find it or, worse, find a same-named file in the new project and quietly
   * describe the wrong document. So it goes, whole, for every canvas: canvases
   * can be moved between projects, so "the ones in the old project" is not a
   * set this can be sure of.
   */
  const wasInProject = useRef<number | null>(null)
  useEffect(() => {
    if (wasInProject.current === projectId) return
    wasInProject.current = projectId
    setPassages((was) => (Object.keys(was).length === 0 ? was : {}))
    /* And everything a container said it shows, and who pointed or picked,
       for the passage's own reason: a document path belongs to the project
       that was just left, and a ref was picked out of an epic in it. */
    setSaid((was) => (Object.keys(was).length === 0 ? was : {}))
    setPointedBy((was) => (Object.keys(was).length === 0 ? was : {}))
    setSelectedBy((was) => (Object.keys(was).length === 0 ? was : {}))
  }, [projectId])

  const passage = openId === null ? null : (passages[openId] ?? null)

  /**
   * The passage as a VALUE, for the same reason `picked` is a joined string.
   *
   * `toWireContext` runs the protocol's schema and hands back a fresh object
   * every time, so a memo depending on the passage by identity would rebuild
   * the context — and post a `roadmap.context` into every frame on the canvas —
   * on every render that happened to produce an equal passage. There is a
   * measured history of exactly this here: seventeen identical contexts during
   * startup, because a `.map` over the canvases made a new selection array each
   * time and nobody checked. A passage is worse to get wrong than a selection
   * was, because a highlight changes on every pointer move during a drag.
   */
  const pointing = passage === null ? '' : JSON.stringify(passage)

  /**
   * Every container on the open kehikko, whether it is picked out, and what it
   * shows — composed on every render, cheaply, and depended on BY VALUE below.
   *
   * `open.placements` is a fresh array on every read of the canvases, the
   * passage is a fresh object on every context, and `containersOf` builds
   * fresh rows out of both. Depending on any of those by identity is the
   * seventeen-identical-broadcasts problem `picked` and `pointing` exist to
   * prevent, so what the memo reads is the list as one string.
   */
  const described = containersOf({
    placements: open?.placements ?? [],
    said: (openId === null ? undefined : said[openId]) ?? {},
    passage,
    pointedBy: openId === null ? null : (pointedBy[openId] ?? null),
    selection: picked ? picked.split('\n') : [],
    selectedBy: openId === null ? null : (selectedBy[openId] ?? null),
  })
  const arranged = containersKey(described)

  const context = useMemo(
    () => toWireContext(subject, theme, picked ? picked.split('\n') : [], kehikko, passage, described),
    /* `pointing` and not `passage`, `arranged` and not `described`: the
       value, not the identity. Both objects are intentionally absent from the
       list and the lint rule that would ask for them is wrong here — see the
       essays on `pointing` and `described` above. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subject, theme, picked, kehikko, pointing, arranged],
  )

  /**
   * The one event bus for this page.
   *
   * Built once and never rebuilt — it is the dependency of the effect that
   * joins each frame to it, so a fresh one per render would be every module
   * leaving and rejoining on every render, which is a window of exactly one
   * render during which an event goes nowhere.
   *
   * It holds a token bucket per module and therefore a little state, and that
   * state living for as long as the page is correct: a rate limit that reset
   * whenever React re-rendered would be a rate limit a loop could outrun by
   * causing re-renders, which is precisely what a loop of events does.
   */
  const bus = useMemo(() => new EventBus(), [])

  /**
   * The frames a header control can press, for the one control that presses.
   *
   * Built once and never rebuilt, exactly like the bus and for the same reason:
   * it is the dependency of the effect that joins each frame, and a fresh one
   * per render would be every module leaving and rejoining constantly, with a
   * window of one render in which a press reaches nothing.
   *
   * It holds no state of its own beyond who is standing — see `presses.ts` for
   * why a destructive message travels as a CALL rather than as a prop that
   * changes, and what `StrictMode` does to the alternative.
   */
  const presses = useMemo(() => new Presses(), [])

  /**
   * Where the canvas is, for an event that is about to be sent.
   *
   * A ref rather than a dependency of `controls`, because `controls` is the
   * object every conversation was built with and rebuilding it is not free.
   * Read at emit time, which is also the honest reading: the kehikko an event
   * happened on is the one open when it was emitted, not the one that was open
   * when the module's frame was mounted.
   */
  const kehikkoRef = useRef(kehikko)
  kehikkoRef.current = kehikko

  /**
   * Which project the canvas is standing in, for a call that is about to be
   * made. A ref for the same reason `kehikkoRef` is one: `controls` is the
   * object every conversation was built with, and rebuilding it on every
   * project switch would rebuild every module's `ask`.
   *
   * Read at call time, which is also the honest reading — a module's page is
   * loaded once and shown on whichever kehikko asks for it, so the project a
   * question is about is the one open when it was asked, not the one that was
   * open when the frame was mounted.
   */
  const projectRef = useRef<number | null>(projectId)
  projectRef.current = projectId

  /* Which canvas a passage belongs to, read when the call is MADE. A ref for
     the reason `kehikkoRef` and `projectRef` are refs: `controls` is the object
     every module's conversation was built with, and rebuilding it whenever
     somebody switches canvas would rebuild every module's `ask`. */
  const openRef = useRef<number | null>(openId)
  openRef.current = openId
  const setPassagesRef = useRef(setPassages)
  setPassagesRef.current = setPassages
  /* The same arrangement for the three records beside it. `controls` is built
     once; these setters are stable anyway, and reading them through refs keeps
     the pattern one pattern. */
  const setSaidRef = useRef(setSaid)
  setSaidRef.current = setSaid
  const setPointedByRef = useRef(setPointedBy)
  setPointedByRef.current = setPointedBy
  const setSelectedByRef = useRef(setSelectedBy)
  setSelectedByRef.current = setSelectedBy

  const onFocus = useCallback(() => {
    setFocus((was) => {
      const next = otherFocus(was)
      applyFocus(next)
      return next
    })
  }, [])

  const onTheme = useCallback(() => {
    setTheme((was) => {
      const next = other(was)
      apply(next)
      return next
    })
  }, [])

  /**
   * A module asking where its own container's filters should go.
   *
   * ## Held in a ref, for the reason `point` reads `openRef`
   *
   * `controls` is memoised on purpose — a new object per render would be a new
   * conversation per render — so it cannot close over `placements` or `live`,
   * which change constantly. The work is written here, fresh every render, and
   * `controls` calls through the ref. The same shape `setPassagesRef` uses.
   *
   * ## What it refuses, and why refusing is the honest half
   *
   * `filters.set` can be declined where `passage.set` cannot, because it asks
   * to change something written down that outlives the module's next reload.
   * Three refusals, each with a sentence the module's author can act on:
   *
   *  - **Not on the open kehikko.** A module's page is one frame shown on
   *    whichever canvas asks for it. Writing filters for a container nobody is
   *    looking at would be a setting that changed while the person was
   *    elsewhere and was waiting for them when they came back.
   *  - **Pinned.** A pin freezes what a container is told, so the write would
   *    land and the module would never hear about it — it would ask, be told
   *    yes, and draw the old thing forever. See `whileFrozen`.
   *  - **Not offering filters.** A module that has sent no offer has nothing
   *    for a choice to be about, and `settle` prunes against the offer, so the
   *    write would silently be `{}` whatever was asked for.
   *
   * What comes back is what `settle` kept, which is deliberately not what was
   * asked for: a group on its resting option is not written down, and a group
   * the module is not currently offering is dropped. The module is told the
   * settled value so it never has to assume.
   */
  /**
   * A module asking the person which project — the ask, held while it waits.
   *
   * ## The one control here whose answer is a person
   *
   * Everything else a module may ask the canvas is settled by the time the
   * handler returns. This opens a dialog and settles when somebody presses
   * something, so what is held is the RESOLVER: the promise the module's
   * response is waiting on, parked in state until `onPicked` or `onCancelled`
   * calls it. Nothing else in this file works this way, and nothing else should
   * — a second one would be a second modal fighting for the screen.
   *
   * Which is also why only one ask is entertained at a time. A module that
   * asked while another dialog was open is `declined` rather than queued: a
   * queue would mean a person answering a question they had forgotten being
   * asked, and the protocol makes a decline survivable.
   */
  const [asking, setAsking] = useState<{ from: string; name: string; settle: (picked: Picked) => void } | null>(
    null,
  )
  const askingRef = useRef(asking)
  askingRef.current = asking

  /**
   * What the canvas does when a module asks for a project.
   *
   * Through a ref for the reason `filterRef` is: the work needs this render's
   * projects and this render's registry, and rebuilding `controls` on every
   * change to either would rebuild every conversation on the canvas.
   *
   * Three refusals and they are all `declined`, which is the protocol's word
   * and carries no information about why beyond a sentence for whoever is
   * reading a console. In particular **"this host holds no projects" is a
   * decline and not an outcome of its own** — see the essay on
   * `projectPickResult`: a fourth outcome saying so is an enumeration with a
   * count of zero, and a module that could tell it from a refusal could learn
   * something about the disk by asking.
   */
  const pickRef = useRef<(from: string) => Promise<Picked>>(() =>
    Promise.resolve({ outcome: 'declined', project: null, why: 'This roadmap is not ready to ask anybody yet.' }),
  )
  pickRef.current = (from) => {
    const declined = (why: string): Promise<Picked> =>
      Promise.resolve({ outcome: 'declined' as const, project: null, why })
    if (askingRef.current) {
      return declined('Somebody is already being asked to choose a project.')
    }
    if (projects.length === 0) {
      return declined('This roadmap will not ask right now.')
    }
    /* The name comes off the registration, never off anything the frame said.
       Same rule as `emit`'s sender, and it bites harder here: this is the one
       screen where a person decides whether to hand a program a folder. */
    const name = byId.get(from)?.name ?? from
    return new Promise<Picked>((settle) => setAsking({ from, name, settle }))
  }

  /* Pressed a row. The path is the one the server resolved, which is the same
     string `context.projectPath` carries for the open project — a module has no
     way to tell a picked project from the open one, and should not need one. */
  const onPicked = useCallback(
    (project: Project) => {
      const ask = askingRef.current
      if (!ask) return
      setAsking(null)
      ask.settle({ outcome: 'picked', project: { path: project.path, name: project.name }, why: '' })
    },
    [],
  )

  /* Escape, the overlay, the X and Cancel are one answer. A dialog dismissed
     into silence would leave the module waiting on its own deadline for
     something that is never coming. */
  const onCancelled = useCallback(() => {
    const ask = askingRef.current
    if (!ask) return
    setAsking(null)
    ask.settle({ outcome: 'cancelled', project: null, why: '' })
  }, [])

  const filterRef = useRef<(from: string, choice: FilterChoice) => Filtered>(() => ({
    ok: false,
    error: 'this host is not ready to hold a filter yet',
  }))
  filterRef.current = (from, choice) => {
    const placements = open?.placements ?? []
    const container = placements.find((p) => p.i === from)
    if (!container) {
      return { ok: false, error: `${from} is not on the kehikko that is open, so it has no filters here to move.` }
    }
    if (container.pinned) {
      return {
        ok: false,
        error: `${from} is pinned, so it would not be told about the change it is asking for.`,
      }
    }
    const offer = live[from]?.filters ?? []
    if (offer.length === 0) {
      return { ok: false, error: `${from} has not offered anything to be narrowed by, so there is nothing to set.` }
    }
    const kept = settleFilters(offer, choice)
    if (!sameChoice(kept, container.filters)) {
      change({ placements: placements.map((p) => (p.i === from ? { ...p, filters: kept } : p)) })
    }
    return { ok: true, filters: kept }
  }

  /* What a module may ask the canvas to do. See `host/ask.ts`. */
  const controls = useMemo<CanvasControls>(
    () => ({
      /* Moving to a different epic drops the selection. A ref was picked out of
         one epic's references; carrying it into another would leave every
         module pointing at something that is not in front of them any more, and
         "nothing is selected" is a state they all have to handle anyway. */
      showEpic: (epic) => {
        change({ epic, selection: [] })
        /* The selection went, so its setter goes with it: a row saying a
           container picked refs the canvas no longer holds would be the row
           and the canvas disagreeing. */
        const id = openRef.current
        if (id !== null) setSelectedByRef.current((was) => (was[id] === null ? was : { ...was, [id]: null }))
      },
      select: (from, refs) => {
        change({ selection: refs })
        /* Who picked, so that the refs appear in that container's own row of
           `context.containers`. An empty list is a selection cleared, and
           nobody is its setter. */
        const id = openRef.current
        if (id === null) return
        const by = refs.length ? from : null
        setSelectedByRef.current((was) => (was[id] === by ? was : { ...was, [id]: by }))
      },
      /* What a container says it shows, held for the open canvas and only when
         it CHANGED — the same bargain `point` keeps below, for the same reason:
         a module that re-says an identical statement on every render must not
         cost every frame on the canvas a context. */
      show: (from, showing) =>
        setSaidRef.current((was) => {
          const id = openRef.current
          if (id === null) return was
          const here = was[id] ?? {}
          if (JSON.stringify(here[from] ?? null) === JSON.stringify(showing)) return was
          return { ...was, [id]: { ...here, [from]: showing } }
        }),
      /* Held for the canvas that is open, and only when it actually CHANGED.
         A module that points on every pointer move during a drag would
         otherwise put a `roadmap.context` into every frame on the canvas per
         event; the sender is asked not to do that, and this is the half of the
         bargain the host can keep on its own — a host cannot make somebody
         else's program debounce, and it can refuse to repeat itself. */
      point: (from, next) => {
        const id = openRef.current
        if (id === null) return
        setPassagesRef.current((was) => {
          const had = was[id] ?? null
          if (JSON.stringify(had ?? null) === JSON.stringify(next ?? null)) return was
          return { ...was, [id]: next }
        })
        /* Who pointed, so the passage appears in that container's row. A null
           passage is a document closed, and nobody is showing it. */
        const by = next ? from : null
        setPointedByRef.current((was) => (was[id] === by ? was : { ...was, [id]: by }))
      },
      /* `from` arrives already decided — `makeAsk` supplies it out of the
         registration the conversation was built on, and nothing the frame said
         can reach it. This end only adds where the canvas is. */
      emit: (from, extension, payload) => bus.emit(from, extension, payload, kehikkoRef.current),
      /* An id, read now. The server turns it into a folder out of its own
         table — see `project` on `CanvasControls` for why a path must not come
         from this side. */
      project: () => projectRef.current,
      /* `from` arrives already decided, as it does for `emit`, and here it
         matters more: a module that could name its own target would be able to
         move another container's filters, and a filter is what somebody is
         looking through. Through a ref, because the work needs this render's
         placements — see `filterRef`. */
      filter: (from, choice) => filterRef.current(from, choice),
      /* `from` out of the registration again, and for the sharpest version of
         the reason: the dialog says who is asking, and a module that could name
         itself would be signing somebody else's name to a request for a
         folder. Through a ref — see `pickRef`. */
      pickProject: (from) => pickRef.current(from),
    }),
    [change, bus],
  )

  const onPlace = useCallback(
    (id: string) => change({ placements: place(open?.placements ?? [], id) }),
    [change, open?.placements],
  )

  const onUnplace = useCallback(
    (id: string) => change({ placements: unplace(open?.placements ?? [], id) }),
    [change, open?.placements],
  )

  /**
   * A module saying how tall it would like to be. Acted on only where asked.
   *
   * ## Why this is opt-in per container
   *
   * Honouring it everywhere was tried twice and fought the person both times.
   *
   * *Grow whenever asked* has a runaway in it. A module measures its own
   * document; its document is as tall as the frame the host gave it; so growing
   * the container grows the document, which asks for more. It does not oscillate, it
   * climbs — one container here reached eighty rows, two and a half thousand pixels,
   * pushing its own resize handle off the bottom of the canvas where nothing
   * could reach it.
   *
   * *Grow once per load* bounds the runaway and keeps the argument, just
   * slower: a container smaller than its module's content is grown again on every
   * refresh. You size a container, reload, and it is bigger. A disagreement that
   * resumes each time the page opens is not a compromise.
   *
   * What was wrong in both is that the host was deciding. Whether a container should
   * fit its contents or hold its size is a question about how somebody wants to
   * read this particular thing, and there is no answer that is right for every
   * container — a list you scan wants to stay put and scroll; a summary you want to
   * see all of wants to fit. So it is a switch on the container, off by default,
   * remembered with the arrangement.
   *
   * ## The brake stays even when it is on
   *
   * Opting in must not opt into the runaway. Two things prevent it. The container
   * only ever GROWS towards the requested height and never past the bottom of the
   * canvas, so the worst case is bounded and reachable. And growth stops as soon
   * as the request is no longer meaningfully larger than the container — a page
   * that fills whatever frame it is given reports the frame's own height, which
   * after one step is the height it already has, and the climb ends there instead
   * of continuing by a rounding error a step.
   *
   * ## A module cannot do what a person cannot
   *
   * The ceiling used to be `MOST_ROWS = 40` — "a tall container on any screen
   * and nowhere near a runaway" — which was a sensible invention when a canvas
   * had no bottom. It has one now, and more than that, growing has a PRICE:
   * `granted` in `columns.ts` draws every container at what its wish leaves
   * for the containers below it, from the free space under the column first
   * and then from the containers below, down to a floor.
   *
   * A module asking to grow goes through exactly that, so a request from a
   * program does the same thing to a canvas that a hand on the resize handle
   * would. The alternative — a separate ceiling here — would have meant a
   * module could quietly do what a person is not allowed to do, on a canvas the
   * person is looking at, which is the wrong way round for the one path where
   * nobody is holding the mouse.
   *
   * What a module that asks for more than the column can pay gets is the part
   * that was payable, and its own page scrolls for the rest. That is what a
   * container already at the bottom of a full column does today, and the
   * vertical twin of a container that cannot be widened past column twelve.
   *
   * ## And the arithmetic uses the DRAWN row, which it could not before
   *
   * `fit.ts` used to forbid exactly this: converting pixels to rows with the
   * drawn height closed a loop — shorter rows, more rows for the same pixels, a
   * taller arrangement, shorter rows again. The loop needed the row height to
   * depend on the arrangement, and it no longer does; it depends on the window
   * and a constant. With that gone, using the nominal 24 would be plainly wrong:
   * on a small window a module asking for 300 pixels would be given rows that
   * draw 160, ask again, and be refused for asking for what it did not get.
   */
  /** Below this, a request is agreement rather than a request. */
  const WORTH_GROWING_PX = 12

  const onHeight = useCallback(
    (id: string, px: number) => {
      const placements = open?.placements ?? []
      const container = placements.find((p) => p.i === id)
      if (!container?.grow) return

      /* How many rows hold `px`, at the height rows are actually drawn at.
         What the column will actually GRANT of that is `granted`'s answer, in
         `redrawn`; this is only the conversion. Bounded by the canvas, because
         a wish past it is simply "as much as there is" and a wish of ten
         thousand rows is not a height anybody chose. */
      const rowsFor = (wanted: number) => Math.min(CANVAS_ROWS, Math.ceil((wanted + MARGIN[1]) / (rowHeight + MARGIN[1])))

      /*
       * A collapsed container does not grow, and the request is not thrown away.
       *
       * `roadmap.resize` is a module saying how tall its document is. A module
       * has not been told its container is folded — deliberately; see `onCollapse` —
       * so it goes on measuring and asking, and honouring that here would let a
       * module force a container open that a person folded shut. The person's press
       * wins. What the module asked for becomes the wish, which is what the
       * container is unfolded towards, so a module that grew while folded is the
       * right size when it comes back rather than the size it was when it was
       * put away. `redrawn` is not needed: a folded container is drawn at one
       * row whatever it wishes.
       */
      if (container.collapsed) {
        const wanted = rowsFor(px)
        if (wanted <= container.wish) return
        change({ placements: placements.map((p) => (p.i === id ? { ...p, wish: wanted } : p)) })
        return
      }

      const isNow = container.h * rowHeight + (container.h - 1) * MARGIN[1]
      if (px <= isNow + WORTH_GROWING_PX) return

      /*
       * Only a LARGER wish. A module measures its document and asks on every
       * change, and a container drawn short because a neighbour took its rows
       * is a container whose module is asking for what it already wishes for
       * — the wish is not the problem, the column is, and re-writing the same
       * wish would be a write per measurement for nothing.
       *
       * Then through the same rule a hand on the resize handle goes through:
       * the wish is written, and `redrawn` asks the column what every wish is
       * granted. A column with nothing to give draws the same heights, and
       * `change` is a no-op write of the wish alone.
       */
      const wanted = rowsFor(px)
      if (wanted <= container.wish) return
      change({ placements: redrawn(placements.map((p) => (p.i === id ? { ...p, wish: wanted } : p))) })
    },
    [change, open?.placements, rowHeight],
  )

  /**
   * Pin a container, or let it go.
   *
   * A pinned container keeps whatever it was last told and hears nothing further
   * about this canvas — which is how two containers end up on two different epics,
   * side by side, to be compared.
   *
   * The module is TOLD, in `roadmap.context`. This host refused to pin at all
   * until the protocol had a word for it, because a silent pin leaves a module
   * describing itself as showing the open epic while it shows a remembered one,
   * with no way to tell a person's pin from the canvas not having moved. See
   * `pinned` in the protocol's `wire.ts`, and `ModuleFrame` for the one message
   * that still goes out after the freeze.
   */
  const onPin = useCallback(
    (id: string, pinned: boolean) => {
      const placements = (open?.placements ?? []).map((p) => (p.i === id ? { ...p, pinned } : p))
      change({ placements })
    },
    [change, open?.placements],
  )

  /**
   * A module has said what it can be narrowed by.
   *
   * Two things happen, and they are deliberately not the same thing.
   *
   * The offer is remembered against the CONVERSATION, because it belongs to a
   * running program: it changes when the module's own words change (a count in
   * a label), and it should vanish when the module does.
   *
   * And the stored choice is pruned against it, which is the only moment this
   * host is in a position to do that. Anything the module is no longer offering
   * stops being carried — see `settle` in `host/filters.ts` for why reconciling
   * on read alone would leave a dead value in the database forever, invisible,
   * ready to come back to life under the same spelling two versions later.
   *
   * Written only when it would actually change something. A module that
   * re-announces the same offer twenty times a minute — which is the ordinary
   * case, since a label with a count in it changes whenever the count does —
   * must not be twenty writes to the arrangement.
   */
  const onOffer = useCallback(
    (id: string, groups: FilterGroup[]) => {
      setLive((was) => ({
        ...was,
        [id]: {
          condition: was[id]?.condition ?? 'ready',
          line: was[id]?.line ?? null,
          fault: was[id]?.fault ?? null,
          filters: groups,
          clear: was[id]?.clear,
        },
      }))

      const placements = open?.placements ?? []
      const container = placements.find((p) => p.i === id)
      if (!container) return
      const kept = settleFilters(groups, container.filters)
      if (sameChoice(kept, container.filters)) return
      change({ placements: placements.map((p) => (p.i === id ? { ...p, filters: kept } : p)) })
    },
    [change, open?.placements],
  )

  /**
   * A module has said that what it is showing can be cleared, or that it cannot.
   *
   * Half of what `onOffer` does, and the missing half is the interesting part.
   * A filter offer has to be reconciled against a stored CHOICE, because a
   * filter is true for as long as it is on and outlives the program that
   * offered it. A clear offer has nothing stored against it and never will: a
   * press is an event, and there is no state for a container to carry from one
   * day to the next saying that somebody once pressed it. So this writes to the
   * conversation and touches the arrangement not at all — no placement changes,
   * nothing reaches the database, and a module that re-announces forty times a
   * minute because its count is moving costs exactly forty re-renders and zero
   * writes.
   *
   * `null` is kept rather than turned into an absence, because the two are
   * different things worth telling apart when somebody is working out why a
   * control is missing. See `clear` on `Live`.
   */
  const onClearable = useCallback((id: string, label: string | null) => {
    setLive((was) => ({
      ...was,
      [id]: {
        condition: was[id]?.condition ?? 'ready',
        line: was[id]?.line ?? null,
        fault: was[id]?.fault ?? null,
        filters: was[id]?.filters,
        clear: label,
        refresh: was[id]?.refresh,
      },
    }))
  }, [])

  /**
   * A module has said whether it can be read again, and when it last was.
   *
   * Shaped like `onClearable` and not like `onOffer`, and the reason is the
   * same one: there is a stored setting beside this — the INTERVAL — but
   * nothing in this announcement reconciles against it. A filter offer has to
   * be settled against a stored choice, because an option that goes away leaves
   * a container narrowed by a value nobody can see. An interval cannot go stale
   * that way: "every five minutes" means the same thing whatever the module
   * ships next, and a module that stops being refreshable simply stops being
   * asked. So this writes to the conversation and touches the arrangement not
   * at all.
   *
   * Which matters here more than it did there, because of how often this
   * arrives. A module announces at least twice per refresh — `busy` on the way
   * in, a new `at` on the way out — and a container on a five-minute clock does
   * that all day. Every one of those being a write to the arrangement would be
   * a database row per tick per container, for a number nobody edited.
   */
  const onRefreshable = useCallback((id: string, state: { can: boolean; at: string | null; busy: boolean }) => {
    setLive((was) => ({
      ...was,
      [id]: {
        condition: was[id]?.condition ?? 'ready',
        line: was[id]?.line ?? null,
        fault: was[id]?.fault ?? null,
        filters: was[id]?.filters,
        clear: was[id]?.clear,
        refresh: state,
      },
    }))
  }, [])

  /**
   * Somebody set — or cleared — how often one container reads again.
   *
   * Written to the placement, which is where it has to live: it must survive
   * quitting the app, it is about ONE container rather than about the module,
   * and the module cannot hold it because it is not always running. The same
   * three reasons as the filter choice, and the essay is on `refreshEvery` in
   * `host/canvases.ts`.
   *
   * `null` clears it. Bounded here as well as at the server's door, because the
   * thing on the other end of this number spends a subprocess or somebody's
   * rate limit every time it fires, and a control that could be typed into is a
   * control somebody can type `0` into.
   */
  const onRefreshEvery = useCallback(
    (id: string, every: number | null) => {
      const placements = open?.placements ?? []
      const container = placements.find((p) => p.i === id)
      if (!container) return
      const kept =
        every === null ? null : Math.min(REFRESH_EVERY_MAX, Math.max(REFRESH_EVERY_MIN, Math.round(every)))
      if (kept === container.refreshEvery) return
      change({ placements: placements.map((p) => (p.i === id ? { ...p, refreshEvery: kept } : p)) })
    },
    [change, open?.placements],
  )

  /**
   * The clock, which is the host's half of the refresh contract.
   *
   * ## One ticker, not one timer per container
   *
   * The obvious build is a `setInterval` per container inside an effect that
   * depends on the placements. It is wrong in a way that only shows up in use:
   * `placements` gets a new identity on every drag, every fold, every selection
   * and every context, so the effect tears down and sets up constantly — and
   * each teardown restarts the interval from zero. A container on a five-minute
   * clock, on a canvas somebody is arranging, would never reach five minutes.
   *
   * So there is one thirty-second ticker for the whole page, and the deciding
   * is done against a clock this component keeps. The ticker never restarts,
   * because its effect depends on nothing.
   *
   * ## It counts from when the host last ASKED, not from the module's own `at`
   *
   * Those look interchangeable and are not. `at` is when the module last read
   * something successfully, so a module whose reads keep failing would sit with
   * an `at` from an hour ago and be asked again on every single tick — thirty
   * seconds apart, forever, which is the opposite of what the interval means. A
   * host asking every five minutes is a promise about how often it ASKS.
   *
   * The first tick after a setting is made is therefore one interval away, not
   * immediate, because `asked` is stamped when the container is first seen.
   *
   * ## Four containers are skipped, and each is a rate limit not spent
   *
   * - not on the kehikko that is open — a module is one page shown wherever it
   *   is asked for, and a clock on a canvas nobody has open is a subprocess
   *   spent for a screen that does not exist;
   * - folded — a container drawn as a bare header is a list nobody can see;
   * - not offering, or offering `can: false` — there is nothing to read, and a
   *   host that asked anyway would be asking a module that has said it cannot;
   * - already reading — the module said `busy`, and two reads racing is two
   *   subprocesses and one answer that wins for no reason anybody could
   *   predict.
   *
   * A PINNED container is deliberately not on that list. A pin freezes what a
   * container is told about the canvas; it says nothing about whether its own
   * material should stay current, and a pinned reference list going stale on
   * purpose would be a surprise nobody asked for.
   */
  const asked = useRef(new Map<string, number>())
  const clockRef = useRef<{ placements: Placement[]; live: Record<string, Live> }>({ placements: [], live: {} })
  clockRef.current = { placements: open?.placements ?? [], live }

  useEffect(() => {
    const tick = setInterval(() => {
      const now = Date.now()
      const { placements, live: standing } = clockRef.current
      const on = new Set<string>()
      for (const container of placements) {
        const every = container.refreshEvery
        if (every === null) continue
        on.add(container.i)
        const state = own(standing, container.i)
        if (!state?.refresh?.can) continue
        const last = asked.current.get(container.i)
        if (last === undefined) {
          /* First seen. Stamped rather than fired, so that opening a canvas
             does not refresh every container on it at once — which is both a
             burst of subprocesses and a page that flickers on arrival. */
          asked.current.set(container.i, now)
          continue
        }
        if (container.collapsed || state.refresh.busy) continue
        if (now - last < every * 60_000) continue
        asked.current.set(container.i, now)
        presses.refresh(container.i)
      }
      /* Forgotten when the clock is taken off, so that turning it on again a
         week later starts from now rather than firing immediately on a stamp
         from the last time anybody looked. */
      for (const id of [...asked.current.keys()]) if (!on.has(id)) asked.current.delete(id)
    }, 30_000)
    return () => clearInterval(tick)
  }, [presses])

  /**
   * Somebody chose a value in one of a module's filter groups.
   *
   * Stored as the press, and reconciled on the way back out. `settle` drops a
   * group that is on its module's own resting option rather than writing it
   * down, because a store that recorded "this one is at its default" could not
   * tell somebody who chose the default from somebody who never chose anything
   * — and only one of those should survive the module changing its mind about
   * what the default is.
   *
   * The host has no idea what was chosen and never finds out. It writes a
   * string it was handed under a key it was handed, and the module reads both
   * back out of the next `roadmap.context`.
   */
  const onChooseFilter = useCallback(
    (id: string, group: string, option: string) => {
      const placements = open?.placements ?? []
      const container = placements.find((p) => p.i === id)
      if (!container) return
      const offer = live[id]?.filters ?? []
      const kept = settleFilters(offer, { ...container.filters, [group]: option })
      change({ placements: placements.map((p) => (p.i === id ? { ...p, filters: kept } : p)) })
    },
    [change, live, open?.placements],
  )

  /** Everything back. One press, and the empty record is how "nothing chosen" is spelled. */
  const onEverything = useCallback(
    (id: string) => {
      const placements = open?.placements ?? []
      change({ placements: placements.map((p) => (p.i === id ? { ...p, filters: {} } : p)) })
    },
    [change, open?.placements],
  )

  /** Write what one container says, and who it says it to. */
  const onWritePrompt = useCallback(
    (id: string, prompt: string, aimedAt: string | null) => {
      const placements = (open?.placements ?? []).map((p) =>
        p.i === id ? { ...p, prompt, promptFor: aimedAt } : p,
      )
      change({ placements })
    },
    [change, open?.placements],
  )

  /**
   * Fold a container down to its header, or unfold it.
   *
   * ## Folding is a state, not a height
   *
   * This sets `collapsed` and nothing else, and asks `redrawn` what every
   * container is drawn at now. The container's `wish` — the height its owner
   * asked for — is left exactly as it was, which is what unfolding returns it
   * towards: not a height remembered at the moment of folding and put back,
   * but the same wish every other gesture is drawn from, granted by the same
   * rule. See `granted` in `host/columns.ts` for why there is no remembered
   * height: there used to be one, `openH`, and it was thrown away on unfold
   * exactly when a squeezed container needed it.
   *
   * What follows for the neighbours is the point. Folding hands rows to the
   * column, and a column-mate that had been squeezed to make room for this
   * container is drawn back at ITS wish — not because anything here gives the
   * rows back, but because its wish never changed and the column has room.
   * Unfolding takes them again, subject to the budget: a column that filled up
   * in the meantime gives back less than was asked, and the canvas never
   * overflows, which is the bug the old unfold had.
   *
   * ## The module keeps running, and is not told
   *
   * Folding is not removing. The module's document stays in the frames layer
   * with everything in it — a scroll position, a half-typed line, a shell
   * session — for exactly the reason `Frames.tsx` exists: an iframe that leaves
   * the DOM is a document that has been destroyed, and there is no way to get
   * it back. A folded container's page is hidden the same way a container on another
   * canvas is hidden, which is a path this program has had since the beginning.
   *
   * Nothing goes out on the wire, and `roadmap.context` does not grow a field.
   * This is a real judgement call rather than an oversight: one could argue a
   * module ought to know it is not visible so it can stop polling. It should
   * not learn it from HERE, because it could not act on it correctly — from
   * inside, a folded container is indistinguishable from a container on a kehikko nobody
   * is looking at, and the protocol deliberately does not report that either.
   * A module that stopped work on the strength of this would stop work in a
   * case it cannot detect and resume in a case it cannot detect. Whether the
   * host drew a container at full height is the host's business.
   */
  const onCollapse = useCallback(
    (id: string, collapsed: boolean) => {
      const placements = open?.placements ?? []
      change({ placements: redrawn(placements.map((p) => (p.i === id ? { ...p, collapsed } : p))) })
    },
    [change, open?.placements],
  )

  /**
   * Pick a container out as a target on this kehikko, or unpick it.
   *
   * ## Which axis this is
   *
   * There are now three things on this canvas that could all be called a
   * selection, and they are three different facts:
   *
   *   - `canvas.selection` is REFS — `gh#105`, `!44` — what somebody picked out
   *     of a tracker. It goes out in `roadmap.context` and every module is told.
   *   - `passage` is a place inside a document: a path, a page, a byte range.
   *   - This is which of the CONTAINERS arranged here are being aimed at. It is
   *     a fact about the canvas's own arrangement and about nothing else.
   *
   * The first two are claims about somebody's work and are answered by asking
   * what the work is. This one is answered by looking at the screen.
   *
   * ## It is written down, and the passage is not
   *
   * The passage essay a few hundred lines up argues transience, and the
   * argument is that a passage is a claim about a mutable file with nobody left
   * to renew it. Run the same test here and it comes out the other way: this is
   * a claim about the arrangement, the arrangement is exactly what this host
   * stores, and a container that has been picked out is still on the canvas
   * tomorrow. So it rides with the placement — see `selected` in
   * `server/canvases.ts` for why it is a field on the row rather than a second
   * list beside it, which is what stops it ever naming a container that is not
   * there.
   *
   * ## The module was NOT told, and that was a decision; now every module is, and that is another
   *
   * What stood here argued, at length, against putting this on the wire, and
   * the argument is kept because half of it still holds. The pin went on the
   * wire because the host CHANGES WHAT IT SAYS to a pinned module, and silence
   * there manufactures a disagreement; a selected container is sent exactly
   * what an unselected one is sent, so there was no disagreement for a field
   * to prevent. And a module could not act on ITS OWN flag correctly: being
   * selected is a fact about somebody else's aim — an agent was pointed here —
   * and from inside there is no telling "an agent is about to work on me" from
   * "a person ticked a box last Tuesday and forgot". A module that changed its
   * behaviour on the strength of that would change behaviour in a case it
   * cannot detect the end of. All of that was about a module reading a flag
   * about itself, and it is still refused: there is no `context.selected`.
   *
   * What changed it was an ask the old paragraph had not met: "if user selects
   * x number of the modules then we should only show those modules'
   * checklist". That is not a module acting on being selected. It is a
   * CONSUMER — checklists, notes — narrowing its own material to what the
   * picked-out containers are showing, which needs two things the wire did not
   * carry: which containers are picked out, and what each shows. Both go out
   * now, to every module alike, as `context.containers`, composed in
   * `host/showing.ts`. The consumer offers a control in its own header to turn
   * the narrowing off, and when it is left empty it says which containers are
   * picked out — so the tick a person made last Tuesday is a tick they can see
   * as a ring on the canvas, read in the consumer's own sentence, and unpick.
   *
   * The pin's argument is honoured too, from the other side: nothing here
   * changes what the host says to a selected container. Every frame on the
   * kehikko is told the same list, and none is told anything special for being
   * in it. A protocol field that meant "you are the target" is still not
   * built, and the essay on `containerSchema` in the protocol's `wire.ts`
   * says why the two readings are different.
   */
  const onSelect = useCallback(
    (id: string, selected: boolean) => {
      const placements = (open?.placements ?? []).map((p) => (p.i === id ? { ...p, selected } : p))
      change({ placements })
    },
    [change, open?.placements],
  )

  /** Turn following-the-module's-height on or off for one container. */
  const onGrow = useCallback(
    (id: string, grow: boolean) => {
      const placements = (open?.placements ?? []).map((p) => (p.i === id ? { ...p, grow } : p))
      change({ placements })
    },
    [change, open?.placements],
  )

  const onLayoutChange = useCallback(
    (next: Layout[]) => {
      /* `grow` is carried across from what is already stored, because the grid
         has never heard of it: `next` is react-grid-layout's own idea of the
         arrangement, and anything of ours not in its vocabulary would be
         dropped here on the first drag. */
      const was = open?.placements ?? []
      /*
       * Which container, if any, a hand has just let go of the corner of.
       *
       * `next` carries a new `h` for EVERY container a resize touched — the
       * one being pulled and every column-mate `onResize` squeezed or let back
       * out — and only one of those heights was chosen. `resized` was set on
       * `onResizeStart` and names it; the rest are what `granted` drew, and
       * writing THOSE into a wish would be the one thing `columns.ts` says no
       * caller may do. Consumed here rather than cleared on `onResizeStop`,
       * because the library calls that first and this second in the same
       * tick, and cleared at the start of the next gesture in case a release
       * changed nothing and this was never called.
       */
      const held = resized.current
      resized.current = null
      const placements = next.map((item) => {
        const before = was.find((p) => p.i === item.i)
        /*
         * What the hand said, if this is the container it was on: a drag to
         * the folded height is a fold, a drag out of it is an unfold, and any
         * other drag is a new wish. `dragged` in `host/columns.ts` has the
         * argument; a container that was not the one being resized has said
         * nothing, and keeps what it had.
         */
        const said =
          before && held === item.i
            ? dragged(before, item.h)
            : { wish: before?.wish ?? item.h, collapsed: before?.collapsed ?? false }
        return {
          i: item.i,
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
          /* Everything of ours that react-grid-layout has never heard of is
             carried across from what is stored. `next` is its idea of the
             arrangement, so anything not in its vocabulary is dropped here on
             the first drag unless it is copied over deliberately. */
          grow: before?.grow ?? false,
          pinned: before?.pinned ?? false,
          prompt: before?.prompt ?? '',
          promptFor: before?.promptFor ?? null,
          collapsed: said.collapsed,
          wish: said.wish,
          selected: before?.selected ?? false,
          /* Carried across for the same reason as everything above it. A drag is
             not a change of mind about what a container is showing, nor about how
             often it reads. */
          filters: before?.filters ?? {},
          refreshEvery: before?.refreshEvery ?? null,
        }
      })
      /*
       * Then drawn at what the wishes are granted. A move can change who
       * shares a column with whom — a container dragged out of a full column
       * leaves room its mates wished for, one dragged in takes it — and a
       * fold by drag is a fold like any other: the folded container is drawn
       * at one row and its column-mates at their wishes. The heights the grid
       * reported were `onResize`'s answer to the same question with the same
       * wishes, so on a plain resize this changes nothing and costs a walk.
       *
       * react-grid-layout fires this during a drag as well as at the end.
       * Doing nothing when nothing changed keeps the write out of the drag
       * loop — and `Writer` merges what does get through, so a whole gesture
       * is one request rather than forty.
       */
      const drawn = redrawn(placements)
      if (!same(open?.placements ?? [], drawn)) change({ placements: drawn })
    },
    [change, open?.placements],
  )

  const onCreate = useCallback(async () => {
    try {
      /* In the project that is open. A kehikko in no project is one no
         dropdown lists, which is work nobody can get back to. */
      const made = await createCanvas(undefined, projectId)
      setCanvases((was) => [...was, made])
      setOpenId(made.id)
    } catch (error) {
      setTrouble(`A canvas could not be made: ${(error as Error).message}.`)
    }
  }, [projectId])

  /**
   * Open another project.
   *
   * ## What this does NOT do
   *
   * It does not reload anything. VS Code restarts its extension host when the
   * workspace folder changes, and the user chose against that here for the
   * reason this whole architecture exists: reloading destroys every module's
   * document — a terminal mid-command, a half-typed line, every scroll position
   * — and a running shell dies with it. See `Frames.tsx`.
   *
   * So switching a project is exactly two state changes: which project is open,
   * and which kehikko. Every frame stays mounted, keeps its document, and is
   * TOLD — `roadmap.context` goes out with the new project's name and path, and
   * a module re-reads. A module that ignores the new context is no worse off
   * than it was before this existed, which is the bar an addition has to clear.
   *
   * The kehikko is chosen from the new project's own, honouring what this
   * browser remembers only when it belongs there.
   */
  const onProject = useCallback(
    (id: number) => {
      if (id === projectId) return
      /* Sent before the switch, or an arrangement still in flight for the
         kehikko being left would land after the page has moved on. */
      writer.flushAll()
      setProjectId(id)
      setOpenId(chooseOpen(canvases, readOpen(window.localStorage), id))
    },
    [canvases, projectId, writer],
  )

  /**
   * Add a folder as a project, and go and stand in it.
   *
   * The canvases are re-read rather than patched, because adding a project also
   * makes its first kehikko — see `addProject` in `server/projects.ts` — and
   * the page has no way to know its id without asking.
   */
  /**
   * Put one project's `.kehikot/` into its history, or take it out again.
   *
   * The answer replaces the row rather than patching the field that was sent,
   * because the server re-reads the `.gitignore` on the way out. That file is
   * one a person can also edit themselves, and a page that drew back the value
   * it had just sent would agree with itself and possibly with nothing else.
   *
   * The refusal is shown rather than swallowed: this writes a file in somebody's
   * repository, and the one failure that must never be silent is the one where
   * the checkbox moved and the file did not.
   */
  const onShareProject = useCallback(async (id: number, shared: boolean) => {
    try {
      const said = await shareProject(id, shared)
      setProjects((was) => was.map((one) => (one.id === said.id ? said : one)))
      setTrouble(null)
    } catch (error) {
      setTrouble(`That .gitignore was not changed: ${(error as Error).message}`)
    }
  }, [])

  /**
   * Change what one epic is called. Nothing else about it moves.
   *
   * ## The subject is deliberately not touched
   *
   * A retitle is not a pick. `subject.epic` holds a SLUG, the slug has not
   * changed, and every framed module goes on being told exactly what it was
   * told before — no `roadmap.context` goes out, no module re-reads anything,
   * and the kehikko is about the same epic it was about a second ago. That is
   * the whole claim this control makes, and the moment this handler also set a
   * subject it would stop being true.
   *
   * ## Why the list is re-read rather than patched
   *
   * The server sorts epics by title, so the row that was just retitled belongs
   * somewhere else in the list; patching the title in place would leave a
   * picker sorted by what things used to be called. `held` is not cleared
   * first, so the menu shows the list it already had until the new one lands
   * rather than blinking through "reading epics…" under an open dropdown.
   *
   * Answers whether it was written, because the form stays open over a refusal
   * — see `Epics.tsx`. The sentence is the server's own: "A title is at most
   * 200 characters and that one is 640" is something a person can act on.
   */
  const onRetitleEpic = useCallback(
    async (slug: string, title: string): Promise<boolean> => {
      if (projectId === null) return false
      try {
        await retitleEpic(projectId, slug, title)
        setHeld(await fetchEpics(projectId))
        setTrouble(null)
        return true
      } catch (error) {
        setTrouble(`${slug} was not retitled: ${(error as Error).message}`)
        return false
      }
    },
    [projectId],
  )

  /**
   * Make a new epic in the open project, and open it on this kehikko.
   *
   * ## Opening it is the half that makes the button do something
   *
   * A create that left the kehikko on the epic it was on would be a `+` that
   * appears to do nothing: the dropdown gains a row the menu is not open to
   * show, and the person is looking at the same canvas. So the subject moves
   * to the new epic — which is the opposite of what `onRetitleEpic` does, and
   * the opposite of what the door's `create_epic` does, and all three are
   * right. A retitle changes a label, not what the kehikko is about. An agent
   * creating an epic is not the person, and which epic a person is looking at
   * is theirs. A person pressing `+` and typing a title has said, as plainly
   * as a pointer can, that THIS is the epic they want to be on.
   *
   * The list is re-read before the subject moves, so that the select has the
   * row to show as chosen by the time it is chosen; a subject set to a slug
   * the list does not yet hold would draw the slug bare for a frame.
   *
   * Answers whether it was written, for the reason `onRetitleEpic` does: the
   * form stays open over a refusal with the typed title and slug still in it,
   * and the server's sentence — "there is already an epic called that" — goes
   * to the footer, where every other refusal goes.
   */
  const onCreateEpic = useCallback(
    async (slug: string, title: string): Promise<boolean> => {
      if (projectId === null) return false
      try {
        const made = await createEpic(projectId, slug, title)
        setHeld(await fetchEpics(projectId))
        change({ epic: made.epic.slug })
        setTrouble(null)
        return true
      } catch (error) {
        setTrouble(`${slug || 'that epic'} was not created: ${(error as Error).message}`)
        return false
      }
    },
    [projectId, change],
  )

  /**
   * Stop holding a folder as a project. Nothing on disk is deleted.
   *
   * The canvases are re-read rather than filtered here, because forgetting a
   * project takes its kehikot with it by `on delete cascade` and this page has
   * no way to know which ones without asking. If the project being forgotten is
   * the open one, the page moves to whatever is left — the alternative is a
   * header naming a project that no longer exists over a canvas that went with
   * it.
   */
  const onForgetProject = useCallback(
    async (id: number) => {
      try {
        await forgetProject(id)
        const [found, everyProject] = await Promise.all([fetchCanvases(), fetchProjects()])
        setProjects(everyProject)
        setCanvases(found.canvases)
        if (id === projectId) {
          const next = chooseProject(everyProject, null)
          setProjectId(next)
          setOpenId(chooseOpen(found.canvases, null, next))
        }
        setTrouble(null)
      } catch (error) {
        setTrouble(`That project was not forgotten: ${(error as Error).message}`)
      }
    },
    [projectId],
  )

  const onAddProject = useCallback(
    async (path: string) => {
      try {
        const added = await addProject(path)
        const [found, everyProject] = await Promise.all([fetchCanvases(), fetchProjects()])
        setProjects(everyProject)
        setCanvases(found.canvases)
        setProjectId(added.id)
        setOpenId(chooseOpen(found.canvases, null, added.id))
        setTrouble(null)
      } catch (error) {
        /* The server's own sentence. "That is a file. A project is a folder."
           is something a person can act on; a status code is not. */
        setTrouble(`That folder was not added: ${(error as Error).message}`)
      }
    },
    [],
  )

  const onDelete = useCallback(
    async (id: number) => {
      /* Sent before the delete, or a pending arrangement for this canvas would
         arrive after it and recreate nothing, quietly, in a 404 nobody reads. */
      writer.flushAll()
      try {
        await removeCanvas(id)
        setCanvases((was) => {
          const left = was.filter((canvas) => canvas.id !== id)
          setOpenId((current) => (current === id ? (left[0]?.id ?? null) : current))
          return left
        })
      } catch (error) {
        setTrouble((error as Error).message)
      }
    },
    [writer],
  )

  const byId = useMemo(() => {
    const map = new Map<string, Presence>()
    for (const presence of registry?.presences ?? []) map.set(presence.id, presence)
    return map
  }, [registry])

  /** The kehikot of the open project, which is what the header lists. */
  const here = useMemo(() => inProject(canvases, projectId), [canvases, projectId])

  const placements = useMemo(() => open?.placements ?? [], [open?.placements])
  const prompted = placements.find((p) => p.i === prompting) ?? null

  /*
   * What each module on this canvas says its presence implies, from its own
   * manifest. Only modules that are actually ANSWERING have one — a registered
   * program that is not running has no manifest to have said anything in, and
   * telling an agent about a module that is not there would be telling it about
   * a thing it cannot use.
   */
  const guidance = useMemo(() => {
    const said = new Map<string, string>()
    for (const presence of registry?.presences ?? []) {
      const line = presence.module?.guidance?.trim()
      if (line) said.set(presence.id, line)
    }
    return said
  }, [registry])
  /* Every placement, including the ones for modules this computer has no
     registration for — see the effect above for why those are not filtered
     out here, and `Missing.tsx` for what is drawn in their rectangle. */
  const containers = placements

  /*
   * The arrangement as the grid is given it, with one thing added: how tall
   * each container is allowed to become.
   *
   * `maxH` is what makes the bottom of a column something a person FEELS. The
   * resize handle is constrained by it — `calcWH` clamps `h` to `maxH` and the
   * handle's travel is bounded by `mixinResizable` — so pulling a container
   * down past what its column can pay simply does not move any further, which
   * is exactly what happens when you pull one past column twelve. The
   * alternative is a handle that travels, a container that grows, and a snap
   * back to a smaller size on release: the same rule, discovered instead of
   * felt.
   *
   * It agrees with `onResize` by construction rather than by care, because
   * `mostFor` is `granted` asked with this container wishing for the whole
   * canvas — see `columns.ts`. A `maxH` computed separately would eventually
   * stop somewhere nothing happens.
   *
   * Recomputed whenever the arrangement changes, which is what it is a fact
   * about. It is never written down: `onLayoutChange` builds its placements
   * field by field, so nothing of this reaches the database.
   */
  const laid = useMemo(
    () => containers.map((one) => ({ ...one, maxH: mostFor(containers, one.i) }) as Layout),
    [containers],
  )
  const placed = placements.map((p) => p.i)

  /**
   * Every module page that currently has a document, and where each one goes.
   *
   * A page is loaded when its module first appears on the open canvas, and is
   * kept for as long as the module is on ANY canvas — which is what makes
   * switching canvases free for anything the two have in common. It is dropped
   * only when the last canvas holding it lets go, or when its registration
   * disappears; both of those are the module genuinely leaving rather than
   * being looked away from.
   *
   * Held in a ref rather than in state because it is a record of what has been
   * loaded, not a description of what should be on screen. Deriving it every
   * render from the canvases would forget, every render, which is the one thing
   * it exists to do.
   */
  const loadedRef = useRef<Set<string>>(new Set())
  const framings = useMemo<Framing[]>(() => {
    const loaded = loadedRef.current
    const anywhere = new Set(everyPlaced(canvases))
    for (const id of [...loaded]) {
      if (!anywhere.has(id) || !byId.has(id)) loaded.delete(id)
    }
    const onOpen = new Set<string>()
    for (const p of placements) {
      onOpen.add(p.i)
      if (byId.get(p.i)?.module) loaded.add(p.i)
    }

    /* Sorted by id, and see `Frames.tsx`: this order must have nothing to do
       with the layout, because React moves DOM nodes when a keyed list is
       reordered and moving one of these reloads the document inside it. */
    return [...loaded]
      .sort()
      .map((id) => {
        const module = byId.get(id)?.module
        if (!module) return null
        const found = live[id]
        return {
          module,
          rect: rects[id] ?? null,
          /* A folded container's page is HIDDEN, by the same path a page on another
             kehikko is hidden — kept at its size, kept running, and not shown.
             `Frames.tsx` has the argument: unmounting it would destroy the
             document, and there is no getting one of those back. Folding a container
             with a shell in it must not kill the shell. */
          shown:
            onOpen.has(id) &&
            !placements.find((p) => p.i === id)?.collapsed &&
            (found?.condition ?? byId.get(id)?.condition) === 'ready' &&
            !!found,
          state: byId.get(id)?.state ?? null,
          pinned: placements.find((p) => p.i === id)?.pinned ?? false,
          /* Composed here rather than in the module, because only the host
             knows what else is on this kehikko. See the essay on `prompt` in
             the protocol's `wire.ts`. */
          prompt: promptFor(placements, id, guidance),
          /* Reconciled against what the module is offering RIGHT NOW rather
             than sent as stored, so that a value from a version of the module
             that no longer exists degrades to that module's own default instead
             of narrowing by something nobody can see or clear. A module that
             has offered nothing yet — including one that has not been greeted —
             is told `{}`, which is the truth: this host has nothing for it that
             it has said it can use. See `host/filters.ts`. */
          filters: chosen(found?.filters ?? [], placements.find((p) => p.i === id)?.filters ?? {}),
        }
      })
      .filter((framing): framing is Framing => framing !== null)
  }, [byId, canvases, live, placements, rects])

  /* Measure before the browser paints, not after. A canvas switch replaces
     every container in one commit, and a page positioned over where the last
     canvas's container used to be — even for a single frame — is a visible jump. */
  /* A load, and every switch between kehikot, gets a moment with no animation
     while `WidthProvider` measures and the grid re-places everything at the
     real width. Long enough to cover that correction, short enough that a drag
     a person starts immediately still animates normally. */
  useEffect(() => {
    setSettling(true)
    const done = setTimeout(() => setSettling(false), 250)
    return () => clearTimeout(done)
  }, [openId])

  useLayoutEffect(() => {
    measure()
    /* And again for a moment afterwards. Adding a container, removing one, or
       switching canvases all reflow the grid, and the grid reflows by
       animating — so the position that is correct now is not the one that will
       be correct in a fifth of a second. */
    settle()
  }, [measure, settle, openId, placements, containers.length])

  const watcherFor = useCallback(
    (id: string): ConversationWatcher => ({
      ready: () =>
        setLive((was) => ({
          ...was,
          [id]: {
            condition: 'ready',
            line: null,
            fault: was[id]?.fault ?? null,
            filters: was[id]?.filters,
            clear: was[id]?.clear,
            refresh: was[id]?.refresh,
          },
        })),
      silent: (sentence) =>
        setLive((was) => ({
          ...was,
          /* All three offers go with the silence. A module that stopped
             answering is not offering anything, and a control left standing
             over a program that is not there is a press that does nothing and
             says nothing. That matters most for the clear control — a delete
             button over a dead module is a press somebody would make twice,
             believing the first had failed — and it matters for the refresh in
             a way the others do not: what goes with it is a TIME, and a "last
             read 2 minutes ago" beside a module that has stopped answering is
             the host asserting freshness on behalf of a program that is gone. */
          [id]: { condition: 'silent', line: sentence, fault: was[id]?.fault ?? null },
        })),
      fault: (sentence) =>
        setLive((was) => ({
          ...was,
          [id]: {
            condition: was[id]?.condition ?? 'ready',
            line: was[id]?.line ?? null,
            fault: sentence,
            filters: was[id]?.filters,
            clear: was[id]?.clear,
            refresh: was[id]?.refresh,
          },
        })),
      height: (px) => onHeight(id, px),
      filters: (groups) => onOffer(id, groups),
      clearable: (label) => onClearable(id, label),
      refreshable: (state) => onRefreshable(id, state),
    }),
    [onHeight, onOffer, onClearable, onRefreshable],
  )

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Bar
        registry={registry}
        /* This project's kehikot, and no others. The rest are still held in
           `canvases` — see `fetchCanvases` — because the frames layer needs the
           union of every kehikko to know which pages to keep alive. */
        canvases={here}
        open={open}
        placed={placed}
        subject={subject}
        projects={projects}
        project={project}
        held={held}
        onRetitleEpic={onRetitleEpic}
        onCreateEpic={onCreateEpic}
        onProject={onProject}
        onAddProject={(path) => void onAddProject(path)}
        onShareProject={(id, shared) => void onShareProject(id, shared)}
        onForgetProject={(id) => void onForgetProject(id)}
        onOpen={setOpenId}
        onRename={(name) => change({ name })}
        onCreate={() => void onCreate()}
        onDelete={(id) => void onDelete(id)}
        onSubject={setSubject}
        onPlace={onPlace}
        onUnplace={onUnplace}
        focus={focus}
        onFocus={onFocus}
        theme={theme}
        onTheme={onTheme}
        /* The host's own door. The id the server answers for it comes from
           the sweep — `registry.host.id` — so the page never spells the host's
           name itself; see `hostDoor` in `server/register.ts`. */
        onTools={() => {
          if (registry?.host) setToolsFor(registry.host.id)
        }}
      />

      {/*
       * The canvas, and the only row of the shell that gives.
       *
       * `flex-1` takes whatever the strip above and the footer below have not
       * taken, and `overflow-auto` is what happens when the arrangement wants
       * more than that: the CANVAS scrolls, and the window does not. Those are
       * two different behaviours and only one of them is acceptable — a
       * document that scrolls carries the footer off the bottom of the screen,
       * which is the one thing an always-visible strip must not do.
       *
       * `min-h-0` is the load-bearing class and it looks redundant. A flex item
       * defaults to `min-height: auto`, which means "never shrink below your
       * content" — so `flex-1` alone would let a tall arrangement push this
       * row past the bottom of the window, and the `overflow-hidden` on the
       * shell would then CLIP the containers at the bottom rather than letting
       * anybody scroll to them, which is worse than the scrolling page it was
       * meant to prevent. `overflow-auto` happens to force the same `0` today,
       * so this is belt and braces; it is written down because the day
       * somebody changes the overflow the failure is silent and the missing
       * pixels are at the bottom of the screen where nobody is looking.
       *
       * ## And the pages still line up after a scroll
       *
       * Worth being explicit about, because this is where it could have gone
       * wrong. Every module's page is positioned from a measured rectangle
       * rather than by being inside its container — see `Frames.tsx` — and
       * `host/rects.ts` measures in the SURFACE's content coordinates, adding
       * `scrollTop` back to a viewport-relative reading. That is exactly the
       * arithmetic a scrolling canvas needs: the frames layer is inside this
       * element and scrolls with its content, so a page and its container move
       * together and the offset cancels. Measured rather than assumed —
       * `dev/viewport.mjs` scrolls the canvas to the middle of its travel and
       * asserts every page is within zero pixels of its container's body.
       */}
      <main ref={surface} className="relative min-h-0 flex-1 overflow-auto">
        {containers.length === 0 ? <Nothing registry={registry} looking={looking} /> : null}

        {/*
         * Every module's page, loaded once and positioned to line up with the
         * container that asked for it. Outside the grid, because the grid is what
         * comes and goes when somebody switches kehikko — see `Frames.tsx`.
         *
         * UNDER the grid, and that is a correction. It used to be painted on
         * top, which put an iframe over the bottom-right corner of every container —
         * exactly where `react-grid-layout` puts its resize handle. The handle
         * was still there and still worked; nothing could reach it. Containers could
         * not be resized at all, which is also why they ended up stuck at
         * whatever width they last had.
         *
         * So the pages sit beneath and the containers are transparent over them:
         * see `Container.tsx` for the body that lets both light and the pointer
         * through, and `index.css` for the grid item that does the same while
         * keeping its handle live.
         */}
        <Grid
          /* Above the pages, so the container's own chrome — its header, its edge,
             and the resize handle in its corner — is never underneath one. */
          style={{ position: 'relative', zIndex: 1 }}
          /* Keyed by the canvas, so switching them is a new grid rather than
             the same grid being told every container moved at once — which it would
             animate, one canvas melting into the next. */
          key={openId ?? 'none'}
          measureBeforeMount={MEASURE_FIRST}
          className={settling ? 'min-h-full settling' : 'min-h-full'}
          layouts={{ lg: laid }}
          breakpoints={{ lg: 0 }}
          cols={{ lg: COLUMNS }}
          rowHeight={rowHeight}
          /*
           * The canvas has a bottom, the way it has always had a right-hand
           * edge, and this is the line that gives it one.
           *
           * `cols` and `maxRows` are the same kind of statement: the axis has a
           * fixed number of divisions and nothing may exceed them. That is what
           * makes a column's width `room / 12` regardless of the content, and
           * with this it is what makes a row's height `room / 28` regardless of
           * the content — which is the whole of the fix in `fit.ts`.
           *
           * Verified in the library rather than assumed: `maxRows` reaches
           * `calcXY` and `calcWH` in `calculateUtils.js`, which clamp a DRAG to
           * `maxRows - h` and a RESIZE to `maxRows - y`. So a person feels the
           * bottom of the canvas while dragging, rather than discovering
           * afterwards that something was clipped.
           *
           * What it does NOT reach is the compaction that runs when the host
           * writes a placement itself, which is why `roomBelow` exists and why
           * `onHeight` calls it. A module asking to grow is the host writing a
           * placement, and this prop would not have stopped it.
           */
          maxRows={CANVAS_ROWS}
          margin={MARGIN}
          containerPadding={MARGIN}
          draggableHandle=".container-grip"
          onLayoutChange={onLayoutChange}
          /* A container in motion moves by CSS transform, which resizes nothing and
             so tells a `ResizeObserver` nothing. Every move is therefore a
             measurement asked for explicitly, or the pages sit where the containers
             used to be and slide out from under them. `remeasure` is capped at
             once a frame, so a drag costs one measuring pass per painted frame
             and not one per mouse event. */
          onDragStart={(_all, _old, item) => {
            /* A move is not a resize; whatever a release that changed nothing
               left in `resized` must not be read as this gesture's. */
            resized.current = null
            setMoving(item.i)
          }}
          onDrag={() => remeasure()}
          /* `settle`, not one more measurement, and the difference is the whole
             bug. A dropped container does not stay where it was dropped — the grid
             decides where it goes and then GLIDES it there. Measuring once on
             drop reads the spot the hand let go of, and the page is left
             standing there while its container slides away to the spot the grid
             chose. */
          onDragStop={() => {
            setMoving(null)
            settle()
          }}
          onResizeStart={(_all, _old, item) => {
            resized.current = item.i
            setMoving(item.i)
          }}
          /*
           * The column pays for the growth, and it pays WHILE the handle is
           * moving rather than when it is let go.
           *
           * ## Why this can be done here at all
           *
           * Read `onResize` in `react-grid-layout/build/ReactGridLayout.js`: it
           * calls `this.props.onResize(finalLayout, …)` and then, on the very
           * next statement, runs `compact(finalLayout, …)` over the same array
           * and puts the result in its state. The items in that array are the
           * same objects it is about to compact. So a height written here is a
           * height the compaction sees, on this frame, and the neighbours give
           * up their rows as the pointer moves.
           *
           * This is a mutation of somebody else's array, which is not a thing
           * to do lightly, and the alternatives were each worse. The library's
           * answer to a collision is to PUSH — there is no configuration for
           * "take it from the thing below" — so a rule that ran anywhere else
           * would have to let the grid shove a column-mate off the bottom of
           * the canvas first and then correct it. Correcting it in
           * `onLayoutChange` means the correction lands on RELEASE, because
           * `getDerivedStateFromProps` returns `null` for the whole of an
           * `activeDrag`: the person would drag, watch the wrong thing happen,
           * let go, and see it snap. That is the edge discovered afterwards
           * instead of felt, which is the thing this was asked not to be.
           *
           * ## Computed from what is STORED, not from what the grid is holding
           *
           * `open?.placements` does not move during a gesture — the grid only
           * reports a layout change once the drag is over — so every frame of
           * this recomputes the same answer from the same base, and the result
           * is the same whether the pointer moved one pixel or forty. Feeding
           * it the grid's own in-flight layout would be feeding it a value this
           * function had already written, which is how a squeeze compounds into
           * a container that shrinks while you watch.
           *
           * ## What is asked each frame
           *
           * The in-flight height is this container's WISH for the duration of
           * the frame — or, at the folded height, its fold — and every other
           * container keeps the wish it has stored. `wishing` answers with what
           * every wish is granted, which is both directions at once: pulling
           * down squeezes the column below, and pulling back up lets it back
           * out towards its wishes as the pointer moves, rather than on
           * release. `maxH` below means `item.h` has already been clamped to
           * what the column can grant, so in practice the container is drawn
           * at what the hand asked; the map is applied to it anyway so that the
           * one rule decides, and the frame after a fold — when the two
           * disagree briefly — draws what the rule says.
           *
           * Nothing is written here. The wish and the fold land in
           * `onLayoutChange`, on release; this only draws.
           */
          onResize={(layout, _old, item) => {
            const stored = open?.placements ?? []
            const before = stored.find((p) => p.i === item.i)
            const heights = before ? wishing(stored, item.i, dragged(before, item.h)) : granted(stored)
            for (const one of layout) {
              const height = heights.get(one.i)
              if (height !== undefined) one.h = height
            }
            remeasure()
          }}
          onResizeStop={() => {
            setMoving(null)
            settle()
          }}
          /* A container cannot be dropped into another container's space; the grid pushes
             instead. Free placement would let one module hide another, and a
             module a person cannot find is worse than one they have to arrange
             around. */
          compactType="vertical"
          resizeHandles={['se']}
        >
          {containers.map((placement) => {
            const presence = byId.get(placement.i)
            if (!presence) {
              return (
                <div key={placement.i}>
                  <Missing id={placement.i} onRemove={() => onUnplace(placement.i)} />
                </div>
              )
            }
            const found = live[presence.id]
            return (
              <div key={placement.i}>
                <Container
                  presence={presence}
                  condition={found?.condition ?? presence.condition}
                  line={found?.line ?? presence.line}
                  fault={found?.fault ?? null}
                  /* `live` gains an entry the moment the conversation says
                     anything — ready, silent, or a fault. Until then this
                     module has been framed and has not spoken, which is the one
                     thing `condition` cannot express: discovery said `ready`
                     because the manifest read, not because the page answered. */
                  settled={found !== undefined}
                  body={body(presence.id)}
                  grow={placement.grow}
                  onGrow={(grow) => onGrow(presence.id, grow)}
                  pinned={placement.pinned}
                  onPin={(pinned) => onPin(presence.id, pinned)}
                  collapsed={placement.collapsed}
                  onCollapse={(collapsed) => onCollapse(presence.id, collapsed)}
                  /* The offer is the conversation's — it dies with the program —
                     and the choice is the arrangement's. See `Live` above. */
                  filters={found?.filters ?? []}
                  chosen={chosen(found?.filters ?? [], placement.filters)}
                  onChoose={(group, option) => onChooseFilter(presence.id, group, option)}
                  onEverything={() => onEverything(presence.id)}
                  /* `?? null` folds "never said anything" and "said there is
                     nothing to clear" into the one thing the header draws for
                     both, which is nothing. `Live.clear` keeps them apart for
                     whoever is working out why a control is missing. */
                  clear={found?.clear ?? null}
                  /* The press, made at the moment of the press, on whichever
                     frame is standing — see `presses.ts`. Nothing is stored and
                     nothing is replayed: a press at a module that has gone does
                     nothing at all, which is the only correct answer. */
                  onClear={() => presses.press(presence.id)}
                  /* Straight through, and never reconciled against anything the
                     host knows: `at` is the module's statement about its own
                     data. See `Refreshing.tsx`. */
                  refresh={found?.refresh}
                  /* And the setting beside it, which is the host's. The pair is
                     the whole shape of this feature — the module owns the
                     state, the container owns the clock. */
                  refreshEvery={placement.refreshEvery}
                  /* A press, like the clear, on whichever frame is standing.
                     The interval in the effect above calls the same thing. */
                  onRefresh={() => presses.refresh(presence.id)}
                  onRefreshEvery={(every) => onRefreshEvery(presence.id, every)}
                  selected={placement.selected}
                  onSelect={(selected) => onSelect(presence.id, selected)}
                  onPrompts={() => setPrompting(presence.id)}
                  onTools={() => setToolsFor(presence.id)}
                  onStarted={() => void look()}
                  onRemove={() => onUnplace(presence.id)}
                />
              </div>
            )
          })}
        </Grid>

        {/*
         * The frames layer comes AFTER the grid, and that is a tab order rather
         * than a stacking order.
         *
         * The pages still sit beneath the containers: `Grid` below is
         * positioned with `zIndex: 1` and this layer is not, so painting is
         * decided by z-index and is indifferent to which of them is written
         * first. What DOM order decides is where the keyboard goes.
         *
         * Written first, this layer put every module's entire interior ahead of
         * every container's own controls. Tabbing across a canvas of five
         * modules meant traversing a paper reader, a diff and a live terminal —
         * which swallows tab stops by the dozen — before reaching the first
         * fold, pin or remove. Those controls are frequent and small, and they
         * were effectively unreachable by keyboard on any busy canvas.
         *
         * So the chrome is reachable first and each module's interior after it,
         * which is also the order a person would describe the canvas in: the
         * containers, and then what is inside them.
         */}

        <Frames
          framings={framings}
          context={context}
          canvas={controls}
          bus={bus}
          presses={presses}
          watcherFor={watcherFor}
          moving={moving}
        />
      </main>

      {/* The prompt dialog, owned by the host. A module cannot open one: its
          page is in an iframe, so a modal it rendered would be clipped to the
          container. See `Prompts.tsx`. */}
      {prompted ? (
        <Prompts
          open
          onOpenChange={(isOpen) => setPrompting(isOpen ? prompting : null)}
          container={prompted}
          presences={registry?.presences ?? []}
          placements={placements}
          onWrite={(text, aimedAt) => onWritePrompt(prompted.i, text, aimedAt)}
        />
      ) : null}

      {/* The project picker a module gets instead of a listing. Owned by the
          host for the reason every dialog here is — a modal inside a 220-pixel
          frame is not a modal — and for a second reason that is only true of
          this one: what it draws is the host's own material, and the program
          that asked for it must not see any of it except the row somebody
          pressed. See `Picking.tsx`. */}
      <Picking
        projects={projects}
        asking={asking?.name ?? null}
        onPick={onPicked}
        onCancel={onCancelled}
      />

      {/* The tools window, owned by the host for the same reason. It asks the
          host's server what the module's door offers at the moment it opens —
          never on a sweep; see the essay in `server/tools.ts`. `onChanged` is a
          sweep, so the mark on the container catches up with a connect or a
          disconnect without anybody pressing "look again". */}
      {toolsFor ? (
        <ToolsDialog
          open
          onOpenChange={(isOpen) => setToolsFor(isOpen ? toolsFor : null)}
          module={toolsFor}
          /* The host is not in `byId` and must not be looked up as if it were;
             what it is called in this window is what the strip calls it. */
          name={
            toolsFor === registry?.host?.id ? 'this host' : (byId.get(toolsFor)?.name ?? toolsFor)
          }
          onChanged={() => void look()}
        />
      ) : null}

      {/* The floor of the window, and the reason the canvas has a definite
          height to be `flex-1` of. `trouble` — the host's own error line —
          lives here now rather than in a band above the canvas, which used to
          take its height out of the arrangement and move every container the
          moment anything went wrong. See `Footer.tsx` for what else was
          considered for this strip and why none of it is here.

          `onLookAgain` is the same sweep every other caller asks for, and the
          footer offers it only for the one fault where it means anything — see
          `host/reachable.ts`. It is not a restart: nothing in this page can
          restart a server it can only reach through that server. */}
      <Footer trouble={trouble} onLookAgain={() => void look()} looking={looking} />
    </div>
  )
}

/**
 * An empty canvas, explained.
 *
 * The one place the host says anything about itself, and it says it only when
 * there is nothing else on screen. A black rectangle with no modules on it and
 * no words is indistinguishable from a program that failed to start.
 */
function Nothing({ registry, looking }: { registry: RegistryView | null; looking: boolean }) {
  const registered = registry?.presences.length ?? 0
  return (
    <div className="text-muted-foreground pointer-events-none absolute inset-x-0 top-1/3 text-center text-sm">
      {looking && !registry ? (
        <p>Asking every registered program what it is…</p>
      ) : registered ? (
        <p>
          {registered} module{registered === 1 ? '' : 's'} registered, none on this kehikko. Put one here from
          <span className="text-foreground"> modules</span>, above right.
        </p>
      ) : (
        <p>
          Nothing is registered. A module is a program you run; a registration is a file saying where it
          answers.
        </p>
      )}
    </div>
  )
}

function same(a: readonly Placement[], b: readonly Placement[]): boolean {
  if (a.length !== b.length) return false
  return a.every((one, index) => {
    const other = b[index]
    return (
      other !== undefined &&
      one.i === other.i &&
      one.x === other.x &&
      one.y === other.y &&
      one.w === other.w &&
      one.h === other.h &&
      /* The two facts a drag can change besides the rectangle. A drag to the
         folded height changes `h` as well, so these are not strictly needed
         to notice it — but a comparison that ignored them would be one edit
         away from dropping a fold on the floor. */
      one.wish === other.wish &&
      one.collapsed === other.collapsed
    )
  })
}

/**
 * Every placement drawn at what its wish is granted.
 *
 * This is the ONE place on the page a height is written from a rule, and every
 * gesture that changes a wish or a fold goes through it: a drag's release, a
 * press on the fold control, a module asking for room. The rule is `granted`
 * in `host/columns.ts`, and the essay there is why the wish and the height are
 * two numbers. A placement whose height does not change is returned as the
 * same object, so an arrangement that was already drawn right is `same` as
 * before and nothing is written.
 */
function redrawn(placements: readonly Placement[]): Placement[] {
  const heights = granted(placements)
  return placements.map((p) => {
    const h = heights.get(p.i)
    return h === undefined || h === p.h ? p : { ...p, h }
  })
}
