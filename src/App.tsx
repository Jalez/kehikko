import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Responsive, WidthProvider, type Layout } from 'react-grid-layout'
import type { ModuleCondition } from 'roadmap-module-protocol'

import { Bar } from './canvas/Bar.tsx'
import { Frames, type Framing } from './canvas/Frames.tsx'
import { Pane } from './canvas/Pane.tsx'
import type { CanvasControls } from './host/ask.ts'
import {
  chooseOpen,
  COLUMNS,
  createCanvas,
  editCanvas,
  everyPlaced,
  fetchCanvases,
  place,
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

/** Grid geometry. One row is small enough that a resize request lands close. */
const ROW_HEIGHT = 24
const MARGIN: [number, number] = [8, 8]
/** The pane header, which a module's requested height does not include. */
const HEADER_PX = 32

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
  /* Whether the grid is still finding its width. While it is, its own
     transitions are off — see `.settling` in `index.css` for the slide that
     otherwise happens on every load. */
  const [settling, setSettling] = useState(true)

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

  const look = useCallback(async () => {
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
      setLooking(false)
    }
  }, [])

  useEffect(() => {
    void look()
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
    (edit: { name?: string; epic?: string | null; project?: string | null; placements?: Placement[] }) => {
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
  const context = useMemo(() => toWireContext(subject, theme), [subject, theme])

  const onTheme = useCallback(() => {
    setTheme((was) => {
      const next = other(was)
      apply(next)
      return next
    })
  }, [])

  /* What a module may ask the canvas to do. See `host/ask.ts`. */
  const controls = useMemo<CanvasControls>(
    () => ({ showEpic: (epic) => change({ epic }) }),
    [change],
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
   * A module asking to be taller.
   *
   * ## Why this is allowed at most once, and never after a person has resized
   *
   * The obvious rule — "grow whenever a module asks for more" — has a runaway
   * in it, and it is not subtle once seen. A module measures its own document.
   * Its document is as tall as the frame the host gave it. So the host grows the
   * pane, the frame gets taller, the document gets taller, the module reports a
   * larger height, and the host grows the pane again. It does not oscillate; it
   * climbs. One pane here reached eighty rows — two and a half thousand pixels —
   * pushing its own resize handle so far down the canvas that it could not be
   * reached, which is a very odd-looking bug for what is really a loop with no
   * exit.
   *
   * Nothing in the protocol can prevent that from the module's side: reporting
   * `scrollHeight` is the correct and obvious thing for a module to do, and any
   * page whose content fills the space it is given will report the space it was
   * given. The brake has to be here.
   *
   * So a request is honoured once per module per page load — enough for a page
   * that opens shorter than its content to be given room — and not at all once
   * the person has taken hold of the pane themselves. Their size is an
   * instruction; the module's is a suggestion, and a suggestion does not get to
   * repeat itself until it wins.
   */
  const grown = useRef(new Set<string>())
  const sized = useRef(new Set<string>())
  /** Forty rows is a tall pane on any screen and nowhere near a runaway. */
  const MOST_ROWS = 40

  const onHeight = useCallback(
    (id: string, px: number) => {
      if (grown.current.has(id) || sized.current.has(id)) return
      const rows = Math.min(
        MOST_ROWS,
        Math.ceil((px + HEADER_PX + MARGIN[1]) / (ROW_HEIGHT + MARGIN[1])),
      )
      const placements = (open?.placements ?? []).map((p) =>
        p.i === id && rows > p.h ? { ...p, h: rows } : p,
      )
      grown.current.add(id)
      if (!same(open?.placements ?? [], placements)) change({ placements })
    },
    [change, open?.placements],
  )

  const onLayoutChange = useCallback(
    (next: Layout[]) => {
      const placements = next.map((item) => ({ i: item.i, x: item.x, y: item.y, w: item.w, h: item.h }))
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
          shown: onOpen.has(id) && (found?.condition ?? byId.get(id)?.condition) === 'ready' && !!found,
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
        onLookAgain={() => void look()}
        looking={looking}
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
          onResizeStop={(_all, _old, item) => {
            /* From here on this pane is the person's. A module may not ask for
               height again — see `onHeight` for the loop that rule exists to
               stop, and for why a person's size outranks a module's. */
            sized.current.add(item.i)
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
                  onRemove={() => onUnplace(presence.id)}
                />
              </div>
            )
          })}
        </Grid>
      </main>
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
