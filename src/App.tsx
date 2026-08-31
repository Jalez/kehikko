import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Responsive, WidthProvider, type Layout } from 'react-grid-layout'
import type { ModuleCondition, Passage } from 'roadmap-module-protocol'

import { Bar } from './canvas/Bar.tsx'
import { Frames, type Framing } from './canvas/Frames.tsx'
import { Prompts } from './canvas/Prompts.tsx'
import { ToolsDialog } from './canvas/Tools.tsx'
import { Container } from './canvas/Container.tsx'
import type { CanvasControls } from './host/ask.ts'
import { EventBus } from './host/events.ts'
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
  reconcile,
  removeCanvas,
  reportOpen,
  unplace,
  watchCanvases,
  writeOpen,
  type Canvas,
  type Placement, unfoldedByResize } from './host/canvases.ts'
import type { ConversationWatcher } from './host/conversation.ts'
import {
  addProject,
  chooseProject,
  fetchEpics,
  fetchProjects,
  readOpenProject,
  writeOpenProject,
  type Epics as HeldEpics,
  type Project,
} from './host/projects.ts'
import { toWireContext, type Subject } from './host/context.ts'
import { useRects } from './host/rects.ts'
import { fetchRegistry, type Presence, type RegistryView } from './host/registry.ts'
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

/** Grid geometry. A small row is a fine-grained resize. */
const ROW_HEIGHT = 24
const MARGIN: [number, number] = [8, 8]

/**
 * How tall a folded container is, in grid rows.
 *
 * Two, because a header is thirty-two pixels and one row is twenty-four. The
 * grid's heights are quantised — `h` rows is `h * 24 + (h - 1) * 8` pixels — so
 * one row cannot hold a header and two rows, at fifty-six, is the first that
 * can.
 *
 * The container does not fill those fifty-six pixels. `Container.tsx` draws a folded container
 * at its own height and leaves the remainder transparent, so what a person sees
 * is a header and nothing else; the extra twenty-two pixels are grid space,
 * spent to keep folded containers on the same grid as everything around them.
 */
