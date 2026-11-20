import { useMemo, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { ExpandResult, FilterChoice, SettingsOpenResult } from 'kehikot-module-protocol'
import type { Framing } from '@/canvas/Frames.tsx'
import { handed, readersOn, opensOutside, type Addresses, type Asker, type Offer } from '@/host/address.ts'
import type { CanvasControls, Filtered, Folded, GotoAnswer, GotoCall, Picked } from '@/host/ask.ts'
import type { Canvas, Placement } from '@/host/canvases.ts'
import { delivered, readersFor, stepsWithheld } from '@/host/connections.ts'
import type { EventBus } from '@/host/events.ts'
import { EXPAND_NO_PRESS, expandAsked, type Expanded as ExpandedOne } from '@/host/expand.ts'
import { sameChoice, settle as settleFilters } from '@/host/filters.ts'
import { asked as foldAsked, type FoldNote } from '@/host/folds.ts'
import { letGoOfFrame } from '@/host/gesture.ts'
import { outsideHow } from '@/host/goToPlace.ts'
import { keptWritten } from '@/host/kept.ts'
import { settingsOf, settingsOpenAsked } from '@/host/moduleSettings.ts'
import type { Presence } from '@/host/registry.ts'
import { openExternal } from '@/host/releaseNotes.ts'
import { pointed, shown, type Said } from '@/host/said.ts'
import type { SubjectEdit } from '@/host/subject.ts'
import { TRACKER_NOTICES_MODULE, type NoticeLink } from '@/host/trackerNotices.ts'
import type { Live } from './live.ts'

export interface CanvasControlInputs {
  openId: number | null
  /** The open kehikko as drawn. */
  open: Canvas | null
  live: Readonly<Record<string, Live>>
  moving: string | null
  change: (edit: { placements?: Placement[] }) => void
  bus: EventBus
  reactsOf: (id: string) => readonly string[] | undefined
  addressesRef: MutableRefObject<Addresses>
  setAddresses: Dispatch<SetStateAction<Addresses>>
  setOffer: Dispatch<SetStateAction<Offer | null>>
  expandedRef: MutableRefObject<ExpandedOne | null>
  setExpanded: Dispatch<SetStateAction<ExpandedOne | null>>
  setKeptHere: Dispatch<SetStateAction<ReadonlyMap<string, string>>>
  openModuleSettings: (id: string, target: string | null) => void
  noteFold: (kehikko: number, note: FoldNote) => void
  framingsRef: { readonly current: Framing[] }
  askingRef: { readonly current: unknown }
  walkStepRef: { readonly current: (target: { epic: string; step: number }, from: string) => void }
  changeSubjectRef: { readonly current: (edit: SubjectEdit) => void }
  projectRef: { readonly current: number | null }
  setSelectedByRef: { readonly current: Dispatch<SetStateAction<Record<number, string | null>>> }
  setSaidRef: { readonly current: Dispatch<SetStateAction<Said>> }
  locateRef: { readonly current: CanvasControls['locate'] }
  pickRef: { readonly current: (from: string) => Promise<Picked> }
  switchesRef: { readonly current: Parameters<typeof delivered>[0] }
  kehikkoRef: { readonly current: Parameters<EventBus['emit']>[3] }
  legacyNoticeRef: { readonly current: (from: string, payload: unknown) => void }
  /** What the page declares further down — the modules by id — read when it is called, as before. */
  later: {
    byId: () => ReadonlyMap<string, Presence>
  }
}

/**
 * What a module may ask the canvas to do (`CanvasControls`, `host/ask.ts`), and
 * the page's half of each ask: an address shown (`address.open`, an agent's
 * `open_address`, a tracker notice's page), a filter moved, a fold, a
 * container shown large, a module's settings opened. Each half is a ref
 * assigned on every render, so it answers against the render it is called in;
 * `controls` is made once and reaches them through those refs.
 *
 * Moved out of `App.tsx` as it was. It runs no effect. The refs the page
 * assigns further down (`gotoRef`, `gotoHereRef`, `inboxAskRef`,
 * `activityRef`) and the pending `view.goto` (`jumping`) are made here, where
 * `controls` needs them, and handed back.
 */
export function useCanvasControls({
  openId,
  open,
  live,
  moving,
  change,
  bus,
  reactsOf,
  addressesRef,
  setAddresses,
  setOffer,
  expandedRef,
  setExpanded,
  setKeptHere,
  openModuleSettings,
  noteFold,
  framingsRef,
  askingRef,
  walkStepRef,
  changeSubjectRef,
  projectRef,
  setSelectedByRef,
  setSaidRef,
  locateRef,
  pickRef,
  switchesRef,
  kehikkoRef,
  legacyNoticeRef,
  later,
}: CanvasControlInputs) {
  /**
   * `address.open`, and an agent's `open_address`, answered against this
   * render's open kehikko: into a container that shows pages when there is one,
   * an offer to the person when a module asked and there is none, and a
   * refusal for an agent. See `host/address.ts`. Through a ref for `filterRef`'s reason.
   */
  const handAddressRef = useRef<(asker: Asker, url: string, title: string | undefined, intent: 'show' | undefined, kehikko?: number) => ReturnType<CanvasControls['openAddress']>>(
    () => ({ outcome: 'declined', why: 'This host is not ready to show an address yet.' }),
  )
  handAddressRef.current = (asker, url, title, intent, kehikko) => {
    if (openId === null || !open) return { outcome: 'declined', why: 'No kehikko is open, so there is nowhere to show an address.' }
    if (kehikko !== undefined && kehikko !== openId) {
      return { outcome: 'declined', why: `This page does not have kehikko ${kehikko} open any more, so nothing was opened.` }
    }
    if ('by' in asker && !open.placements.some((p) => p.i === asker.by)) {
      return { outcome: 'declined', why: `${asker.by} is not on the kehikko that is open, so it is not showing anything anybody can see.` }
    }
    const out = handed(addressesRef.current, {
      kehikko: openId,
      url,
      ...(title === undefined ? {} : { title }),
      ...(intent === undefined ? {} : { intent }),
      asker,
      at: new Date().toISOString(),
      /* Only the readers that take this asker's pages here (`readersFor`): with none, it is an offer. */
      readers: readersFor(open.connections, 'by' in asker ? asker.by : null, readersOn(open.placements.map((p) => p.i), reactsOf)),
    })
    if (out.next !== addressesRef.current) {
      addressesRef.current = out.next
      setAddresses(out.next)
    }
    if (out.offer) setOffer(out.offer)
    return out.answer
  }

  /**
   * A tracker notice's page, when no kehikko here takes its ref as a pick or no epic names it: into a
   * module on the open kehikko that shows pages, else the person's browser (https only: they pressed
   * Open), else the address offer (`outsideHow`). The host's own handing, so not held to connections.
   */
  const showLinkRef = useRef<(link: NoticeLink) => void>(() => undefined)
  showLinkRef.current = (link) => {
    if (openId === null || !open) {
      if (opensOutside(link.url)) openExternal(link.url)
      return
    }
    const readers = readersOn(open.placements.map((p) => p.i), reactsOf)
    if (outsideHow(readers, link.url, opensOutside) === 'browser') {
      openExternal(link.url)
      return
    }
    const out = handed(addressesRef.current, {
      kehikko: openId,
      url: link.url,
      ...(link.title ? { title: `${link.ref} ${link.title}`.slice(0, 200) } : {}),
      asker: { by: TRACKER_NOTICES_MODULE },
      at: new Date().toISOString(),
      readers,
    })
    if (out.next !== addressesRef.current) {
      addressesRef.current = out.next
      setAddresses(out.next)
    }
    if (out.offer) setOffer(out.offer)
  }

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
    const kept = settleFilters(offer, choice, container.filters)
    if (!sameChoice(kept, container.filters)) {
      change({ placements: placements.map((p) => (p.i === from ? { ...p, filters: kept } : p)) })
    }
    return { ok: true, filters: kept }
  }

  /**
   * A module asking for containers to be folded or unfolded (`view.fold`).
   *
   * Through a ref for the reason `filterRef` is: the work needs this render's
   * placements and whether a hand is on one of them.
   *
   * The deciding is `asked` in `host/folds.ts`; what is here is what only the
   * page knows. **What the person is in the middle of**, each a decline with
   * its sentence: a container being dragged or resized (the grid is drawing
   * from the hand, and an arrangement written under it is one the release
   * overwrites) and the project dialog, which covers the canvas so that a
   * fold behind it would not be seen happening. Nothing else declines: where
   * the keyboard's focus is does not, because a field of the host's that was
   * typed in a minute ago is still the active element, and a walk-through
   * would be refused for as long as nobody clicked elsewhere. An agent's
   * `fold_modules` does not ask either.
   *
   * A fold that goes ahead is the write a press makes (`change`), and is
   * signed with the module's NAME off the registration, on the control that
   * puts it back. The mark goes when the person presses, by `standing`.
   *
   * `arrangedRef` is the open kehikko's placements as of the last fold made
   * here, so two calls answered before a render do not each start from the
   * arrangement the first one already changed. Every render puts it back to
   * what is drawn.
   */
  /**
   * A module asking for its own container to be shown large, or put back (`view.expand`). The
   * deciding is `expandAsked` in `host/expand.ts`; what is here is what only the page knows: the open
   * kehikko, whether the asker's page is what its container shows, and a hand on a container.
   */
  /**
   * A module asking for its own settings, at one setting (`settings.open`, protocol 2.90.0). The
   * deciding is `settingsOpenAsked`; what is here is what only the page knows: what it declared.
   */
  const settingsOpenRef = useRef<(from: string, call: { key?: string }, pressed: boolean) => SettingsOpenResult>(() => ({
    outcome: 'declined',
    why: 'This host is not ready to open settings yet.',
  }))
  settingsOpenRef.current = (from, call, pressed) => {
    const presence = later.byId().get(from)
    const said = settingsOpenAsked({ name: presence?.name ?? presence?.module?.name ?? from, fields: settingsOf(presence?.module), key: call.key, pressed })
    if (said.outcome === 'declined') return said
    openModuleSettings(from, said.target)
    return { outcome: 'opened', why: '' }
  }

  const expandRef = useRef<(from: string, call: { expand: boolean }, pressed: boolean) => ExpandResult>(() => ({
    outcome: 'declined',
    why: 'This host is not ready to show anything large yet.',
  }))
  expandRef.current = (from, call, pressed) => {
    const on = open?.id ?? null
    const onOpen = framingsRef.current.some((one) => one.module.id === from && one.shown && !one.away)
    const busy = moving !== null ? 'A container is being moved or resized. Ask again when it has been let go.' : null
    const { result, next } = expandAsked(expandedRef.current, { from, expand: call.expand, pressed, kehikko: on, onOpen, busy })
    /* Refused for want of a press this page could see: the next press into the frame should be one. */
    if (result.outcome === 'declined' && result.why === EXPAND_NO_PRESS) letGoOfFrame(document, from)
    if (next !== expandedRef.current) {
      expandedRef.current = next
      setExpanded(next)
    }
    return result
  }

  const arrangedRef = useRef<{ kehikko: number | null; placements: Placement[] }>({ kehikko: null, placements: [] })
  arrangedRef.current = { kehikko: open?.id ?? null, placements: open?.placements ?? [] }
  const foldRef = useRef<(from: string, call: { fold: string[]; unfold: string[] }) => Folded>(() => ({
    outcome: 'declined',
    folded: [],
    unfolded: [],
    why: 'This host is not ready to fold anything yet.',
  }))
  foldRef.current = (from, call) => {
    const { kehikko: on, placements } = arrangedRef.current
    const busy = moving !== null
      ? 'A container is being moved or resized. Ask again when it has been let go.'
      : askingRef.current
        ? 'The person is being asked to choose a project.'
        : null
    const { placements: next, ...said } = foldAsked(placements, from, call, busy)
    if (said.outcome !== 'changed' || on === null) return said
    arrangedRef.current = { kehikko: on, placements: next as Placement[] }
    change({ placements: next as Placement[] })
    const note = { by: later.byId().get(from)?.name ?? from, fold: said.folded, unfold: said.unfolded }
    noteFold(on, note)
    return said
  }

  /**
   * `view.goto` with `parts` and/or `kehikko` (protocol 1.4.0), assigned where
   * the project's kehikot (`here`) and epics (`held`) are in hand, below.
   *
   * Everything is checked BEFORE anything is changed, so a refusal leaves the
   * screen exactly as it was. What it then does is what a person would do with
   * the epic picker, the part picks and the kehikko tabs, and no more: switch
   * to that kehikko (never create, rename, move or remove one), make the epic
   * the subject, and pick exactly those parts. The person's arrangement of
   * containers — placements, sizes, folds, filters, pins — is not touched.
   */
  const gotoRef = useRef<CanvasControls['goto']>(() => ({
    outcome: 'declined',
    epic: null,
    why: 'This host is not ready to move yet.',
  }))
  /* The move within the open project alone, for the Inbox's press and for the
     arrival of a switch of project; assigned with `gotoRef`. */
  const gotoHereRef = useRef<(call: GotoCall, from?: string) => GotoAnswer>(() => ({
    outcome: 'declined',
    epic: null,
    why: 'This host is not ready to move yet.',
  }))
  /* A `view.goto` waiting for the project it switched to (protocol 2.28.0). */
  const jumping = useRef<{
    project: number
    call: GotoCall
    from: string | undefined
    cleared: boolean
    timer: number
    resolve: (answer: GotoAnswer) => void
  } | null>(null)

  /* `inbox.*` (protocol 2.79.0), answered by the record held further down (`inboxDoorRef`). */
  const inboxAskRef = useRef<NonNullable<CanvasControls['inbox']>>(() =>
    Promise.resolve({ ok: false, reason: 'failed', error: 'This host is not ready to show the Inbox yet.' }),
  )
  /* `activity.set`, answered by the lists held further down (`useActivity`);
     through a ref for the reason `gotoRef` is one. */
  const activityRef = useRef<NonNullable<CanvasControls['activity']>>(() => ({
    outcome: 'declined',
    taken: 0,
    why: 'This host is not ready to hold activity yet.',
  }))

  /* What a module may ask the canvas to do. See `host/ask.ts`. */
  const controls = useMemo<CanvasControls>(
    () => ({
      /* Moving to a different epic drops the selection. A ref was picked out of
         one epic's references; carrying it into another would leave every
         module pointing at something that is not in front of them any more, and
         "nothing is selected" is a state they all have to handle anyway. */
      /* The project's epic, not this kehikko's: there is no kehikko's. */
      /* Through a ref: the open kehikko and its frames are this render's. */
      walkStep: (target, from) => walkStepRef.current(target, from),
      showEpic: (epic) => {
        changeSubjectRef.current({ epic, selection: [] })
        /* The selection went, so its setter goes with it: a row saying a
           container picked refs the project no longer holds would be the row
           and the project disagreeing. */
        const id = projectRef.current
        if (id !== null) setSelectedByRef.current((was) => (was[id] === null ? was : { ...was, [id]: null }))
      },
      select: (from, refs) => {
        changeSubjectRef.current({ selection: refs })
        /* Who picked, so that the refs appear in that container's own row of
           `context.containers`. An empty list is a selection cleared, and
           nobody is its setter. */
        const id = projectRef.current
        if (id === null) return
        const by = refs.length ? from : null
        setSelectedByRef.current((was) => (was[id] === by ? was : { ...was, [id]: by }))
      },
      /* What a container says it shows, held against the MODULE that said
         it — whichever kehikko is open, and whether or not the module is on
         it: its page is one document, and the claim is about that document.
         Only when it CHANGED, the same bargain `point` keeps below: a module
         that re-says an identical statement on every render must not cost
         every frame on the canvas a context. */
      show: (from, showing) => setSaidRef.current((was) => shown(was, from, showing)),
      /* Held against the module, and only when it actually CHANGED. A module
         that points on every pointer move during a drag would otherwise put a
         `kehikot.context` into every frame on the canvas per event; the sender
         is asked not to do that, and this is the half of the bargain the host
         can keep on its own — a host cannot make somebody else's program
         debounce, and it can refuse to repeat itself. Which kehikko's passage
         it becomes is decided when the context is composed, by who is placed
         there — see `passageOn`. A null is a document closed: this
         container's row stops showing it, and only this container's. */
      point: (from, next) => setSaidRef.current((was) => pointed(was, from, next)),
      /* Through a ref: the open kehikko and the selection are this render's. */
      locate: (from, next, intent) => locateRef.current(from, next, intent),
      /* `from` out of the registration, and the address's `by`. Through a ref: the open kehikko is this render's. */
      openAddress: (from, url, title, intent) => handAddressRef.current({ by: from }, url, title, intent),
      /* `from` arrives already decided — `makeAsk` supplies it out of the
         registration the conversation was built on, and nothing the frame said
         can reach it. This end only adds where the canvas is. */
      emit: (from, extension, payload) => {
        const out = bus.emit(from, extension, payload, kehikkoRef.current)
        /* The legacy line is also kept: the Inbox holds it as an item born
           closed, whoever is listening for it. */
        if (out.ok && extension === 'kehikot.notifications@1') legacyNoticeRef.current(from, payload)
        return out
      },
      /* An id, read now. The server turns it into a folder out of its own
         table — see `project` on `CanvasControls` for why a path must not come
         from this side. */
      project: () => projectRef.current,
      /* A module kept a string for one of its containers (protocol 2.51.0):
         held here so the next context for that container carries it before
         the registry sweep has read it back. */
      kept: (module, kehikko, state) => setKeptHere((was) => keptWritten(was, module, kehikko, state)),
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
      /* `from` out of the registration: it has to be ON the open kehikko to
         fold anything there, and its name is what the control then says.
         Through a ref — see `foldRef`. */
      fold: (from, call) => foldRef.current(from, call),
      /* Its own container only, and to expand only on the person's press: see `expandRef`. */
      expand: (from, call, pressed) => expandRef.current(from, call, pressed),
      /* Its own settings only, on the person's press: see `settingsOpenRef`. */
      openSettings: (from, call, pressed) => settingsOpenRef.current(from, call, pressed),
      goto: (call, from) => gotoRef.current(call, from),
      activity: (from, items) => activityRef.current(from, items),
      /* The person's Inbox (protocol 2.79.0): answered from what this page holds, through a ref. */
      inbox: (from, method, params, pressed) => inboxAskRef.current(from, method, params, pressed),
      /* The steps of a provider the person switched off for this module here are not handed to it. */
      withhold: (module, method, data) =>
        method === 'steps.list' || method === 'epic.get'
          ? stepsWithheld(data, (provider) => delivered(switchesRef.current, 'steps', provider, module))
          : data,
    }),
    [change, bus],
  )

  return { controls, handAddressRef, showLinkRef, gotoRef, gotoHereRef, jumping, inboxAskRef, activityRef }
}
