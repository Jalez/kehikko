import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Responsive, WidthProvider, type Layout } from 'react-grid-layout'
import type { ModuleCondition } from 'roadmap-module-protocol'

import { Bar } from './canvas/Bar.tsx'
import { Frames, type Framing } from './canvas/Frames.tsx'
import { Prompts } from './canvas/Prompts.tsx'
import { ToolsDialog } from './canvas/Tools.tsx'
import { Pane } from './canvas/Pane.tsx'
import type { CanvasControls } from './host/ask.ts'
import { EventBus } from './host/events.ts'
import {
  chooseOpen,
  COLUMNS,
  createCanvas,
  editCanvas,
  everyPlaced,
  fetchCanvases,
  place,
  promptFor,
  readOpen,
  reconcile,
  removeCanvas,
  unplace,
  writeOpen,
  type Canvas,
  type Placement,
} from './host/canvases.ts'
import type { ConversationWatcher } from './host/conversation.ts'
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
 * `Writer`, because a canvas that waited for a round trip before showing a pane
 * where it was dropped would feel broken on a machine that is not busy at all.
 */

const Grid = WidthProvider(Responsive)

/**
 * `measureBeforeMount`, and why it is off.
 *
 * It is tempting, and it was on for an hour. `WidthProvider` renders once at a
 * hardcoded default of 1280 pixels, measures the element it rendered into, and
 * renders again with the real width — so the first paint of every load places
 * the panes with the wrong column width. `measureBeforeMount` is the library's
 * own answer: render nothing until the measurement exists.
 *
 * With it on, the measurement never arrives. The grid stays at 1280 for the
 * life of the page, on a canvas of any other width, and the damage is not a
 * subtle misalignment — column six lands at four pixels instead of seven
 * hundred, so a pane placed beside another is drawn on top of it, and a pane
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
 * How tall a folded pane is, in grid rows.
 *
 * Two, because a header is thirty-two pixels and one row is twenty-four. The
 * grid's heights are quantised — `h` rows is `h * 24 + (h - 1) * 8` pixels — so
 * one row cannot hold a header and two rows, at fifty-six, is the first that
 * can.
 *
 * The pane does not fill those fifty-six pixels. `Pane.tsx` draws a folded pane
 * at its own height and leaves the remainder transparent, so what a person sees
 * is a header and nothing else; the extra twenty-two pixels are grid space,
 * spent to keep folded panes on the same grid as everything around them.
 */