const COLLAPSED_ROWS = 1

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
  const { rects, surface, body, measure, remeasure, settle } = useRects()

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
   */
  useEffect(() => {
    const stop = watchCanvases(openId, () => {
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
    })
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
      setTrouble(
        `This host's own server did not answer: ${(error as Error).message}. Nothing is known about what is registered until it does.`,
      )
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
   * Reconcile every canvas against what is registered.
   *
   * A module whose registration file is gone comes off every canvas that held
   * it, which is a real edit and is written like one. On a browser's first
   * visit — and only then — an empty first canvas is filled with whatever is
   * registered, so that a person who has just started this thing sees their own
   * programs instead of a black rectangle. Every visit after that respects the
   * arrangement exactly, including an empty one.
   */
  useEffect(() => {
    if (!loaded.current || !registry) return
    const registered = registry.presences.map((p) => p.id)

    setCanvases((was) =>
      was.map((canvas, index) => {
        const fill = firstVisit.current && index === 0 && canvas.placements.length === 0
        const placements = fill
          ? registered.reduce<Placement[]>((acc, id) => place(acc, id), [])
          : reconcile(canvas.placements, registered)
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

  const context = useMemo(
    () => toWireContext(subject, theme, picked ? picked.split('\n') : [], kehikko, passage),
    /* `pointing` and not `passage`: the value, not the identity. `passage` is
       intentionally absent from the list and the lint rule that would ask for
       it is wrong here — see the essay on `pointing` above. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subject, theme, picked, kehikko, pointing],
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

  /* What a module may ask the canvas to do. See `host/ask.ts`. */
  const controls = useMemo<CanvasControls>(
    () => ({
      /* Moving to a different epic drops the selection. A ref was picked out of
         one epic's references; carrying it into another would leave every
         module pointing at something that is not in front of them any more, and
         "nothing is selected" is a state they all have to handle anyway. */
      showEpic: (epic) => change({ epic, selection: [] }),
      select: (refs) => change({ selection: refs }),
      /* Held for the canvas that is open, and only when it actually CHANGED.
         A module that points on every pointer move during a drag would
         otherwise put a `roadmap.context` into every frame on the canvas per
         event; the sender is asked not to do that, and this is the half of the
         bargain the host can keep on its own — a host cannot make somebody
         else's program debounce, and it can refuse to repeat itself. */
      point: (next) =>
        setPassagesRef.current((was) => {
          const id = openRef.current
          if (id === null) return was
          const had = was[id] ?? null
          if (JSON.stringify(had ?? null) === JSON.stringify(next ?? null)) return was
          return { ...was, [id]: next }
        }),
      /* `from` arrives already decided — `makeAsk` supplies it out of the
         registration the conversation was built on, and nothing the frame said
         can reach it. This end only adds where the canvas is. */
      emit: (from, extension, payload) => bus.emit(from, extension, payload, kehikkoRef.current),
      /* An id, read now. The server turns it into a folder out of its own
         table — see `project` on `CanvasControls` for why a path must not come
         from this side. */
      project: () => projectRef.current,
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
   * only ever GROWS towards the requested height and never past `MOST_ROWS`, so
   * the worst case is bounded and reachable. And growth stops as soon as the
   * request is no longer meaningfully larger than the container — a page that fills
   * whatever frame it is given reports the frame's own height, which after one
   * step is the height it already has, and the climb ends there instead of
   * continuing by a rounding error a step.
   */
  /** Forty rows is a tall container on any screen and nowhere near a runaway. */
  const MOST_ROWS = 40
  /** Below this, a request is agreement rather than a request. */
  const WORTH_GROWING_PX = 12

  const onHeight = useCallback(
    (id: string, px: number) => {
      const placements = open?.placements ?? []
      const container = placements.find((p) => p.i === id)
      if (!container?.grow) return

      /*
       * A collapsed container does not grow, and the request is not thrown away.
       *
       * `roadmap.resize` is a module saying how tall its document is. A module
       * has not been told its container is folded — deliberately; see `onCollapse` —
       * so it goes on measuring and asking, and honouring that here would let a
       * module force a container open that a person folded shut. The person's press
       * wins. What the module asked for is remembered as the height to unfold
       * to, so a module that grew while folded is the right size when it comes
       * back rather than the size it was when it was put away.
       */
      if (container.collapsed) {
        const wanted = Math.min(MOST_ROWS, Math.ceil((px + MARGIN[1]) / (ROW_HEIGHT + MARGIN[1])))
        if (wanted <= (container.openH ?? 0)) return
        change({ placements: placements.map((p) => (p.i === id ? { ...p, openH: wanted } : p)) })
        return
      }

      const isNow = container.h * ROW_HEIGHT + (container.h - 1) * MARGIN[1]
      if (px <= isNow + WORTH_GROWING_PX) return

      const rows = Math.min(MOST_ROWS, Math.ceil((px + MARGIN[1]) / (ROW_HEIGHT + MARGIN[1])))
      if (rows <= container.h) return
      change({ placements: placements.map((p) => (p.i === id ? { ...p, h: rows } : p)) })
    },
    [change, open?.placements],
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
   * ## What is kept, and why the height is remembered
   *
   * Folding writes the container's current height into `openH` and sets `h` to two
   * rows, which is the smallest the grid can be while still holding a
   * thirty-two pixel header. Unfolding puts `openH` back.
   *
   * Remembered rather than recomputed, and the difference matters more than it
   * sounds: a container that unfolded to a default height would move everything
   * below it on the canvas, and nothing the person did asked for that. They
   * folded a container and unfolded it; the arrangement they built should be the
   * arrangement they get back.
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
      const placements = (open?.placements ?? []).map((p) => {
        if (p.i !== id) return p
        return collapsed
          ? { ...p, collapsed: true, openH: p.h, h: COLLAPSED_ROWS }
          : { ...p, collapsed: false, h: p.openH ?? p.h, openH: null }
      })
      change({ placements })
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
   * ## The module is NOT told, and this is a decision
   *
   * The obvious objection is that a module that knew it was selected could show
   * it, and the answer is the one `onCollapse` gives about folding, sharpened
   * by what happened with the pin.
   *
   * The pin went on the wire because the host CHANGES WHAT IT SAYS to a pinned
   * module: it stops telling it about the canvas, and a module that was not
   * told would describe a remembered epic as the open one. Silence there
   * manufactures a disagreement between what the module says and what is true.
   * Nothing of the kind happens here. A selected container is sent exactly the
   * same context as an unselected one, is asked exactly the same questions, and
   * has exactly the same material. There is no disagreement for the field to
   * prevent.
   *
   * And a module could not act on it correctly if it had it. Being selected is
   * a fact about somebody else's aim — an agent was pointed here — not about
   * the module's own work, and from inside there is no telling "an agent is
   * about to work on me" from "a person ticked a box last Tuesday and forgot".
   * A module that changed its behaviour on the strength of it would change
   * behaviour in a case it cannot detect the end of.
   *
   * So there is no protocol change, no version bump, and no essay in
   * `wire.ts` — and this paragraph is the host saying why in its own code,
   * which is the price of not putting it on the wire. If a module ever needs
   * this, what it needs is a way to ASK, not a field it is handed.
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
      const placements = next.map((item) => {
        const before = was.find((p) => p.i === item.i)
        /*
         * Dragging a folded container taller unfolds it.
         *
         * Without this the grid took the new height and the container kept
         * `collapsed`, so the row grew and the container went on drawing nothing
         * but its header — a person pulling the corner made a gap appear and
         * concluded the handle was broken. Refusing the resize outright would be
         * worse: a handle that does not move is a handle somebody keeps pulling.
         *
         * Reaching for the corner of a folded container is a person saying "I want
         * to see this", which is the same sentence the fold control says. So it
         * is honoured as one, and the height they dragged to becomes the height
         * it opens at — better than `openH`, which is where it was folded FROM
         * and not where they have just asked it to be.
         *
         * Only a taller drag counts. `h` also arrives unchanged on every drag
         * of a neighbour, and equal-or-smaller cannot be a request to see more.
         */
        const unfolding = unfoldedByResize(before, item.h, COLLAPSED_ROWS)
        return {
        i: item.i,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        /* Everything of ours that react-grid-layout has never heard of is
           carried across from what is stored. `next` is its idea of the
           arrangement, so anything not in its vocabulary is dropped here on the
           first drag unless it is copied over deliberately. */
        grow: before?.grow ?? false,
        pinned: before?.pinned ?? false,
        prompt: before?.prompt ?? '',
        promptFor: before?.promptFor ?? null,
        collapsed: unfolding ? false : (before?.collapsed ?? false),
        /* Cleared with the fold, so a later fold remembers where it was folded
           from rather than a height from two gestures ago. */
        openH: unfolding ? null : (before?.openH ?? null),
        selected: before?.selected ?? false,
      }
      })
      /* react-grid-layout fires this during a drag as well as at the end. Doing
         nothing when nothing changed keeps the write out of the drag loop —
         and `Writer` merges what does get through, so a whole gesture is one
         request rather than forty. */
      if (!same(open?.placements ?? [], placements)) change({ placements })
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
  const containers = placements.filter((p) => byId.has(p.i))
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
          [id]: { condition: 'ready', line: null, fault: was[id]?.fault ?? null },
        })),
      silent: (sentence) =>
        setLive((was) => ({
          ...was,
          [id]: { condition: 'silent', line: sentence, fault: was[id]?.fault ?? null },
        })),
      fault: (sentence) =>
        setLive((was) => ({
          ...was,
          [id]: {
            condition: was[id]?.condition ?? 'ready',
            line: was[id]?.line ?? null,
            fault: sentence,
          },
        })),
      height: (px) => onHeight(id, px),
    }),
    [onHeight],
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
        onProject={onProject}
        onAddProject={(path) => void onAddProject(path)}
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
      />

      {trouble ? (
        <p className="text-destructive-foreground bg-destructive/80 shrink-0 px-3 py-1.5 text-xs">{trouble}</p>
      ) : null}

      <main ref={surface} className="relative flex-1 overflow-auto">
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
        <Frames
          framings={framings}
          context={context}
          canvas={controls}
          bus={bus}
          watcherFor={watcherFor}
          moving={moving}
        />

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
          layouts={{ lg: containers as Layout[] }}
          breakpoints={{ lg: 0 }}
          cols={{ lg: COLUMNS }}
          rowHeight={ROW_HEIGHT}
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
          onDragStart={(_all, _old, item) => setMoving(item.i)}
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
          onResizeStart={(_all, _old, item) => setMoving(item.i)}
          onResize={() => remeasure()}
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
            if (!presence) return null
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
          name={byId.get(toolsFor)?.name ?? toolsFor}
          onChanged={() => void look()}
        />
      ) : null}
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
      one.h === other.h
    )
  })
}
