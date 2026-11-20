import { useCallback, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { flushSync } from 'react-dom'
import type { DocumentEvent } from '@/canvas/ModuleFrame.tsx'
import type { Framing } from '@/canvas/Frames.tsx'
import type { Finds } from '@/canvas/useFinds.ts'
import type { useRestarts } from '@/canvas/useRestarts.ts'
import type { useAppearance } from '@/host/appearanceStore.ts'
import { everyPlaced, framesKept, promptFor, recentlyOpen, type Canvas, type Placement } from '@/host/canvases.ts'
import type { ConversationWatcher } from '@/host/conversation.ts'
import { handOnDrop } from '@/host/drops.ts'
import { EXPANDED_BODY, type Expanded as ExpandedOne } from '@/host/expand.ts'
import { chosen, remembered } from '@/host/filters.ts'
import type { FooterStore } from '@/host/footerStore.ts'
import { declared, withdrawn, type Headers } from '@/host/header.ts'
import { keptFor } from '@/host/kept.ts'
import type { Presses } from '@/host/presses.ts'
import type { useRects } from '@/host/rects.ts'
import type { Presence } from '@/host/registry.ts'
import { coversFor, type Reveals } from '@/host/reveal.ts'
import type { ClickEvent } from '@/host/rows.ts'
import { forgotten, type Said } from '@/host/said.ts'
import { coveredForScope, keptScope, scopeOfContainer, scopeToTell } from '@/host/scope.ts'
import { Covers, showing } from '@/host/standing.ts'
import { tellStartup } from '@/host/startupReport.ts'
import type { subjectOf } from '@/host/subject.ts'
import { drawsOwnTile, tileHidesPage } from '@/host/tile.ts'
import { pinnedPresence, type PinView } from '@/host/versions.ts'
import type { Live } from './live.ts'

/*
 * The module pages on the canvas, as the page keeps them: what each frame
 * found (`live`, and the covers held over a page that is drawing or loading),
 * which pages have a document and where each goes (`framings`), and what each
 * frame's conversation reports (`watcherFor`, `onDocument`).
 *
 * Moved out of `App.tsx` as it was, in three hooks called where their parts
 * stood: the findings near the top of the page, which reads them early; the
 * framings where the canvas's placements and measurements are in hand; the
 * watchers below the find bars they report to. Memo dependencies are as they
 * were — including what they deliberately leave out (`restarts`, `guidance`).
 */

/** What each frame found, and the covers it holds up. */
export function useFrameStates() {
  const [live, setLive] = useState<Record<string, Live>>({})
  /* The frames whose page answered `ready { hold: true }` and has not said it is
     drawn (protocol 2.70.0): their cover stays up. See `Found.held`. */
  const [drawing, setDrawing] = useState<ReadonlySet<string>>(() => new Set())
  /* The frames covered as loading, with the module's own words or `null` (protocol 2.84.0): inside a
     held greeting (`drawing`), the held cover's words; otherwise a page that said `kehikot.loading`
     after a context and was not drawn in time, covered over its place until `kehikot.drawn`. */
  const [loadingCovers, setLoadingCovers] = useState<ReadonlyMap<string, string | null>>(() => new Map())
  const setLoadingOf = useCallback((id: string, label: string | null | undefined) => {
    setLoadingCovers((was) => {
      if (label === undefined ? !was.has(id) : was.has(id) && was.get(id) === label) return was
      const next = new Map(was)
      if (label === undefined) next.delete(id)
      else next.set(id, label)
      return next
    })
  }, [])
  const setDrawingOf = useCallback((id: string, on: boolean) => {
    setDrawing((was) => {
      if (was.has(id) === on) return was
      const next = new Set(was)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  /* What each frame found, for `Runs.seen` inside `take`: a ref, because reading it should cause no render. */
  const liveRef = useRef(live)
  liveRef.current = live

  /* Arms the cover: forgetting what a conversation found is what puts it up.
     See `Covers` in `host/standing.ts` for when, and for the grace. */
  const covers = useMemo(
    () =>
      new Covers((id) =>
        setLive((was) => {
          if (!(id in was)) return was
          const { [id]: _gone, ...rest } = was
          return rest
        }),
      ),
    [],
  )

  return { live, setLive, liveRef, drawing, loadingCovers, setLoadingOf, setDrawingOf, covers }
}

export interface FramingInputs {
  byId: ReadonlyMap<string, Presence>
  canvases: readonly Canvas[]
  /** The open kehikko, and its placements as drawn. */
  open: { id: number } | null
  openId: number | null
  placements: readonly Placement[]
  live: Readonly<Record<string, Live>>
  drawing: ReadonlySet<string>
  loadingCovers: ReadonlyMap<string, string | null>
  staleOf: (id: string, found: Live | undefined) => boolean
  askedFor: number | null
  restarts: Pick<ReturnType<typeof useRestarts>, 'of'>
  generations: Readonly<Record<string, number>>
  rects: ReturnType<typeof useRects>['rects']
  pinViews: ReadonlyMap<string, PinView>
  readyVersions: ReadonlyMap<string, Presence>
  expanded: ExpandedOne | null
  about: Pick<ReturnType<typeof subjectOf>, 'scope'>
  footed: ReadonlySet<string>
  drawn: Pick<ReturnType<typeof useAppearance>, 'rows'>
  keptHere: ReadonlyMap<string, string>
  guidance: ReadonlyMap<string, string>
}

/** Every module page that has a document, and where each goes. */
export function useFramings({
  byId, canvases, open, openId, placements, live, drawing, loadingCovers, staleOf, askedFor, restarts, generations,
  rects, pinViews, readyVersions, expanded, about, footed, drawn, keptHere, guidance,
}: FramingInputs): Framing[] {
  /**
   * Every module page that currently has a document, and where each one goes.
   *
   * A page is loaded when its module first appears on the open canvas, and is
   * kept while the module is on the open kehikko or on one of the last
   * `KEPT_KEHIKOT` left — which is what makes switching back free — and, by
   * its container's scope, always at This computer and while in its project at
   * Project (`scopeKeeps`, `host/scope.ts`). It is dropped when none of those
   * has it any more (the oldest kehikko left falls off the list), when the
   * last canvas holding it lets go, or when its registration disappears.
   *
   * Held in a ref rather than in state because it is a record of what has been
   * loaded, not a description of what should be on screen. Deriving it every
   * render from the canvases would forget, every render, which is the one thing
   * it exists to do.
   */
  const loadedRef = useRef<Set<string>>(new Set())
  /** The open kehikko and the ones left before it, most recent first. See `recentlyOpen`. */
  const recentRef = useRef<number[]>([])
  /** Each module's manifest as last read, for the scope its containers keep it by (`framesKept`). */
  const scopeReadRef = useRef<Map<string, NonNullable<Presence['module']>>>(new Map())
  /**
   * Which version each loaded page is of: the open kehikko's pin when the
   * module is on it, else whatever it was last loaded as. One page per module,
   * still — a module is on a kehikko at most once, so two versions of it are
   * never on screen together, and switching to a kehikko pinned differently
   * reloads that one page at the other version's address. See `Frames.tsx`.
   */
  const loadedVersionRef = useRef<Map<string, string | null>>(new Map())

  const framings = useMemo<Framing[]>(() => {
    const loaded = loadedRef.current
    const loadedVersion = loadedVersionRef.current
    const anywhere = new Set(everyPlaced(canvases))
    /* The open kehikko and the last few left: a page on none of them is let
       go (`framesKept`, `Frames.tsx`) — unless its container's scope keeps it
       (This computer, or Project while in its project: `scopeKeeps`). The
       module last read stands while it is not answering, so a restart does
       not drop a page its scope keeps. */
    recentRef.current = recentlyOpen(recentRef.current, open?.id ?? null)
    const read = scopeReadRef.current
    for (const [id, presence] of byId) if (presence.module) read.set(id, presence.module)
    for (const id of [...read.keys()]) if (!byId.has(id)) read.delete(id)
    const kept = framesKept(canvases, recentRef.current, (p) => keptScope(read.get(p.i), p.scope))
    for (const id of [...loaded]) {
      if (!anywhere.has(id) || !byId.has(id) || !kept.has(id)) loaded.delete(id)
    }
    const onOpen = new Set<string>()
    /* The container shown large on this kehikko, if any: its page is measured against the panel. */
    const big = expanded !== null && open !== null && expanded.kehikko === open.id ? expanded.id : null
    /* The presence a page is framed from: the module's own, or its pinned
       version's — which on the open kehikko is that kehikko's pin view, so a
       version the data guard blocks here is never framed here. */
    const framedAs = new Map<string, Presence | undefined>()
    for (const p of placements) {
      onOpen.add(p.i)
      loadedVersion.set(p.i, p.version ?? null)
      const resolved = pinnedPresence(byId.get(p.i), p.version ?? null, open ? pinViews.get(`${open.id}|${p.i}`) : undefined)
      framedAs.set(p.i, resolved.waiting ? undefined : resolved.presence)
      if (!resolved.waiting && resolved.presence?.module) loaded.add(p.i)
    }
    const presenceOf = (id: string): Presence | undefined => {
      if (framedAs.has(id)) return framedAs.get(id)
      const version = loadedVersion.get(id) ?? null
      return version ? readyVersions.get(`${id}@${version}`) : byId.get(id)
    }

    /* Sorted by id, and see `Frames.tsx`: this order must have nothing to do
       with the layout, because React moves DOM nodes when a keyed list is
       reordered and moving one of these reloads the document inside it. */
    return [...loaded]
      .sort()
      .map((id): Framing | null => {
        const module = presenceOf(id)?.module
        if (!module) return null
        const found = live[id]
        return {
          module,
          /* Only for the module's own checkout: a container pinned to a
             version is served by another process, which an update of the
             checkout does not touch. */
          generation: loadedVersion.get(id) ? 0 : (generations[id] ?? 0),
          /* Shown large (`host/expand.ts`): measured against the large panel's body instead, the
             same frame moved and never reloaded. Until the panel is measured, where it was. */
          rect: (big === id ? rects[EXPANDED_BODY] : undefined) ?? rects[id] ?? null,
          away: !onOpen.has(id),
          /* A folded container's page is HIDDEN, by the same path a page on another
             kehikko is hidden — kept at its size, kept running, and not shown.
             `Frames.tsx` has the argument: unmounting it would destroy the
             document, and there is no getting one of those back. Folding a container
             with a shell in it must not kill the shell. */
          shown:
            onOpen.has(id) &&
            !placements.find((p) => p.i === id)?.collapsed &&
            /* A tile shows the host's square over a hidden page, kept like a folded one — unless the
               module draws its own tile (`host/tile.ts`), or the tile is shown large right now. */
            !tileHidesPage(placements.find((p) => p.i === id), drawsOwnTile(module), big === id) &&
            /* The same decision the container's body draws from, so a page
               and a cover are never both up, or neither. */
            showing(presenceOf(id)!, found && { ...found, stale: staleOf(id, found), held: drawing.has(id) }, askedFor === openId, restarts.of(id)).kind === 'page' &&
            /* "All epics", and a module that works on one epic at a time: its
               container draws the sentence and the page is hidden under it —
               kept, as a folded page is, so it is all still there when an epic
               is picked again. See `host/scope.ts`. */
            !coveredForScope(about.scope, module, placements.find((p) => p.i === id)?.pinned ?? false, placements.find((p) => p.i === id)?.scope ?? null),
          /* Under its loading cover after a context change (2.84.0): hidden from sight, still told it is shown. */
          veiled: !drawing.has(id) && loadingCovers.has(id),
          /* This container's kept string (protocol 2.51.0): see `host/kept.ts`. */
          state: keptFor(byId.get(id), id, openId, keptHere),
          /* The container's scope (protocol 2.29.0): the person's pick among its
             module's, or its default, and `project` on "All epics" for one at
             Epic or Part. A pinned container is not moved by "All epics". */
          scope: scopeToTell(
            scopeOfContainer(module, placements.find((p) => p.i === id)?.scope ?? null).active,
            about.scope === 'project',
            placements.find((p) => p.i === id)?.pinned ?? false,
          ),
          pinned: placements.find((p) => p.i === id)?.pinned ?? false,
          /* A module that says `reveal: 'over'` (protocol 2.42.0) is never
             resized by focus mode's reveal: its rows are drawn over its page,
             and the page is told how much they cover. Which rows: the header
             unless the container is selected (then it never hides), the footer
             when the module declared one. See `host/reveal.ts`. */
          covers: big === id ? null : coversFor(module, placements.find((p) => p.i === id), footed.has(id), drawn.rows),
          /* Composed here rather than in the module, because only the host
             knows what else is on this kehikko. See the essay on `prompt` in
             the protocol's `wire.ts`. */
          prompt: promptFor(placements, id, guidance),
          /* Reconciled against what the module is offering RIGHT NOW rather
             than sent as stored, so that a value from a version of the module
             that no longer exists degrades to that module's own default instead
             of narrowing by something nobody can see or clear. A module that
             has offered nothing yet — including one that has not been greeted —
             is told what is stored, unreconciled, so it does not draw
             unnarrowed for the round trip until its offer arrives; it falls
             back on an id it does not know. See `host/filters.ts`. */
          filters: found?.filters
            ? chosen(found.filters, placements.find((p) => p.i === id)?.filters ?? {})
            : remembered(placements.find((p) => p.i === id)?.filters ?? {}),
        }
      })
      .filter((framing): framing is Framing => framing !== null)
  }, [byId, canvases, live, placements, rects, open, pinViews, readyVersions, askedFor, openId, generations, staleOf, about.scope, footed, drawn.rows, keptHere, expanded, drawing, loadingCovers])
  return framings
}

export interface WatcherInputs {
  covers: Covers
  setDrawingOf: (id: string, on: boolean) => void
  setLoadingOf: (id: string, label: string | null | undefined) => void
  setLive: Dispatch<SetStateAction<Record<string, Live>>>
  setSaid: Dispatch<SetStateAction<Said>>
  setHeaders: Dispatch<SetStateAction<Headers>>
  footerStore: FooterStore
  reveals: Reveals
  presses: Presses
  onHeight: (id: string, px: number) => void
  onOffer: (id: string, groups: Parameters<ConversationWatcher['filters']>[0]) => void
  onClearable: (id: string, label: Parameters<ConversationWatcher['clearable']>[0]) => void
  onRefreshable: (id: string, state: Parameters<ConversationWatcher['refreshable']>[0]) => void
  onClickMove: (event: ClickEvent) => void
  inboxGreetedRef: MutableRefObject<(module: string) => void>
  pressedAtRef: MutableRefObject<Map<string, number>>
  lookRef: MutableRefObject<(() => Promise<void>) | null>
  findsRef: MutableRefObject<Finds>
}

/** What each frame's document and conversation report, taken. */
export function useFrameWatchers({
  covers, setDrawingOf, setLoadingOf, setLive, setSaid, setHeaders, footerStore, reveals, presses, onHeight, onOffer,
  onClearable, onRefreshable, onClickMove, inboxGreetedRef, pressedAtRef, lookRef, findsRef,
}: WatcherInputs) {
  const onDocument = useCallback(
    (id: string, event: DocumentEvent) => {
      /* The document that said it is gone, and so is what it said: what it
         showed and where it pointed. Its successor — a restart, an update, a
         pinned version's page — is greeted with a context that does not hand
         it its predecessor's passage as though a neighbour were pointing.

         `replaced` is the same thing without the frame going away: the page
         reloaded itself in place, and its greeting is the very next thing
         `ModuleFrame` does. So this one is flushed — the greeting reads the
         context of the render this causes. It arrives from a frame's `load`
         event, never from inside a render, which is where `flushSync` is
         allowed. */
      if (event === 'replaced') {
        flushSync(() => setSaid((was) => forgotten(was, id)))
        /* Its menus too: the page that declared them is gone, and the one in
           its place declares its own after it is greeted. */
        setHeaders((was) => withdrawn(was, id))
        footerStore.withdraw(id)
        return
      }
      covers[event](id)
      if (event === 'unmounted') {
        setDrawingOf(id, false)
        setLoadingOf(id, undefined)
        setSaid((was) => forgotten(was, id))
        setHeaders((was) => withdrawn(was, id))
        footerStore.withdraw(id)
        reveals.forget(id)
      }
    },
    [covers, setDrawingOf, setLoadingOf],
  )

  const watcherFor = useCallback(
    (id: string): ConversationWatcher => ({
      ready: (_protocol, build, hold) => {
        tellStartup(`greeted ${id}`)
        covers.answered(id)
        setDrawingOf(id, hold === true)
        setLoadingOf(id, undefined)
        inboxGreetedRef.current(id)
        setLive((was) => ({
          ...was,
          [id]: {
            condition: 'ready',
            line: null,
            build: build ?? null,
            fault: was[id]?.fault ?? null,
            filters: was[id]?.filters,
            clear: was[id]?.clear,
            refresh: was[id]?.refresh,
          },
        }))
      },
      /* The held page is drawn, or the host stopped waiting: its cover comes off. */
      drawn: () => {
        setDrawingOf(id, false)
        setLoadingOf(id, undefined)
      },
      /* Covered as loading, in the module's words (2.84.0); `drawn` ends it. */
      loading: (label) => setLoadingOf(id, label),
      silent: (sentence, more) => {
        setDrawingOf(id, false)
        setLoadingOf(id, undefined)
        /* Its menus go with its offers: see `host/header.ts`. And its footer. */
        setHeaders((was) => withdrawn(was, id))
        footerStore.withdraw(id)
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
          [id]: { condition: 'silent', line: sentence, more: more ?? null, fault: was[id]?.fault ?? null },
        }))
      },
      fault: (sentence) =>
        setLive((was) => ({
          ...was,
          [id]: {
            condition: was[id]?.condition ?? 'ready',
            line: was[id]?.line ?? null,
            build: was[id]?.build,
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
      /* Held whole, and drawn as the container's menus — see `host/header.ts`. */
      header: (items) => setHeaders((was) => declared(was, id, items)),
      footer: (items) => footerStore.declare(id, items),
      /* A press inside the page: reveal on click and on long press (`host/rows.ts`). */
      pointer: (phase, at) => {
        if (phase === 'down') {
          pressedAtRef.current.set(id, at)
          onClickMove({ kind: 'press', id })
          return
        }
        const since = pressedAtRef.current.get(id)
        pressedAtRef.current.delete(id)
        onClickMove(phase === 'up' && since !== undefined ? { kind: 'release', held: at - since } : { kind: 'release', held: 0 })
      },
      /* The frame's page is from before its module was started again elsewhere: read again. */
      behind: () => void lookRef.current?.(),
      /* Find (protocol 2.69.0): what a search came to, and ⌘F pressed inside the page. */
      findResult: (result) => findsRef.current.result(id, result),
      findOpen: (asked) => findsRef.current.open(id, asked),
      /* A file dragged out of this page and let go over another frame that opens files (protocol 2.94.0). */
      drag: (drag) => void handOnDrop(id, drag, presses.dropFrames(), (x, y) => document.elementFromPoint(x, y)),
    }),
    [covers, setDrawingOf, setLoadingOf, onHeight, onOffer, onClearable, onRefreshable, onClickMove, presses],
  )

  return { onDocument, watcherFor }
}