const COLLAPSED_ROWS = 2

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
   * itself, and the pane falls back to what discovery wrote.
   *
   * Null rather than an empty string, because an empty string is a sentence as
   * far as `??` is concerned, and the pane would show nothing where it meant to
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
  const [live, setLive] = useState<Record<string, Live>>({})
  /* Which pane is being dragged or resized, if any — see `Frames.tsx` for why
     the pages stop taking the pointer for the duration, and why the one under
     the hand is hidden rather than chased. */
  const [moving, setMoving] = useState<string | null>(null)
  /* Read from the document rather than worked out again. The blocking script in
     `index.html` already decided this before anything was painted, and a second
     implementation of that decision is a second thing that can be wrong — see
     `host/theme.ts`. */
  const [theme, setTheme] = useState<Theme>(() => current())
  /* Whether the pane headers are out of the layout. Read from the document for
     the same reason the theme is: a blocking script in `index.html` already
     decided this before anything was painted, and a second implementation of
     that decision is a second thing that can be wrong. See `host/focus.ts`. */
  const [focus, setFocus] = useState<Focus>(() => focused())
  /* Whether the grid is still finding its width. While it is, its own
     transitions are off — see `.settling` in `index.css` for the slide that
     otherwise happens on every load. */
  const [settling, setSettling] = useState(true)
  /* Which pane's prompts are being written, if any. The dialog belongs to the
     host rather than to a module — see `Prompts.tsx` for why a modal inside an
     iframe is not a modal. */
  const [prompting, setPrompting] = useState<string | null>(null)
  /* Which module's tools are being looked at, if any. The host's window for the
     same reason the prompt one is: a module cannot open a modal bigger than its
     own pane, and what this window shows is not the module's material anyway —
     it is what the AGENT has been told. See `Tools.tsx`. */
  const [toolsFor, setToolsFor] = useState<string | null>(null)

  /* Where each pane's body ended up, measured. The module pages are positioned
     over these from a layer that outlives the panes. */
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
        setCanvases(found)
        setOpenId(chooseOpen(found, remembered))
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
      project?: string | null
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

  const subject = useMemo<Subject>(
    () => ({ epic: open?.epic ?? null, project: open?.project ?? null }),
    [open?.epic, open?.project],
  )

  const setSubject = useCallback(
    (next: Subject) => change({ epic: next.epic, project: next.project }),
    [change],
  )

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
  const context = useMemo(
    () => toWireContext(subject, theme, picked ? picked.split('\n') : [], kehikko),
    [subject, theme, picked, kehikko],
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
      /* `from` arrives already decided — `makeAsk` supplies it out of the
         registration the conversation was built on, and nothing the frame said
         can reach it. This end only adds where the canvas is. */
      emit: (from, extension, payload) => bus.emit(from, extension, payload, kehikkoRef.current),
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
   * ## Why this is opt-in per pane
   *
   * Honouring it everywhere was tried twice and fought the person both times.
   *
   * *Grow whenever asked* has a runaway in it. A module measures its own
   * document; its document is as tall as the frame the host gave it; so growing
   * the pane grows the document, which asks for more. It does not oscillate, it
   * climbs — one pane here reached eighty rows, two and a half thousand pixels,
   * pushing its own resize handle off the bottom of the canvas where nothing
   * could reach it.
   *
   * *Grow once per load* bounds the runaway and keeps the argument, just
   * slower: a pane smaller than its module's content is grown again on every
   * refresh. You size a pane, reload, and it is bigger. A disagreement that
   * resumes each time the page opens is not a compromise.
   *
   * What was wrong in both is that the host was deciding. Whether a pane should
   * fit its contents or hold its size is a question about how somebody wants to
   * read this particular thing, and there is no answer that is right for every
   * pane — a list you scan wants to stay put and scroll; a summary you want to
   * see all of wants to fit. So it is a switch on the pane, off by default,
   * remembered with the arrangement.
   *
   * ## The brake stays even when it is on
   *
   * Opting in must not opt into the runaway. Two things prevent it. The pane
   * only ever GROWS towards the requested height and never past `MOST_ROWS`, so
   * the worst case is bounded and reachable. And growth stops as soon as the
   * request is no longer meaningfully larger than the pane — a page that fills
   * whatever frame it is given reports the frame's own height, which after one
   * step is the height it already has, and the climb ends there instead of
   * continuing by a rounding error a step.
   */
  /** Forty rows is a tall pane on any screen and nowhere near a runaway. */
  const MOST_ROWS = 40
  /** Below this, a request is agreement rather than a request. */
  const WORTH_GROWING_PX = 12

  const onHeight = useCallback(
    (id: string, px: number) => {
      const placements = open?.placements ?? []
      const pane = placements.find((p) => p.i === id)
      if (!pane?.grow) return

      /*
       * A collapsed pane does not grow, and the request is not thrown away.
       *
       * `roadmap.resize` is a module saying how tall its document is. A module
       * has not been told its pane is folded — deliberately; see `onCollapse` —
       * so it goes on measuring and asking, and honouring that here would let a
       * module force a pane open that a person folded shut. The person's press
       * wins. What the module asked for is remembered as the height to unfold
       * to, so a module that grew while folded is the right size when it comes
       * back rather than the size it was when it was put away.
       */
      if (pane.collapsed) {
        const wanted = Math.min(MOST_ROWS, Math.ceil((px + MARGIN[1]) / (ROW_HEIGHT + MARGIN[1])))
        if (wanted <= (pane.openH ?? 0)) return
        change({ placements: placements.map((p) => (p.i === id ? { ...p, openH: wanted } : p)) })
        return
      }

      const isNow = pane.h * ROW_HEIGHT + (pane.h - 1) * MARGIN[1]
      if (px <= isNow + WORTH_GROWING_PX) return

      const rows = Math.min(MOST_ROWS, Math.ceil((px + MARGIN[1]) / (ROW_HEIGHT + MARGIN[1])))
      if (rows <= pane.h) return
      change({ placements: placements.map((p) => (p.i === id ? { ...p, h: rows } : p)) })
    },
    [change, open?.placements],
  )

  /**
   * Pin a pane, or let it go.
   *
   * A pinned pane keeps whatever it was last told and hears nothing further
   * about this canvas — which is how two panes end up on two different epics,
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

  /** Write what one pane says, and who it says it to. */
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
   * Fold a pane down to its header, or unfold it.
   *
   * ## What is kept, and why the height is remembered
   *
   * Folding writes the pane's current height into `openH` and sets `h` to two
   * rows, which is the smallest the grid can be while still holding a
   * thirty-two pixel header. Unfolding puts `openH` back.
   *
   * Remembered rather than recomputed, and the difference matters more than it
   * sounds: a pane that unfolded to a default height would move everything
   * below it on the canvas, and nothing the person did asked for that. They
   * folded a pane and unfolded it; the arrangement they built should be the
   * arrangement they get back.
   *
   * ## The module keeps running, and is not told
   *
   * Folding is not removing. The module's document stays in the frames layer
   * with everything in it — a scroll position, a half-typed line, a shell
   * session — for exactly the reason `Frames.tsx` exists: an iframe that leaves
   * the DOM is a document that has been destroyed, and there is no way to get
   * it back. A folded pane's page is hidden the same way a pane on another
   * canvas is hidden, which is a path this program has had since the beginning.
   *
   * Nothing goes out on the wire, and `roadmap.context` does not grow a field.
   * This is a real judgement call rather than an oversight: one could argue a
   * module ought to know it is not visible so it can stop polling. It should
   * not learn it from HERE, because it could not act on it correctly — from
   * inside, a folded pane is indistinguishable from a pane on a kehikko nobody
   * is looking at, and the protocol deliberately does not report that either.
   * A module that stopped work on the strength of this would stop work in a
   * case it cannot detect and resume in a case it cannot detect. Whether the
   * host drew a pane at full height is the host's business.
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

  /** Turn following-the-module's-height on or off for one pane. */
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
      const placements = next.map((item) => ({
        i: item.i,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        /* Everything of ours that react-grid-layout has never heard of is
           carried across from what is stored. `next` is its idea of the
           arrangement, so anything not in its vocabulary is dropped here on the
           first drag unless it is copied over deliberately. */
        grow: was.find((p) => p.i === item.i)?.grow ?? false,
        pinned: was.find((p) => p.i === item.i)?.pinned ?? false,
        prompt: was.find((p) => p.i === item.i)?.prompt ?? '',
        promptFor: was.find((p) => p.i === item.i)?.promptFor ?? null,
        collapsed: was.find((p) => p.i === item.i)?.collapsed ?? false,
        openH: was.find((p) => p.i === item.i)?.openH ?? null,
      }))
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
      const made = await createCanvas()
      setCanvases((was) => [...was, made])
      setOpenId(made.id)
    } catch (error) {
      setTrouble(`A canvas could not be made: ${(error as Error).message}.`)
    }
  }, [])

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
  const panes = placements.filter((p) => byId.has(p.i))
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
          /* A folded pane's page is HIDDEN, by the same path a page on another
             kehikko is hidden — kept at its size, kept running, and not shown.
             `Frames.tsx` has the argument: unmounting it would destroy the
             document, and there is no getting one of those back. Folding a pane
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
     every pane in one commit, and a page positioned over where the last
     canvas's pane used to be — even for a single frame — is a visible jump. */
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
    /* And again for a moment afterwards. Adding a pane, removing one, or
       switching canvases all reflow the grid, and the grid reflows by
       animating — so the position that is correct now is not the one that will
       be correct in a fifth of a second. */
    settle()
  }, [measure, settle, openId, placements, panes.length])

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
        canvases={canvases}
        open={open}
        placed={placed}
        subject={subject}
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
        {panes.length === 0 ? <Nothing registry={registry} looking={looking} /> : null}

        {/*
         * Every module's page, loaded once and positioned to line up with the
         * pane that asked for it. Outside the grid, because the grid is what
         * comes and goes when somebody switches kehikko — see `Frames.tsx`.
         *
         * UNDER the grid, and that is a correction. It used to be painted on
         * top, which put an iframe over the bottom-right corner of every pane —
         * exactly where `react-grid-layout` puts its resize handle. The handle
         * was still there and still worked; nothing could reach it. Panes could
         * not be resized at all, which is also why they ended up stuck at
         * whatever width they last had.
         *
         * So the pages sit beneath and the panes are transparent over them:
         * see `Pane.tsx` for the body that lets both light and the pointer
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
          /* Above the pages, so the pane's own chrome — its header, its edge,
             and the resize handle in its corner — is never underneath one. */
          style={{ position: 'relative', zIndex: 1 }}
          /* Keyed by the canvas, so switching them is a new grid rather than
             the same grid being told every pane moved at once — which it would
             animate, one canvas melting into the next. */
          key={openId ?? 'none'}
          measureBeforeMount={MEASURE_FIRST}
          className={settling ? 'min-h-full settling' : 'min-h-full'}
          layouts={{ lg: panes as Layout[] }}
          breakpoints={{ lg: 0 }}
          cols={{ lg: COLUMNS }}
          rowHeight={ROW_HEIGHT}
          margin={MARGIN}
          containerPadding={MARGIN}
          draggableHandle=".pane-grip"
          onLayoutChange={onLayoutChange}
          /* A pane in motion moves by CSS transform, which resizes nothing and
             so tells a `ResizeObserver` nothing. Every move is therefore a
             measurement asked for explicitly, or the pages sit where the panes
             used to be and slide out from under them. `remeasure` is capped at
             once a frame, so a drag costs one measuring pass per painted frame
             and not one per mouse event. */
          onDragStart={(_all, _old, item) => setMoving(item.i)}
          onDrag={() => remeasure()}
          /* `settle`, not one more measurement, and the difference is the whole
             bug. A dropped pane does not stay where it was dropped — the grid
             decides where it goes and then GLIDES it there. Measuring once on
             drop reads the spot the hand let go of, and the page is left
             standing there while its pane slides away to the spot the grid
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
          /* A pane cannot be dropped into another pane's space; the grid pushes
             instead. Free placement would let one module hide another, and a
             module a person cannot find is worse than one they have to arrange
             around. */
          compactType="vertical"
          resizeHandles={['se']}
        >
          {panes.map((placement) => {
            const presence = byId.get(placement.i)
            if (!presence) return null
            const found = live[presence.id]
            return (
              <div key={placement.i}>
                <Pane
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
          pane. See `Prompts.tsx`. */}
      {prompted ? (
        <Prompts
          open
          onOpenChange={(isOpen) => setPrompting(isOpen ? prompting : null)}
          pane={prompted}
          presences={registry?.presences ?? []}
          placements={placements}
          onWrite={(text, aimedAt) => onWritePrompt(prompted.i, text, aimedAt)}
        />
      ) : null}

      {/* The tools window, owned by the host for the same reason. It asks the
          host's server what the module's door offers at the moment it opens —
          never on a sweep; see the essay in `server/tools.ts`. `onChanged` is a
          sweep, so the mark on the pane catches up with a connect or a
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
