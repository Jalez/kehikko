import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Responsive, type Layout } from 'react-grid-layout'
import { REFRESH_EVERY_MAX, REFRESH_EVERY_MIN, own, type ModuleScope } from 'kehikot-module-protocol'
import type { Build, ContentChange, Disposition, EpicPart, FilterChoice, FilterGroup, ModuleCondition, ModuleContext, SharedAddress, SharedLocation } from 'kehikot-module-protocol'

import { Bar } from './canvas/Bar.tsx'
import { Frames, type Framing } from './canvas/Frames.tsx'
import { Underlay } from './canvas/Underlay.tsx'
import { useCalmSwitch } from './canvas/useCalmSwitch.ts'
import { foldsOnlyChanged, held as heldPages, layerStyle } from './host/switching.ts'
import type { DocumentEvent } from './canvas/ModuleFrame.tsx'
import { Covers, registryBehind, Replacing, Runs, showing } from './host/standing.ts'
import { Picking } from './canvas/Picking.tsx'
import { Prompts } from './canvas/Prompts.tsx'
import { ToolsDialog } from './canvas/Tools.tsx'
import { SkillsDialog } from './canvas/Skills.tsx'
import { ModuleSettingsDialog, setSettingsFileOpener } from './canvas/ModuleSettings.tsx'
import { AgentSettingsHost } from './canvas/Settings.tsx'
import { OnboardingHost } from './canvas/Onboarding.tsx'
import { WhatsNewHost } from './canvas/WhatsNew.tsx'
import { forgetRead, hostRead } from './host/hostRead.ts'
import { openLayouts } from './host/onboarding.ts'
import { projectPicked } from './host/tour.ts'
import { Button } from './components/ui/button.tsx'
import { LayoutTemplate } from 'lucide-react'
import { openSettings, SETTINGS_INBOX_MODULE } from './host/agentSettings.ts'
import { Container } from './canvas/Container.tsx'
import { Missing } from './canvas/Missing.tsx'
import { MissingProject } from './canvas/MissingProject.tsx'
import { Locate } from './canvas/Locate.tsx'
import { Followed } from './canvas/Followed.tsx'
import { WentTo } from './canvas/WentTo.tsx'
import type { CanvasControls, Folded, GotoAnswer, GotoCall } from './host/ask.ts'
import { EventBus } from './host/events.ts'
import { Presses } from './host/presses.ts'
import {
  chooseOpen,
  COLUMNS,
  editCanvas,
  saveConnections,
  everyPlaced,
  framesKept,
  recentlyOpen,
  fetchCanvases,
  inProject,
  answerPress,
  place,
  postHeaders,
  promptFor,
  readOpen,
  removeCanvas,
  reportOpen,
  unplace,
  watchCanvases,
  writeOpen,
  type Canvas,
  type Placement,
  type AddressOrder,
  type PressOrder,
} from './host/canvases.ts'
import { arrive, MISSED_NEWS_MS, oneAfterAnother, stillMoving } from './host/looks.ts'
import type { ConversationWatcher } from './host/conversation.ts'
import {
  addProject,
  chooseProject,
  createEpic,
  deleteEpic,
  fetchDispositions,
  fetchTracker,
  refreshTracker,
  type TrackerState,
  editParts,
  fetchEpics,
  fetchProjects,
  forgetProject,
  pickedFrom,
  retitleEpic,
  shareProject,
  readOpenProject,
  writeOpenProject,
  type Epics as HeldEpics,
  type Project,
} from './host/projects.ts'
import { containersKey, containersOf } from '@/host/showing.ts'
import { NOTHING_SAID, forgotten, passageOn, pointed, pointedBy, shown, type Said } from '@/host/said.ts'
import { NO_LOCATIONS, located, locationOn, readLocations, stillStanding, writeLocations, type Locations } from '@/host/location.ts'
import { ARRIVAL_WAIT_MS, NAVIGATE_SAYS, planJump, showReceivers, shownBy, type HeldShow } from '@/host/navigate.ts'
import { navigatesOf, type ShowingManifest } from 'kehikot-module-protocol'
import { NO_ADDRESSES, accepted, addressOn, handed, noteReacts, readersOn, SHOWS_PAGES, type Addresses, type Asker, type Offer } from '@/host/address.ts'
import { AddressOffer } from './canvas/AddressOffer.tsx'
import { openExternal } from './host/releaseNotes.ts'
import { kehikkoOnWire, toWireContext, type Subject } from './host/context.ts'
import { receiverContext, type ContextFacts } from './host/connectionContext.ts'
import { connectionsOf, delivered, readersFor, sidesOf, stepsWithheld, tidy, type ConnectionModule, type ConnectionsSetting } from './host/connections.ts'
import { settingsOf } from './host/moduleSettings.ts'
import { partsOnWire, unpicked, type Part, type PartsEdit } from './host/parts.ts'
import { editSubject, movesEpic, subjectOf, withEdit, type SubjectEdit, type Subjects } from './host/subject.ts'
import { coveredForScope, scopeOfContainer, scopeToKeep, scopeToTell, type ContainerScope } from './host/scope.ts'
/* `settle` is imported under another name: this file already has a `settle`,
   which is the measuring pass after a grid animation, and two of them would be
   one of the least readable name collisions available. */
import { chosen, remembered, sameChoice, settle as settleFilters } from './host/filters.ts'
import type { Filtered, Picked } from './host/ask.ts'
import { useRects } from './host/rects.ts'
import { useInbox } from './canvas/useInbox.ts'
import { useRestarts } from './canvas/useRestarts.ts'
import { useChime } from './canvas/useChime.ts'
import { useToasts } from './canvas/useToasts.ts'
import { InboxToasts } from './canvas/InboxToasts.tsx'
import { placeWords } from './host/toasts.ts'
import { kindOf } from './host/chime.ts'
import { useGoToPlace } from './canvas/useGoToPlace.ts'
import { epicMarks, kehikkoMarks, moduleMark, noticeFor, partMarks, type Namer } from './host/activity.ts'
import { nextOf, noticeEntry, rowKey, scopeFrom, tally, type Entry, type NoticeLine, type Place, type Scope } from './host/inbox.ts'
import { placeOpened } from './host/activity.ts'
import { fetchLog } from './host/inboxClient.ts'
import { answerAsk, askChoices, isPlaceAsk } from './host/placeAsk.ts'
import type { BarActivity } from './canvas/Bar.tsx'
import { schemaFor, worstActivity, type ActivityState } from 'kehikot-module-protocol'
import { fetchRegistry, newerReading, type Presence, type RegistryView } from './host/registry.ts'
import { setRegisteredIcons } from './canvas/ModuleIcon.tsx'
import { pinnedPresence, type PinView } from './host/versions.ts'
import { isNotAnswering, notAnswering } from './host/reachable.ts'
import { arranged as settledOn, dragged, granted, mostFor, mostUp, pressed, redrawn, topEdge, wishing } from './host/columns.ts'
import { cornerOf } from './host/corners.ts'
import { cornerHandle } from './canvas/CornerHandle.tsx'
import { asked as foldAsked, noted, reread, signedBy, standing, type FoldMarks } from './host/folds.ts'
import { storageViewOf } from './host/storage.ts'
import type { StorageViews } from './canvas/Storage.tsx'
import { agentRefusal, declared, headerPosting, NO_HEADER, NO_HEADERS, NOTHING_POSTED, pressing, withdrawn, type Headers, type Pressed, type Pressing } from './host/header.ts'
import type { PressNote } from './canvas/HeaderMenus.tsx'
import { CANVAS_ROWS, rowHeightFor, rowsHolding } from './host/fit.ts'
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

/**
 * The grid, told its width rather than left to measure it.
 *
 * It used to be `WidthProvider(Responsive)`. `WidthProvider` renders once at a
 * hardcoded 1280 pixels, measures the element it rendered into, and renders
 * again at the real width — and the grid is keyed by kehikko, so that happened
 * on EVERY switch, not once a load: every container drawn in the wrong column,
 * then moved. Its own answer, `measureBeforeMount`, was a trap of a different
 * kind: with it on, the measurement never arrived and the grid stayed at 1280
 * for the life of the page.
 *
 * The canvas already measures its own surface (`useRects`, for `room`), so the
 * width comes from there, and the grid is not drawn until there is one. A new
 * grid is born at its real width. See `host/switching.ts` for what that and the
 * rest of the switch cost before.
 */
const Grid = Responsive

/** How long a fold, an unfold, or a container let go of glides: the grid's 200 ms, and a frame either side. */
const GLIDE_MS = 260

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
   * The build that served the page that answered, when the page says — which
   * server PROCESS it came from. Compared with the build the module's server
   * states now to see a page older than its server; see `isStale` in
   * `host/standing.ts`. Null or absent for a module from before build
   * identities, which is never called stale.
   */
  build?: Build | null
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
/** How long the page waits after a module's header changed before posting the whole map. */
const HEADERS_SETTLE_MS = 250

/** Names for another project's places: none are read for a project that is not open, so a line says its slugs. */
const OTHER_NAMES: Namer = { epic: () => null, part: () => null, kehikko: () => null }

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

/** Who the host's own pointing is filed under in `said`: its id on the wire. */
const HOST_POINTS = 'kehikko'
/** The Editor module, which shows a file the canvas points at, and files under `.kehikot/` read-only. */
const EDITOR_ID = 'kehikot.editor'

/**
 * Ring the containers of these modules and bring the first into view.
 *
 * `scrollIntoView` with `nearest` moves the canvas only when the container is
 * off screen, and neither it nor the ring touches focus: a person typing in a
 * module goes on typing. The ring fades over 1.2 seconds (`[data-landed]` in
 * `index.css`); where motion is asked to be less it is a static outline that
 * clears on the next press or key, not on a timer.
 */
function showLanded(modules: readonly string[]): void {
  let tries = 0
  const find = () => {
    const found = modules
      .map((id) => [...document.querySelectorAll<HTMLElement>('[data-module]')].find((one) => one.dataset.module === id))
      .filter((one): one is HTMLElement => one !== undefined)
    if (found.length < modules.length && tries < 30) {
      tries += 1
      window.requestAnimationFrame(find)
      return
    }
    if (found.length === 0) return
    found[0]!.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    for (const one of found) one.setAttribute('data-landed', '')
    const clear = () => {
      for (const one of found) one.removeAttribute('data-landed')
      document.removeEventListener('pointerdown', clear, true)
      document.removeEventListener('keydown', clear, true)
    }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      document.addEventListener('pointerdown', clear, true)
      document.addEventListener('keydown', clear, true)
    } else {
      window.setTimeout(clear, 1300)
    }
  }
  window.requestAnimationFrame(find)
}

export function App() {
  const [registry, setRegistry] = useState<RegistryView | null>(null)
  /* What a `view.goto { show }` asked to have shown, and the kehikko it is for:
     in memory only, like an address — asking is a request made once. */
  const [shownTo, setShownTo] = useState<HeldShow | null>(null)
  const [trouble, setTrouble] = useState<string | null>(null)
  const [looking, setLooking] = useState(true)
  const [canvases, setCanvases] = useState<Canvas[]>([])
  /**
   * Who folded or unfolded which containers on the open kehikko, when it was
   * not the person: an agent at the host's door, or a module asking with
   * `view.fold`. See `host/folds.ts`.
   */
  const [signed, setSigned] = useState<{ kehikko: number; marks: FoldMarks } | null>(null)
  const [openId, setOpenIdNow] = useState<number | null>(null)
  const openIdRef = useRef(openId)
  openIdRef.current = openId
  /*
   * Which kehikko is open, changed — always through here, because the kehikko
   * being left has to be looked at BEFORE it is gone: `leaving` keeps a still
   * copy of it on screen and holds its pages where they are while the next one
   * is drawn out of sight. See `canvas/useCalmSwitch.ts`. Through a ref because
   * the switch is set up far below, beside the pages it holds.
   */
  const leavingRef = useRef<() => void>(() => undefined)
  /* And what waits for the kehikko arrived at to be shown — the Inbox's light on a container. */
  const whenShownRef = useRef<(then: () => void) => void>((then) => then())
  const setOpenId = useCallback((next: number | null | ((was: number | null) => number | null)) => {
    const value = typeof next === 'function' ? next(openIdRef.current) : next
    if (value !== openIdRef.current) leavingRef.current()
    openIdRef.current = value
    setOpenIdNow(value)
  }, [])
  /** The kehikko the server had been told about when it was last asked what is running. */
  const [askedFor, setAskedFor] = useState<number | null>(null)
  /** How many times the host has restarted each module under a mounted frame. See `Framing.generation`. */
  const [generations, setGenerations] = useState<Record<string, number>>({})
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
  /* Which project's folder is being located ("Locate…"), or null. See `Locate.tsx`. */
  const [locating, setLocating] = useState<number | null>(null)
  /* Read the projects and the kehikot again, when the server says a project was
     found where its folder went. Through a ref for `lookRef`'s reason. */
  const relistRef = useRef<(() => Promise<void>) | null>(null)
  relistRef.current = async () => {
    try {
      const [found, everyProject] = await Promise.all([fetchCanvases(), fetchProjects()])
      setProjects(everyProject)
      setCanvases(found.canvases)
      setSubjects(found.subjects)
    } catch {
      /* The list the page has is the list it had; the next load reads it. */
    }
  }
  /**
   * What each project is about — its epic and the refs picked out of it — by
   * project id. Beside the projects and NOT inside the kehikot: the kehikko is
   * a layout and switching it must not move the epic. See `host/subject.ts`.
   */
  const [subjects, setSubjects] = useState<Subjects>({})
  /**
   * What the open project holds, or null while it is being read.
   *
   * Null is "not known yet" and is not the same as `{ holds: false }`, which is
   * "this project has no .kehikot/host/epics". The epic picker draws a different
   * sentence for each — see `Epics.tsx` — because an empty box is what a
   * project with none and a read that failed both look like.
   */
  const [held, setHeld] = useState<HeldEpics | null>(null)
  /*
   * Which project `held` was read for, and what each project held when it was
   * last read. Only the epic control's LABEL uses these: on a project switch
   * `held` is still the project left for a render, then null while the new
   * one is read, and the label — what the bar is laid out around — said the
   * left project's epic, then "reading epics…", then the right one, each a
   * different width, and everything after it in the bar moved with it. With
   * these it says what the project held when it was last here. See
   * `host/switching.ts`.
   */
  const [heldProject, setHeldProject] = useState<number | null>(null)
  const heldBefore = useRef(new Map<number, HeldEpics>())
  if (held !== null && projectId !== null && heldProject === projectId) heldBefore.current.set(projectId, held)
  /**
   * The open project's dispositions — people's marks on why refs closed — for
   * `context.dispositions`. Empty while they are read and when nobody has said
   * anything; a module cannot tell those apart and does not need to, since in
   * both it falls back to what its own tracker reading implies.
   */
  const [marks, setMarks] = useState<Disposition[]>([])
  /**
   * The open project's shared tracker reading, as the bar shows it and as
   * `context.tracker` carries it: when it last changed, whether a read is
   * running, and how each source fared. See `server/trackers/reading.ts`.
   */
  const [tracker, setTracker] = useState<TrackerState>({ at: null, refreshing: false, sources: [] })
  /**
   * What has changed in the material kept for the open project's epics, for
   * `context.content`. Empty until the server says something changed: a
   * module loads what it shows when its epic opens, and this is only ever the
   * reason to read it again. See `server/content.ts`.
   */
  const [rewritten, setRewritten] = useState<ContentChange[]>([])
  const [live, setLive] = useState<Record<string, Live>>({})
  /**
   * What each module last declared for its container's menus
   * (`kehikot.header`), by module id. Held and handed to the container, which
   * draws it as its View, Go and Run menus — see `host/header.ts`, which also
   * says when an entry goes.
   */
  const [headers, setHeaders] = useState<Headers>(NO_HEADERS)
  /* The same, for a press: judged against what is declared at the moment of
     the press, which a closure made at the last render does not hold. */
  const headersRef = useRef<Headers>(headers)
  headersRef.current = headers
  /**
   * What an agent last pressed in each module's header, by module id, so the
   * container says it happened where a person would look for it. Said for a
   * moment and never stored: a fact about one screen at one time, like who
   * folded a container. See `PressNote` in `HeaderMenus.tsx`.
   */
  const [pressNotes, setPressNotes] = useState<Readonly<Record<string, PressNote>>>({})
  /* An agent's press arrives on the stream opened far above where the frames
     and the open kehikko are declared; `lookRef`'s arrangement, for its reason. */
  const orderedRef = useRef<((order: PressOrder) => void) | null>(null)
  const addressedRef = useRef<((order: AddressOrder) => void) | null>(null)
  const repostRef = useRef<(() => void) | null>(null)
  /* The Inbox's page-side hook is called far below this; the stream and the
     emit above reach it through refs, for `orderedRef`'s reason. */
  const inboxWokeRef = useRef<((project: number, rev: number | null) => void) | null>(null)
  const legacyNoticeRef = useRef<(from: string, payload: unknown) => void>(() => undefined)
  /* Which container is being dragged or resized, if any — see `Frames.tsx` for why
     the pages stop taking the pointer for the duration, and why the one under
     the hand is hidden rather than chased. */
  const [moving, setMoving] = useState<string | null>(null)
  /* Which container's TOP edge a hand is pulling, if any: a top corner trades
     rows with what is on top of the container rather than with what is below
     it, so how far it may travel is a different number (`mostUp`). Known only
     once the press has landed on a handle, hence state and not a constant. */
  const [pulling, setPulling] = useState<string | null>(null)
  /* What the containers on top of the one whose top edge is being pulled have
     been given, by id: their new heights, and so their new wishes. Written by
     `onResize`, consumed by `onLayoutChange` on release like `resized`. */
  const traded = useRef<Map<string, number>>(new Map())
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
  /*
   * Whether the grid animates what changes in it. Only for what a person did
   * to the arrangement — a drag, a resize, and the glide of a container let go
   * of — and for a fold or an unfold; never for a switch, a load, a module
   * asking to grow or a window resized. See `.in-motion` in `index.css`.
   * `gliding` counts the glides asked for, so a second one restarts the timer.
   */
  const [gliding, setGliding] = useState(0)
  useEffect(() => {
    if (!gliding) return
    const done = setTimeout(() => setGliding(0), GLIDE_MS)
    return () => clearTimeout(done)
  }, [gliding])
  /* Which container's prompts are being written, if any. The dialog belongs to the
     host rather than to a module — see `Prompts.tsx` for why a modal inside an
     iframe is not a modal. */
  const [prompting, setPrompting] = useState<string | null>(null)
  /* Which module's tools are being looked at, if any. The host's window for the
     same reason the prompt one is: a module cannot open a modal bigger than its
     own container, and what this window shows is not the module's material anyway —
     it is what the AGENT has been told. See `Tools.tsx`. */
  const [toolsFor, setToolsFor] = useState<string | null>(null)
  /* Whose Claude Code skills are open (protocol 2.5.0). See `Skills.tsx`. */
  const [skillsFor, setSkillsFor] = useState<string | null>(null)
  /** Whose settings are open in the modal (protocol 2.15.0), from a container's gear or Frame menu. */
  const [settingsFor, setSettingsFor] = useState<string | null>(null)

  /* Where each container's body ended up, measured. The module pages are positioned
     over these from a layer that outlives the containers. */
  const { rects, room, width, surface, body, measure, remeasure, settle } = useRects()

  /*
   * How tall a row is DRAWN: the room, divided into `CANVAS_ROWS` of them.
   *
   * A canvas is twelve columns wide and fifty-six rows tall, and both are
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
  /* The same, as state: what waits for the canvases' first read — the report of what is open and
     the stream — so a load says it once, about the kehikko it opens, and not first about none. */
  const [settled, setSettled] = useState(false)
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
        /* Read before the request, because the server wants it: on the first
           load after the epic moved off the kehikot, the kehikko this browser
           was last on is the best answer to "which epic was this project on".
           See `hintSubject` in `server/canvases.ts`. */
        const remembered = readOpen(window.localStorage)
        /* Joined: StrictMode runs this twice in development, and one read serves both. */
        const found = await hostRead('canvases:first', () => fetchCanvases(undefined, remembered), { keep: false })
        if (cancelled) return
        firstVisit.current = remembered === null
        const project = chooseProject(found.projects, readOpenProject(window.localStorage))
        setProjects(found.projects)
        setProjectId(project)
        setCanvases(found.canvases)
        setSubjects(found.subjects)
        /* Within the project, and only within it. A remembered kehikko that
           belongs to another project is not the one to open: the switcher
           beside it would not list it, and a canvas its own switcher cannot see
           is one nobody can get back to. */
        setOpenId(chooseOpen(found.canvases, remembered, project))
        loaded.current = true
        setSettled(true)
        /* A project's `kehikot.json` that would not read. Said in the header's error line,
           where the host's own line is, because the person who edited that
           file is the person looking at this page, and it stays until a load
           finds the file reads again. See `server/kehikot.ts`. */
        if (found.trouble.length) setTrouble(found.trouble.join(' '))
      } catch (error) {
        if (cancelled) return
        setSettled(true)
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
    if (!settled) return
    let here = true
    /* On arriving, and on nothing else: not focus, not visibility, not a
       frame. See `arrive`. */
    void arrive(openId, async () => {
      if (here) await lookRef.current?.()
    }).then(() => {
      /* The server has now been asked knowing what this page has open. Until
         then a module that is not running may only be one it has not been
         asked to start — see `asked` in `host/standing.ts`. */
      if (here) setAskedFor(openId)
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
  }, [openId, settled])

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
    if (!settled) return
    const stop = watchCanvases(
      openId,
      (kehikko, note) => {
        void (async () => {
          if (!loaded.current) return
          /* Awaited: the re-read has to be of what the pending writes LEFT. Two
             requests sent one after the other are not two requests answered in
             that order, and a re-read that overtook the write would put the
             older arrangement on screen over the one just stored. */
          const saved = writer.pending(kehikko)
          await writer.flushAll()
          const before = writer.stamp()
          try {
            const found = await fetchCanvases()
            /* What the person changed while that read was out is not in it, and
               is on its way to the server as a whole arrangement — or has
               already arrived there, after the read was taken. Their kehikko
               is left as they have it, so that what is on screen and what is
               about to be stored are the same thing: their press wins, and is
               not briefly undone in front of them. A fold from the door that
               their arrangement crossed is put onto it — see `reread`. */
            const theirs = new Set(
              found.canvases.filter((c) => writer.edits(c.id) !== (before.get(c.id) ?? 0)).map((c) => c.id),
            )
            setCanvases((was) => {
              const next = reread<Placement, Canvas>(was, found.canvases, theirs, note ? { kehikko, note, saved } : null)
              /* A write from inside an updater, as the first-visit fill below
                 does it: merged per kehikko, so being run twice is one write. */
              if (next.write) writer.write(next.write.kehikko, { placements: next.write.placements })
              return next.canvases
            })
            setSubjects(found.subjects)
            /* Signed in the same breath as the arrangement it is about, so the
               fold and who made it are drawn together. Only for the kehikko on
               this screen: a mark is about what somebody watched happen. */
            if (note && kehikko === openId) {
              setSigned((was) => ({ kehikko, marks: noted(was?.kehikko === kehikko ? was.marks : {}, note) }))
            }
          } catch {
            /* The next wake, or the next load, will do. A canvas that could not
               be re-read is the arrangement the person already has on screen. */
          }
        })()
      },
      /* With the reading, when the host sent it with the news: taken, not asked for again. */
      (reading) => (reading ? takeRef.current(reading) : void lookRef.current?.()),
      /* A project's epics changed — an agent's `create_epic`, or a `+` in
         another window. Re-read only when it is THIS page's project: the
         dropdown of a page standing in the thesis folder has nothing to learn
         from an epic made in another project's. Through `projectRef`, for the
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
      /* A mark changed — a module's press, or an agent at the door. Re-read
         and let the context carry it to every frame, for `epics`' reason only
         when it is this page's project. */
      (project) => {
        if (project !== projectRef.current) return
        void (async () => {
          try {
            const found = await fetchDispositions(project)
            if (project === projectRef.current) setMarks(found)
          } catch {
            /* The marks the page has are the marks it had. */
          }
        })()
      },
      /* The project's tracker reading started or landed a read. The signal
         came with the news and goes straight into the context; when a read
         lands, the sources are re-read for the bar's sentence about them. */
      (project, signal) => {
        if (project !== projectRef.current) return
        setTracker((was) => ({ ...was, ...signal }))
        if (signal.refreshing) return
        void (async () => {
          try {
            const found = await fetchTracker(project)
            if (project === projectRef.current) setTracker(found)
          } catch {
            /* The bar keeps what it had. */
          }
        })()
      },
      /* Material kept for the project's epics changed — the host's own write,
         a module's report, or an edit to the project's files. The list came
         with the news and goes straight into the context. */
      (project, changes) => {
        if (project !== projectRef.current) return
        setRewritten(changes)
        /* And the list of epics is read again, because the parts of an epic
           are read off it — the list in the epic's own file, and for each
           part what the modules hold. Somebody who has just added a part, or
           tied a chapter to one in a module, is looking at the bar to see it
           arrive. On a change from ANY source, not only the host's: what a
           module holds for a part is published from that module's own folder
           (`parts.json`), and its change is the only news of it there is. The
           read is a few small local files, and a list that says what the last
           one said is kept as the same object, so nothing downstream moves. */
        void (async () => {
          try {
            const found = await fetchEpics(project)
            if (project === projectRef.current) setHeld((was) => (was && JSON.stringify(was) === JSON.stringify(found) ? was : found))
          } catch {
            /* The list the page has is the list it had. */
          }
        })()
      },
      /* An agent's `press_item`, handed to this page to make. */
      (order) => orderedRef.current?.(order),
      /* The stream opened, or reopened after the server went away: say again
         what the modules here have declared — and, on a reopening, which
         kehikko this page has open. The stream's own url says it too, but a
         server that restarted has also forgotten the page's word, and the
         word is what outlives a stream that drops again. */
      (again) => {
        /* The first opening follows the page's own reads and reports by a moment, and a server
           that has not restarted still holds them: only a reopening says them again. */
        if (!again) return
        /* A host that restarted may be another version. */
        forgetRead('health')
        void reportOpen(openId, { again: true })
        repostRef.current?.()
        inboxWokeRef.current?.(-1, null)
      },
      (project, rev) => inboxWokeRef.current?.(project, rev),
      /* A project was found again where its folder went, in this window or
         another: the list, and the kehikot read from the file where it is now. */
      () => void relistRef.current?.(),
      /* An agent's `open_address`, handed to this page to show. */
      (order) => addressedRef.current?.(order),
    )
    return stop
    /* `openId` too, so the stream is reopened when the open kehikko changes.
       The stream's URL carries what this page has open — see `watchCanvases` —
       and a socket left open on a stale kehikko would tell the server the wrong
       thing for as long as it lived. Reopening it costs one request. */
  }, [writer, openId, settled])

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
   * Not cached per project. `.kehikot/host/epics` is rewritten underneath a running host
   * by anything that refreshes the epics, and a cache here would be this page
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
        if (!stop.signal.aborted) {
          setHeld(found)
          setHeldProject(projectId)
        }
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

  /* The open project's dispositions, re-read on a project switch. Cleared
     first: another project's marks on refs that happen to share a spelling
     would be verdicts about work this project does not have. */
  useEffect(() => {
    setMarks([])
    if (projectId === null) return
    const stop = new AbortController()
    void (async () => {
      try {
        const found = await fetchDispositions(projectId, stop.signal)
        if (!stop.signal.aborted) setMarks(found)
      } catch {
        /* No marks is what modules fall back from anyway. */
      }
    })()
    return () => stop.abort()
  }, [projectId])

  /* The open project's tracker reading, read on a project switch. Asking is
     what starts the project's first read — never the host's startup. */
  useEffect(() => {
    setTracker({ at: null, refreshing: false, sources: [] })
    /* Another project's changes are not this one's. Nothing is fetched in
       their place: every container reads its material afresh on the switch. */
    setRewritten([])
    if (projectId === null) return
    const stop = new AbortController()
    void (async () => {
      try {
        const found = await fetchTracker(projectId, stop.signal)
        if (!stop.signal.aborted) setTracker(found)
      } catch {
        /* Nothing read is what the context says by default. */
      }
    })()
    return () => stop.abort()
  }, [projectId])

  /* "Refresh all". The bar shows it running from the wake the server sends
     when the read starts, so this only has to ask; the answer is the outcome,
     and the sentence about any source that failed arrives with the re-read. */
  const onRefreshTrackers = useCallback(() => {
    const project = projectRef.current
    if (project === null) return
    setTracker((was) => ({ ...was, refreshing: true }))
    void refreshTracker(project)
      .catch(() => null)
      .then(async () => {
        try {
          const found = await fetchTracker(project)
          if (project === projectRef.current) setTracker(found)
        } catch {
          if (project === projectRef.current) setTracker((was) => ({ ...was, refreshing: false }))
        }
      })
  }, [])

  /*
   * When the last sweep finished, for the focus sweep's quiet floor. A ref,
   * because it should cause no render. That sweeps never overlap — a sweep asks
   * every registered module for its manifest, and two at once are two answers
   * racing to land — is `oneAfterAnother`.
   */
  const sweptAt = useRef(0)
  /** Which process each module was last seen ready on, to see a restart. */
  const runs = useRef(new Runs())
  /** The current `look`, for the effects declared above it. See `reportOpen`. */
  const lookRef = useRef<(() => Promise<void>) | null>(null)

  /** The reading the page holds, for `newerReading`: a ref, because it should cause no render. */
  const heldReading = useRef<RegistryView | null>(null)

  /**
   * A reading of the modules, taken: a look's answer, or the one the host sent with its news
   * (`{ registry: true, modules }` on `/host/watch`). Not one older than the reading held — a look
   * asked before a module came up can land after the news that it did.
   */
  const take = useCallback((view: RegistryView) => {
    if (!newerReading(heldReading.current, view)) return
    heldReading.current = view
    /* A module the host has restarted gets a new document, not the one the
       old server sent. See `Runs` in `host/standing.ts`. */
    const again = runs.current.seen(view.presences)
    if (again.length) {
      setGenerations((was) => {
        const next = { ...was }
        for (const id of again) next[id] = (next[id] ?? 0) + 1
        return next
      })
    }
    setRegistry(view)
    setRegisteredIcons(view.presences)
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
  }, [])
  const takeRef = useRef(take)
  takeRef.current = take

  /* One at a time, and a call made during one gets one more after it rather
     than nothing: see `oneAfterAnother`. */
  const look = useMemo(() => oneAfterAnother(async (fresh) => {
    setLooking(true)
    try {
      /* `fresh` after a person's press: every manifest asked again, not the host's kept ones. */
      take(await fetchRegistry(undefined, fresh))
    } catch (error) {
      /* The sentence, and the recognition of it, both come from
         `host/reachable.ts`. Four places in this program used to write their own
         wording of this one fault and none of them said what to do about it —
         see the essay there. The extra clause is this caller's alone: a failed
         sweep means the host knows nothing about what is registered, which is
         not true of the other three. */
      setTrouble(notAnswering(error, 'Nothing is known about what is registered until it does.'))
    } finally {
      sweptAt.current = Date.now()
      setLooking(false)
    }
  }), [take])

  lookRef.current = look

  /* The first look, joined rather than queued: StrictMode runs this twice in development, and
     one answer serves both. The look after the report is `arrive`'s. */
  useEffect(() => {
    void look.join()
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
   * Look again once, if the host has said nothing for a long while about something it said was
   * moving.
   *
   * The host starts a module when a kehikko that has it is opened — see `server/lifecycle.ts` —
   * and tells this page when it is up, or that it gave up waiting, with the reading
   * (`untilAnswered` in `server/server.ts`); an update, a restart and a pinned version being
   * prepared are told at every step (`server/wake.ts`). So nothing here polls while modules start.
   * It used to: a look every 1.5 s while anything said "starting", and every 2 s while a version
   * was being prepared, each look asking every module not answering yet — 33 reads of
   * `/host/modules` in 9.1 s after the app started, on the person's Monitor. What is left is one
   * look for news that was missed, after `MISSED_NEWS_MS`, re-armed by a reading that still says
   * something is moving.
   */
  useEffect(() => {
    if (!stillMoving(registry)) return
    const missed = window.setTimeout(() => void look(), MISSED_NEWS_MS)
    return () => window.clearTimeout(missed)
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
   * own `.kehikot/host/kehikot.json` and travels with the project — see
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

  /* A mark stands only while its container is as it was left — `standing` in
     `host/folds.ts`. Run against every arrangement drawn, so the person's
     press on the control, a drag, a removal or a switch of kehikko each take
     the mark with them and nothing has to remember to clear it. */
  useEffect(() => {
    setSigned((was) => {
      if (!was) return was
      if (!open || was.kehikko !== open.id) return null
      const kept = standing(was.marks, open.placements)
      if (kept === was.marks) return was
      return Object.keys(kept).length ? { kehikko: was.kehikko, marks: kept } : null
    })
  }, [open])

  /** Change the open canvas, on screen now and in the database shortly. */
  const change = useCallback(
    (edit: {
      name?: string
      project?: number | null
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
   * What the open project is about: its epic, and the refs picked out of it.
   *
   * Read by PROJECT, and the open kehikko is deliberately not an input. It
   * used to be `open.epic`, so the kehikko dropdown was also an epic switch —
   * every kehikko remembered its own — and the person reported exactly that.
   * Now `openId` can change all day and `about` does not move.
   */
  const about = subjectOf(subjects, projectId)

  /**
   * The subject as the wire wants it: the epic, and the project row itself.
   *
   * The row rather than the id because both of its fields go out on the wire.
   * Split by value rather than by identity, like the selection and the kehikko
   * below it, so that a re-render for any other reason does not look like a
   * context change and re-point every frame.
   */
  const subject = useMemo<Subject>(
    () => ({ epic: about.epic, ...(about.scope === 'project' ? { scope: 'project' as const } : {}), project }),
    [about.epic, about.scope, project],
  )

  /**
   * The parts the open epic is divided into, read off the project's own list
   * of epics, and `context.parts` composed from them and the project's stored
   * focus.
   *
   * Two inputs and neither is the open kehikko: `held` is the project's epics
   * and `about` is the project's subject. `openId` can change all day and this
   * does not move — the same guarantee `about` gives for the epic, and the
   * reason a layout cannot come to carry a focus.
   *
   * Empty while the epics are still being read. That briefly sends "nothing is
   * narrowed" to modules on a reload of a focused project, which is the safe
   * direction to be wrong in for a moment: a module shows too much and then
   * narrows, and never hides something on the strength of a list that has not
   * arrived.
   *
   * `narrowedTo` is the list as one string, for the reason `picked` is a joined
   * string: `partsOnWire` builds fresh rows on every render, and the context
   * memo below must depend on what they say and not on which objects say it.
   */
  const epicParts = useMemo<readonly Part[]>(
    () => (about.epic === null ? [] : (held?.epics.find((one) => one.slug === about.epic)?.parts ?? [])),
    [held, about.epic],
  )
  const narrowedTo = JSON.stringify(partsOnWire(epicParts, about.parts))

  /**
   * Change what the open project is about, on screen now and on the server at
   * once — no debounce, because nobody drags an epic.
   *
   * The rule that a different epic clears the selection is applied here, by
   * `withEdit`, and again by the server, which owns it. A failed write leaves
   * the screen as the person left it and says so, like the canvas writer.
   */
  const aboutRef = useRef(about)
  aboutRef.current = about
  const changeSubject = useCallback(
    (edit: SubjectEdit) => {
      const id = projectId
      if (id === null) return
      /* A different epic — or "All epics" — redraws every module: switched
         like a kehikko, with the pages being left fading out as they were
         (`useCalmSwitch`). A pick of parts is not a switch. */
      if (movesEpic(aboutRef.current, edit)) leavingRef.current()
      setSubjects((was) => withEdit(was, id, edit))
      editSubject(id, edit).catch((error: unknown) =>
        setTrouble(
          `What this project is about could not be saved: ${(error as Error).message}. What is on screen is unchanged; it is what is stored that is behind.`,
        ),
      )
    },
    [projectId],
  )
  /* For `controls`, which is built once — see `kehikkoRef`. */
  const changeSubjectRef = useRef(changeSubject)
  changeSubjectRef.current = changeSubject
  /* The stored picks as they are NOW, for an edit that answers later. */
  const storedPartsRef = useRef(about.parts)
  storedPartsRef.current = about.parts

  /* The epic only. The project is not a property of the subject a person edits
     here — it is changed by opening a project, and changing it from this
     direction would mean the epic picker could move a kehikko between
     projects. */
  const setSubject = useCallback(
    /* "All epics" is a scope and not an epic: it clears the epic. Any epic, or
       none, is one epic's scope again — see `scopeAfter` in `host/subject.ts`. */
    (next: Subject) => changeSubject(next.scope === 'project' ? { scope: 'project' } : { epic: next.epic }),
    [changeSubject],
  )

  /* What every module on the canvas is told. One object, memoised, so that a
     re-render caused by anything else does not look like a context change and
     re-point every frame. */
  /* The theme is part of it, so switching sends every framed module a new
     context and a module that honours it changes with the host. It used to be
     the literal 'dark', which made `kehikot.context.theme` a field this host
     filled in with a constant and never revisited — a lie that happened to be
     true. */
  /**
   * The selection, as a value rather than as an array identity.
   *
   * The project's selection is a fresh array on every read of the canvases —
   * a `.map` over the rows produces new objects — so depending on it directly rebuilt
   * the context whenever anything about any canvas changed, and every rebuild
   * is a `kehikot.context` posted to every framed module. Measured on a canvas
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
  const picked = about.selection.join('\n')
  /**
   * Which canvas is open, as the wire spells it.
   *
   * Split out of `open` by value rather than by identity, exactly like the
   * selection above and for exactly the same reason: `open` is a fresh object
   * on every read of the canvases, so depending on it here would rebuild the
   * context — and post a `kehikot.context` to every framed module — whenever
   * anything about any canvas changed.
   */
  /* `key` beside the row number: what a module files things under, because
     it is still this kehikko's after the project is removed and added again.
     `kehikkoOnWire` leaves out one the protocol would not read. This memo is
     what `kehikkoRef` holds, so an event carries the same three fields. */
  const kehikko = useMemo(
    () => kehikkoOnWire(open ? { id: open.id, name: open.name, key: open.key } : null),
    [open?.id, open?.name, open?.key],
  )
  /**
   * Where somebody is pointing inside a document, per kehikko, in memory only.
   *
   * (The essay is the passage's; the state it describes is `said`, below it,
   * which holds every module's pointing and from which a kehikko's passage is
   * read.)
   *
   * ## Per-canvas, and not per-host
   *
   * The epic and the selection are per PROJECT — they are what the person is
   * working on, and every kehikko works with every epic. A passage is not like
   * them: it is what THIS arrangement of containers is looking at. The consumer it exists for is another container beside the
   * one that pointed — a paper on the left, its notes on the right — and both
   * of those are on one canvas. A passage held per-host would mean a highlight
   * made in a paper on one canvas narrowing a notes container on another, where the
   * paper is not even open; the reader would see a container filter itself down to a
   * paragraph they cannot see, on a canvas they are not on, and nothing on
   * screen would explain it. So a kehikko's passage is the latest pointing by
   * a module placed ON it, and switching kehikko shows what the modules there
   * are pointing at.
   *
   * ## Not written down, which is the one place it differs from the selection
   *
   * The selection is stored with the project and survives a reload. This
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
   *
   * ## And beside it, what each container says it is showing
   *
   * What each container says it is showing and where it last pointed, per
   * MODULE, in memory only — and who PICKED, per project.
   *
   * In memory for the reason given at length above: a claim about a running
   * program's own state — "I have chapter three open" — that nobody is left to
   * renew once the program is gone. A host that wrote it down would be
   * asserting, after a restart, that a module which may not even be running is
   * showing a file it may have closed a week ago. So it lives with the page,
   * and a module that reloads says it again.
   *
   * Per module and NOT per canvas, which is what it was: a module's page is
   * one document shown on whichever kehikko asks for it, so what it said is
   * true wherever it is placed, and a kehikko is told what the modules ON it
   * said. Filed per canvas, a switch to another kehikko in the same project
   * found nothing — no passage, every row empty — until some module happened
   * to say something new, which a module that deduplicates never does.
   * `host/said.ts` has the argument, and the one thing that stays per kehikko:
   * the passage is the latest pointing among the modules placed on it, so a
   * highlight in a paper still does not narrow a notes container on a kehikko
   * the paper is not on.
   *
   * `host/showing.ts` composes the rows out of this and the selection, and has
   * the argument for why that is a projection and not a second source.
   *
   * `selectedBy` is honest about one gap: a selection read back out of the
   * database after a reload has no setter here, and goes into nobody's row. It
   * is still `context.selection`. Inventing who picked it would be the host
   * stating who said something it did not hear. It is keyed by PROJECT because
   * the selection it names the setter of is the project's.
   */
  const [said, setSaid] = useState<Said>(NOTHING_SAID)
  const [selectedBy, setSelectedBy] = useState<Record<number, string | null>>({})
  /**
   * Where in a change's code somebody is pointing, per kehikko (protocol
   * 2.13.0) — see `host/location.ts`. In memory and in this tab's
   * `sessionStorage`, so a reload keeps it; never in `kehikot.json`.
   */
  const [locations, setLocations] = useState<Locations>(() =>
    typeof window === 'undefined' ? NO_LOCATIONS : readLocations(window.sessionStorage),
  )
  const locationsRef = useRef(locations)
  locationsRef.current = locations
  useEffect(() => {
    if (typeof window !== 'undefined') writeLocations(window.sessionStorage, locations)
  }, [locations])
  /**
   * The last web address handed to each kehikko (protocol 2.16.0) — see
   * `host/address.ts`. In memory only: opening a page is a request made once,
   * and a reload is not the person asking again.
   */
  const [addresses, setAddresses] = useState<Addresses>(NO_ADDRESSES)
  const addressesRef = useRef(addresses)
  addressesRef.current = addresses
  /* An address put in front of the person because nothing on the kehikko shows pages. */
  const [offer, setOffer] = useState<Offer | null>(null)

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
    /* Every pointing, and everything a container said it shows, and who
       picked: a document path belongs to the project that was just left, and
       a ref was picked out of an epic in it. */
    setSaid((was) => (was === NOTHING_SAID ? was : NOTHING_SAID))
    setSelectedBy((was) => (Object.keys(was).length === 0 ? was : {}))
  }, [projectId])

  /* A code location lives while its change is picked out. Only once the
     project's selection has been read: before that it is empty for want of
     reading, and a location restored from this tab would be cleared by a
     selection nobody made. Moving to another project prunes every one whose
     change that project has not picked — which is all of them, as a rule. */
  const selectionKnown = projectId !== null && subjects[projectId] !== undefined
  useEffect(() => {
    if (!selectionKnown) return
    setLocations((was) => stillStanding(was, picked ? picked.split('\n') : []))
  }, [picked, selectionKnown])

  /* The latest pointing among the modules placed on the open kehikko — see
     `passageOn`. Switching kehikko changes who is placed, not what was said. */
  const placedIds = (open?.placements ?? []).map((p) => p.i).join('\n')
  /* The host's own pointing counts too: "Open the file" in a module's settings points the Editor
     at it (see below), and that is the host's word, not a module's. */
  const passage = useMemo(
    () => (placedIds ? passageOn(said, [...placedIds.split('\n'), HOST_POINTS]) : null),
    [said, placedIds],
  )

  /* What a module's settings need of this page (protocol 2.15.0): "Open the file" in the Editor, read-only, when an Editor is on the open kehikko — the host points the
     canvas at the file, as itself. Without one, the form shows the file in a dialog. */
  useEffect(() => {
    const editor = placedIds.split('\n').includes(EDITOR_ID)
    setSettingsFileOpener(
      editor
        ? (path) => {
            setSaidRef.current((was) => pointed(was, HOST_POINTS, { path, page: null, from: null, to: null, quoted: '', section: null }))
            return true
          }
        : null,
    )
    return () => setSettingsFileOpener(null)
  }, [placedIds])

  /**
   * The passage as a VALUE, for the same reason `picked` is a joined string.
   *
   * `toWireContext` runs the protocol's schema and hands back a fresh object
   * every time, so a memo depending on the passage by identity would rebuild
   * the context — and post a `kehikot.context` into every frame on the canvas —
   * on every render that happened to produce an equal passage. There is a
   * measured history of exactly this here: seventeen identical contexts during
   * startup, because a `.map` over the canvases made a new selection array each
   * time and nobody checked. A passage is worse to get wrong than a selection
   * was, because a highlight changes on every pointer move during a drag.
   */
  const pointing = passage === null ? '' : JSON.stringify(passage)

  /* The code location on the open kehikko, by value (`codeAt`) for `pointing`'s reason. */
  const codeLocation = locationOn(locations, openId, picked ? picked.split('\n') : [])
  const codeAt = codeLocation === null ? '' : JSON.stringify(codeLocation)

  /* The address on the open kehikko, by value (`addressAt`) for `pointing`'s reason. */
  const shownAddress = addressOn(addresses, openId)
  const addressAt = shownAddress === null ? '' : JSON.stringify(shownAddress)

  /**
   * Every container on the open kehikko, whether it is picked out, and what it
   * shows — composed on every render, cheaply, and depended on BY VALUE below.
   *
   * `open.placements` is a fresh array on every read of the canvases, every
   * pointing is a fresh object on every context, and `containersOf` builds
   * fresh rows out of both. Depending on any of those by identity is the
   * seventeen-identical-broadcasts problem `picked` and `pointing` exist to
   * prevent, so what the memo reads is the list as one string.
   */
  const described = containersOf({
    placements: open?.placements ?? [],
    said: said.showing,
    pointed: pointedBy(said),
    selection: picked ? picked.split('\n') : [],
    selectedBy: projectId === null ? null : (selectedBy[projectId] ?? null),
  })
  const arranged = containersKey(described)

  /* By value, for the reason `pointing` is: a re-read that found the same
     marks is a fresh array, and must not be a `kehikot.context` to every frame. */
  const marked = JSON.stringify(marks)
  /* By value too: the bar's state carries the sources, which the context does
     not, and a re-read that changed only a source's sentence is not news for
     the frames. */
  const trackerAt = tracker.at
  const trackerBusy = tracker.refreshing

  const context = useMemo(
    () =>
      toWireContext(subject, theme, picked ? picked.split('\n') : [], kehikko, passage, described, marks, {
        at: trackerAt,
        refreshing: trackerBusy,
      }, rewritten, JSON.parse(narrowedTo) as EpicPart[], codeLocation, shownAddress),
    /* `pointing` and not `passage`, `arranged` and not `described`: the
       value, not the identity. Both objects are intentionally absent from the
       list and the lint rule that would ask for them is wrong here — see the
       essays on `pointing` and `described` above. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subject, theme, picked, kehikko, pointing, arranged, marked, trackerAt, trackerBusy, rewritten, narrowedTo, codeAt, addressAt],
  )

  /**
   * What each module on the open kehikko is told when the person switched off a connection into it
   * (`host/connections.ts`, `receiverContext`): a context of its own, only for those modules; every
   * other frame is sent the shared one. By value, like the shared one.
   */
  const switches = open?.connections ?? null
  const switchesKey = JSON.stringify(switches)
  /* Who is told `context.show` (protocol 2.28.0): the containers on the kehikko it is for whose
     manifests say they show its subject (`showReceivers`), by value. */
  const showTold = showReceivers(shownTo, open?.id ?? null, placedIds ? placedIds.split('\n') : [], (id) =>
    registry?.presences.find((one) => one.id === id)?.module as ShowingManifest | undefined,
  ).join('\n')
  const showKey = showTold ? JSON.stringify(shownTo?.show) : ''
  const contextsFor = useMemo<Readonly<Record<string, ModuleContext>>>(
    () => {
      const told = showTold ? showTold.split('\n') : []
      const withShow = (out: Record<string, ModuleContext>) => {
        if (shownTo === null) return out
        for (const id of told) out[id] = { ...(out[id] ?? context), show: shownTo.show }
        return out
      }
      if (!switches || (switches.off.length === 0 && switches.only.length === 0)) return withShow({})
      const placed = placedIds ? placedIds.split('\n') : []
      const facts: ContextFacts = {
        subject,
        theme,
        selection: picked ? picked.split('\n') : [],
        selectedBy: projectId === null ? null : (selectedBy[projectId] ?? null),
        kehikko,
        said,
        placed: [...placed, HOST_POINTS],
        hostPoints: HOST_POINTS,
        placements: open?.placements ?? [],
        dispositions: marks,
        tracker: { at: trackerAt, refreshing: trackerBusy },
        content: rewritten,
        parts: JSON.parse(narrowedTo) as EpicPart[],
        location: codeLocation,
        address: shownAddress,
      }
      const out: Record<string, ModuleContext> = {}
      for (const id of placed) {
        const own = receiverContext(facts, id, switches)
        if (own) out[id] = own
      }
      return withShow(out)
    },
    /* By value, for the shared context's reasons; the shared context is a dependency so a change
       anything else made is a change here too. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [context, switchesKey, placedIds, showTold, showKey],
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
  /* The open kehikko's switches, read at the moment of a delivery: an event, a steps answer. */
  const switchesRef = useRef(switches)
  switchesRef.current = switches
  /* An extension switched off from its sender to a receiver on this kehikko is not relayed to it
     (`host/connections.ts`). */
  bus.holds = (from, to, extension) => !delivered(switchesRef.current, 'extension', from, to, extension)

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

  /* `controls` is built once; the setters are stable anyway, and reading
     them through refs keeps the pattern one pattern. */
  const setSaidRef = useRef(setSaid)
  setSaidRef.current = setSaid
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
   * ## Held in a ref, for the reason `emit` reads `kehikkoRef`
   *
   * `controls` is memoised on purpose — a new object per render would be a new
   * conversation per render — so it cannot close over `placements` or `live`,
   * which change constantly. The work is written here, fresh every render, and
   * `controls` calls through the ref. The same shape `setSaidRef` uses.
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
    Promise.resolve({ outcome: 'declined', project: null, why: 'This host is not ready to ask anybody yet.' }),
  )
  pickRef.current = (from) => {
    const declined = (why: string): Promise<Picked> =>
      Promise.resolve({ outcome: 'declined' as const, project: null, why })
    if (askingRef.current) {
      return declined('Somebody is already being asked to choose a project.')
    }
    if (projects.length === 0) {
      return declined('This host will not ask right now.')
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
      /* Its id too (2.1.0) — see `pickedFrom`. */
      ask.settle({ outcome: 'picked', project: pickedFrom(project), why: '' })
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

  /* `location.set`, answered against this render's open kehikko and selection;
     through a ref for the reason `filterRef` is one. */
  const locateRef = useRef<CanvasControls['locate']>(() => ({
    outcome: 'declined',
    why: 'This host is not ready to hold a code location yet.',
  }))
  locateRef.current = (from, next, intent) => {
    if (openId === null || !open) return { outcome: 'declined', why: 'No kehikko is open, so there is nobody to show a code location to.' }
    if (!open.placements.some((p) => p.i === from)) {
      return { outcome: 'declined', why: `${from} is not on the kehikko that is open, so it is not pointing at anything anybody can see.` }
    }
    const out = located(locationsRef.current, {
      kehikko: openId,
      location: next,
      ...(intent === undefined ? {} : { intent }),
      by: from,
      at: new Date().toISOString(),
      selection: picked ? picked.split('\n') : [],
    })
    if (out.next !== locationsRef.current) {
      locationsRef.current = out.next
      setLocations(out.next)
    }
    return out.answer
  }

  /**
   * What each module says it reacts to, as last read while it was answering. A
   * module that shows pages and is still starting has no manifest in the sweep
   * yet; it is still a reader here, so an address waits for it rather than
   * being offered to the person.
   */
  const reactsSeen = useRef(new Map<string, readonly string[]>())
  noteReacts(reactsSeen.current, registry?.presences ?? [])
  const reactsOf = (id: string): readonly string[] | undefined => reactsSeen.current.get(id)

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
    const note = { by: byId.get(from)?.name ?? from, fold: said.folded, unfold: said.unfolded }
    setSigned((was) => ({ kehikko: on, marks: noted(was?.kehikko === on ? was.marks : {}, note) }))
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
      goto: (call, from) => gotoRef.current(call, from),
      activity: (from, items) => activityRef.current(from, items),
      /* The steps of a provider the person switched off for this module here are not handed to it. */
      withhold: (module, method, data) =>
        method === 'steps.list' || method === 'epic.get'
          ? stepsWithheld(data, (provider) => delivered(switchesRef.current, 'steps', provider, module))
          : data,
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
   * and a constant. With that gone, using the nominal row would be plainly wrong:
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
      const rowsFor = (wanted: number) => rowsHolding(wanted, rowHeight, MARGIN[1])

      /*
       * A collapsed container does not grow, and the request is not thrown away.
       *
       * `kehikot.resize` is a module saying how tall its document is. A module
       * is not told anything about itself being folded — see `onCollapse` —
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
   * The module is TOLD, in `kehikot.context`. This host refused to pin at all
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
          build: was[id]?.build,
          fault: was[id]?.fault ?? null,
          filters: groups,
          clear: was[id]?.clear,
        },
      }))

      const placements = open?.placements ?? []
      const container = placements.find((p) => p.i === id)
      if (!container) return
      const kept = settleFilters(groups, container.filters, container.filters)
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
        build: was[id]?.build,
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
        build: was[id]?.build,
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
   * back out of the next `kehikot.context`.
   */
  const onChooseFilter = useCallback(
    (id: string, group: string, option: string | string[]) => {
      const placements = open?.placements ?? []
      const container = placements.find((p) => p.i === id)
      if (!container) return
      const offer = live[id]?.filters ?? []
      const kept = settleFilters(offer, { ...container.filters, [group]: option }, container.filters)
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
   * ## The module keeps running, and every module is told
   *
   * Folding is not removing. The module's document stays in the frames layer
   * with everything in it — a scroll position, a half-typed line, a shell
   * session — for exactly the reason `Frames.tsx` exists: an iframe that leaves
   * the DOM is a document that has been destroyed, and there is no way to get
   * it back. A folded container's page is hidden the same way a container on another
   * canvas is hidden, which is a path this program has had since the beginning.
   *
   * What stood here argued against putting the fold on the wire: from inside,
   * a folded container cannot be told from one on a kehikko nobody is looking
   * at, so a module that stopped work on the strength of it would stop and
   * resume in cases it cannot detect. That half still holds, and is why
   * nothing is sent to the folded module ABOUT ITSELF — no message, no
   * `context.folded`, and its page goes on running.
   *
   * What changed it is the ask `selected` met before it (see `onSelect`): a
   * NEIGHBOUR needs the fact. A module about to point Slides at slide 6 has
   * to know whether Slides is in view, and one that unfolded it for a
   * walk-through has to know whether a person has moved it since, before it
   * puts things back. So since protocol 1.1.0 every row of
   * `context.containers` says `folded` — to every frame alike, composed in
   * `host/showing.ts` from the same `collapsed` this press writes — and a
   * module may ask for a fold with `view.fold` (`foldRef`, above). A press
   * here, that ask and an agent's `fold_modules` are one write, `folded` in
   * `host/columns.ts`, and this press is what wins over the other two.
   */
  const onCollapse = useCallback(
    (id: string, collapsed: boolean) => {
      const placements = open?.placements ?? []
      change({ placements: pressed(placements, id, collapsed) })
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
   *     of a tracker. It goes out in `kehikot.context` and every module is told.
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
      /* The rows a top edge took from, or gave to, the containers on top of
         it: those heights were chosen by the same hand, so they are wishes. */
      const given = traded.current
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
          wish: given.get(item.i) ?? said.wish,
          selected: before?.selected ?? false,
          /* Carried across for the same reason as everything above it. A drag is
             not a change of mind about what a container is showing, nor about how
             often it reads. */
          filters: before?.filters ?? {},
          refreshEvery: before?.refreshEvery ?? null,
          /* And the version: a drag is not a choice of which version runs. */
          version: before?.version ?? null,
          /* And the scope: a drag is not a choice of what the container shows. */
          scope: before?.scope ?? null,
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
      if (!same(open?.placements ?? [], drawn)) {
        /* Spent only by a call that writes. The grid also reports a layout at
           the START of a gesture, when `maxH` changes as the press lands on a
           top corner, and that report changes nothing: clearing these then
           would lose what the hand has not yet said. */
        resized.current = null
        traded.current = new Map()
        change({ placements: drawn })
      }
    },
    [change, open?.placements],
  )

  /* "new kehikko…" opens the layout picker (`Layouts.tsx`), whose first card
     is Blank; the picker makes the kehikko — in the project that is open, since
     a kehikko in no project is one no dropdown lists — and hands it here. */
  const onMade = useCallback((made: Canvas) => {
    setCanvases((was) => [...was, made])
    setOpenId(made.id)
  }, [])

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
   * TOLD — `kehikot.context` goes out with the new project's name and path, and
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
   * told before — no `kehikot.context` goes out, no module re-reads anything,
   * and the project is on the same epic it was on a second ago. That is
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
   * One edit of the open epic's list of parts, from the picker in the bar:
   * add, rename, move or remove. Answers whether it was made.
   *
   * The server decides and writes (`editParts` in `server/holdings.ts`); the
   * row it answers with replaces the one this page has, so the picker shows
   * the edit at once and `context.parts` carries it to every module in the
   * same render. Every other page standing in the project hears through
   * `context.content`. A refusal is the server's own sentence on the error
   * line, and the picker's name box is left standing.
   */
  const onEditParts = useCallback(
    async (edit: PartsEdit): Promise<boolean> => {
      const epic = about.epic
      if (projectId === null || epic === null) return false
      try {
        const done = await editParts(projectId, epic, edit)
        const row = done.epic
        if (row) setHeld((was) => (was ? { ...was, epics: was.epics.map((one) => (one.slug === row.slug ? row : one)) } : was))
        if (done.result.outcome === 'declined' || done.result.outcome === 'no-such-part') {
          setTrouble(
            done.result.outcome === 'declined'
              ? `The parts of ${epic} were not changed: ${done.result.why}`
              : `The parts of ${epic} were not changed: that part is no longer one of them.`,
          )
          return false
        }
        /* A part the person removed here while it was picked: the pick goes
           with it, in the same render as the list, so the bar never says "a
           picked part is gone" about their own press. See `unpicked`. */
        const left = unpicked(storedPartsRef.current, edit)
        if (left) changeSubjectRef.current({ parts: left })
        setTrouble(null)
        return true
      } catch (error) {
        setTrouble(`The parts of ${epic} were not changed: ${(error as Error).message}`)
        return false
      }
    },
    [projectId, about.epic],
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
   * right. A retitle changes a label, not what the project is on. An agent
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
   * to the header's error line, where every other refusal goes.
   */
  const onCreateEpic = useCallback(
    async (slug: string, title: string): Promise<boolean> => {
      if (projectId === null) return false
      try {
        const made = await createEpic(projectId, slug, title)
        setHeld(await fetchEpics(projectId))
        changeSubject({ epic: made.epic.slug })
        setTrouble(null)
        return true
      } catch (error) {
        setTrouble(`${slug || 'that epic'} was not created: ${(error as Error).message}`)
        return false
      }
    },
    [projectId, changeSubject],
  )

  /**
   * Delete one epic's file from the open project.
   *
   * If the project was on it, it moves to no epic — a subject naming a file
   * that is gone would be a header pointing at nothing. The server does the
   * same on its side; this is the screen agreeing without waiting for a read.
   * A slug remembered from somewhere this did not reach is left to
   * `toWireContext`'s fallback, which is what it is for.
   */
  const onDeleteEpic = useCallback(
    async (slug: string) => {
      if (projectId === null) return
      try {
        await deleteEpic(projectId, slug)
        setHeld(await fetchEpics(projectId))
        if (about.epic === slug) setSubjects((was) => withEdit(was, projectId, { epic: null }))
        setTrouble(null)
      } catch (error) {
        setTrouble(`${slug} was not deleted: ${(error as Error).message}`)
      }
    },
    [projectId, about.epic],
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
  /**
   * A project found again where its folder went ("Locate…"). Same row, same
   * kehikot, same Inbox; only the path changed, so the list is read again and
   * the page stands in it.
   */
  const onLocated = useCallback(async (found: Project) => {
    setLocating(null)
    try {
      const [read, everyProject] = await Promise.all([fetchCanvases(), fetchProjects()])
      setProjects(everyProject)
      setCanvases(read.canvases)
      setSubjects(read.subjects)
      setProjectId(found.id)
      setOpenId((was) => (read.canvases.some((c) => c.id === was && c.project === found.id) ? was : chooseOpen(read.canvases, null, found.id)))
      setTrouble(null)
    } catch (error) {
      setTrouble(`The projects could not be read again: ${(error as Error).message}`)
    }
  }, [])

  const onForgetProject = useCallback(
    async (id: number) => {
      try {
        await forgetProject(id)
        const [found, everyProject] = await Promise.all([fetchCanvases(), fetchProjects()])
        setProjects(everyProject)
        setCanvases(found.canvases)
        setSubjects(found.subjects)
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
        setSubjects(found.subjects)
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

  /**
   * Rename any kehikko, not only the open one — the pencil is on every row of
   * the kehikko menu, as the retitle is on every row of the epic menu.
   */
  const onRename = useCallback(
    (id: number, name: string) => {
      setCanvases((was) => was.map((canvas) => (canvas.id === id ? { ...canvas, name } : canvas)))
      writer.write(id, { name })
    },
    [writer],
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
          /* The raw setter: this runs inside an updater, which must not touch
             the page. A kehikko that is being deleted is not faded out. */
          setOpenIdNow((current) => (current === id ? (left[0]?.id ?? null) : current))
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

  /* How the modules on the open kehikko affect each other, from their manifests, and the person's
     switches for it (`host/connections.ts`): the Providers & Consumers tab of each module's window. */
  const connectionSides = useMemo(() => {
    const order = [...(open?.placements ?? [])].sort((a, b) => a.y - b.y || a.x - b.x)
    const modules = order.map((p) => {
      const presence = byId.get(p.i)
      return { id: p.i, name: presence?.name ?? presence?.module?.name ?? p.i, manifest: (presence?.module ?? null) as ConnectionModule | null }
    })
    return sidesOf(modules, connectionsOf(modules, open?.connections), open?.connections)
  }, [open, byId])
  const onConnections = useCallback(
    (next: ConnectionsSetting) => {
      const id = openId
      if (id === null) return
      const setting = tidy(next)
      setCanvases((was) => was.map((canvas) => (canvas.id === id ? { ...canvas, connections: setting } : canvas)))
      saveConnections(id, setting).catch((error: Error) =>
        setTrouble(`The connections on this kehikko could not be saved: ${error.message}. What is on screen is unchanged; it is what is stored that is behind.`),
      )
    },
    [openId],
  )

  /* What is registered, id → name, for the layout picker's "will install". */
  const registeredNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const presence of registry?.presences ?? []) map.set(presence.id, presence.name ?? presence.id)
    return map
  }, [registry])
  /* And what each one's content belongs to (protocol 2.29.0), at its default: for the layout cards. */
  const registeredScopes = useMemo(() => {
    const map = new Map<string, ContainerScope>()
    for (const presence of registry?.presences ?? []) if (presence.module) map.set(presence.id, scopeOfContainer(presence.module, null))
    return map
  }, [registry])

  /**
   * One item of a module's header, chosen in its container's menus.
   *
   * A press, like the clear and the refresh: made at the moment of the press
   * on whichever frame is standing, never stored, never replayed. Judged
   * first against the header as it is declared NOW (`pressing`, which asks the
   * protocol's `pressRefusal`) — the menu a person is looking at was drawn
   * from a list the module may since have replaced. What comes back is what
   * the module said: taken, or not and why, and the menus say the why.
   */
  const byIdRef = useRef(byId)

  /**
   * The person's pick of a container's scope (protocol 2.29.0), from its
   * settings window: one of the scopes its module lists, kept with the
   * container's arrangement and shared in `kehikot.json` — but only when it is
   * not the module's default (`scopeToKeep`), so an arrangement on defaults
   * writes nothing new. The module is told in `context.scope` (`scopeToTell`).
   * Only the person picks: no MCP tool reaches this.
   */
  const onScope = useCallback(
    (id: string, picked: ModuleScope) => {
      const placements = open?.placements ?? []
      const container = placements.find((p) => p.i === id)
      const module = byId.get(id)?.module
      if (!container || !module) return
      const kept = scopeToKeep(module, picked)
      if (kept === (container.scope ?? null)) return
      change({ placements: placements.map((p) => (p.i === id ? { ...p, scope: kept } : p)) })
    },
    [change, open?.placements, byId],
  )

  /* The scope of the container whose settings window is open, and the pick (protocol 2.29.0). */
  const settingsScope = useMemo(() => {
    const module = settingsFor ? byId.get(settingsFor)?.module : undefined
    const container = settingsFor ? open?.placements.find((p) => p.i === settingsFor) : undefined
    if (!settingsFor || !module || !container) return null
    return { value: scopeOfContainer(module, container.scope), onPick: (picked: ModuleScope) => onScope(settingsFor, picked) }
  }, [settingsFor, byId, open?.placements, onScope])

  byIdRef.current = byId
  const onPressItem = useCallback(
    (id: string, press: Pressing): Promise<Pressed> =>
      pressing(headersRef.current[id] ?? NO_HEADER, press, byIdRef.current.get(id)?.name ?? id, (one) => presses.item(id, one)),
    [presses],
  )

  /**
   * The modules on this kehikko that offer their own storage view (a header
   * switch or go with a `storage` option), for the Storage dialog, and the
   * press that opens one — the same press a person makes in its menu.
   */
  const storageViews = useMemo<StorageViews>(
    () => ({
      of: (module) => storageViewOf(headers[module]) !== null,
      open: (module) => {
        const press = storageViewOf(headersRef.current[module])
        return press ? onPressItem(module, press) : Promise.resolve({ ok: false, why: 'That module no longer offers a storage view here.' })
      },
    }),
    [headers, onPressItem],
  )

  /**
   * An agent's `press_item`, made by this page.
   *
   * The door is on the server and the module's frame is here, so the server
   * hands the press to the one page it chose (`server/headers.ts`) and waits
   * for this page's answer. It travels the same road as a person's press from
   * here on — `onPressItem` — after one more question the server has already
   * asked: may an agent press this at all (`agentRefusal`). Asked again here
   * because what the server judged is what this page POSTED, and what is held
   * here is what the frame itself declared: the only copy a module wrote.
   * Something that talked the server into believing an item was marked for
   * agents has still not got it pressed.
   *
   * Nothing about the arrangement is touched: no container is moved, folded,
   * selected or added by a press.
   */
  const openRef = useRef(open)
  openRef.current = open
  const made = useRef<string[]>([])
  /* When an agent's press was last handed to each module (protocol 2.28.0, `host/navigate.ts`). */
  const agentPressedAt = useRef(new Map<string, number>())
  orderedRef.current = (order) => {
    /* A page mid-reconnect has two streams for a moment and hears an order on
       both. One press. */
    if (made.current.includes(order.id)) return
    made.current = [...made.current.slice(-31), order.id]
    void (async () => {
      const canvas = openRef.current
      const press: Pressing = { item: order.item, ...(order.value === undefined ? {} : { value: order.value }) }
      const items = headersRef.current[order.module]
      const refused =
        !canvas || canvas.id !== order.kehikko
          ? `The page that was asked does not have kehikko ${order.kehikko} open any more, so nothing was pressed.`
          : !canvas.placements.some((placement) => placement.i === order.module)
            ? `${order.module} is not on kehikko ${order.kehikko} any more, so nothing was pressed.`
            : !items
              ? `${order.module} has declared no header on the page, so there is nothing to press.`
              : agentRefusal(items, press, order.module)
      /* Noted before the press reaches the module: what it asks next is an agent's doing, and may
         not switch project (`personsPressRefusal`). */
      if (!refused) agentPressedAt.current.set(order.module, Date.now())
      const came: Pressed = refused ? { ok: false, why: refused } : await onPressItem(order.module, press)
      if (came.ok) {
        const label = items?.find((item) => item.id === order.item)?.label ?? order.item
        setPressNotes((was) => ({
          ...was,
          [order.module]: { n: (was[order.module]?.n ?? 0) + 1, item: order.item, text: `an agent pressed ${label}` },
        }))
      }
      await answerPress(order.id, came)
    })()
  }


  /**
   * An agent's `open_address`, made by this page: into a container that shows
   * pages on the kehikko, and nowhere else — never an offer, never the person's
   * browser (`handed` with an agent asker). Answered like a press.
   */
  const addressesMade = useRef<string[]>([])
  addressedRef.current = (order) => {
    if (addressesMade.current.includes(order.id)) return
    addressesMade.current = [...addressesMade.current.slice(-31), order.id]
    const out = handAddressRef.current({ agent: true }, order.url, order.title, undefined, order.kehikko)
    void answerPress(order.id, out.outcome === 'shown' ? { ok: true, why: '' } : { ok: false, why: out.why })
  }

  /** What each pinned container is doing, by `<kehikko>|<module>`. See `server/pins.ts`. */
  const pinViews = useMemo(() => {
    const map = new Map<string, PinView>()
    for (const pin of registry?.pins ?? []) map.set(`${pin.kehikko}|${pin.module}`, pin)
    return map
  }, [registry])

  /** A ready version's presence by `<module>@<tag>`, for a page kept loaded on another kehikko. */
  const readyVersions = useMemo(() => {
    const map = new Map<string, Presence>()
    for (const pin of registry?.pins ?? []) if (pin.state === 'ready' && pin.presence) map.set(`${pin.module}@${pin.version}`, pin.presence)
    return map
  }, [registry])

  /** The kehikot of the open project, which is what the header lists. */
  const here = useMemo(() => inProject(canvases, projectId), [canvases, projectId])
  /* What the tour's waiting steps wait for (`src/host/tour.ts`): a project
     open, an epic chosen, parts picked, a kehikko here with something on it. */
  const tourFacts = useMemo(
    () => ({
      /* The home folder a fresh host opens by itself is not a project
         anybody picked, and nothing is written under it. */
      project: projectPicked(projectId, project),
      projects: projects.filter((one) => !one.home).length,
      epic: about.epic !== null || about.scope === 'project',
      parts: about.parts.length > 0,
      kehikko: here.some((canvas) => canvas.placements.length > 0),
    }),
    [projectId, project?.home, projects, about.epic, about.scope, about.parts.length, here],
  )
  /* The move within the open project: what `view.goto` always did, and what
     the Inbox's press uses. With a `show` (2.28.0), the show is handed to the
     kehikko the move ended on once it moved. */
  const gotoHere = ({ epic, parts, kehikko: key, show }: GotoCall, from?: string): GotoAnswer => {
    const now = about.epic
    const row = held?.epics.find((one) => one.slug === epic)
    if (held === null) {
      return { outcome: 'declined', epic: now, why: "This project's epics are still being read. Ask again in a moment." }
    }
    if (!row) return { outcome: 'no-such-target', epic: now, why: `This project has no epic ${epic}.` }
    const known = new Set((row.parts ?? []).map((part) => part.id))
    const missing = (parts ?? []).filter((id) => !known.has(id))
    if (missing.length) {
      return { outcome: 'no-such-target', epic: now, why: `${epic} has no part ${missing.join(', ')}.` }
    }
    const canvas = key === undefined ? null : (here.find((one) => one.key === key) ?? null)
    if (key !== undefined && canvas === null) {
      return { outcome: 'no-such-target', epic: now, why: `This project has no kehikko ${key}.` }
    }
    if (canvas !== null) setOpenId(canvas.id)
    changeSubjectRef.current({ epic, selection: [], ...(parts ? { parts: [...new Set(parts)] } : {}) })
    const id = projectRef.current
    if (id !== null) setSelectedByRef.current((was) => (was[id] === null ? was : { ...was, [id]: null }))
    const landed = canvas?.id ?? openId
    if (show && landed !== null) setShownTo({ kehikko: landed, show: shownBy(show, from, new Date()) })
    return { outcome: 'moved', epic, why: '' }
  }
  gotoHereRef.current = gotoHere

  /**
   * `view.goto`, as a module asks it (protocol 2.28.0 adds `project` and
   * `show`; `host/navigate.ts` holds every rule). Another project is switched
   * to as the person's own switch does (`onProject`, the calm switch), and the
   * rest of the call is gone to there once its epics are read; the answer waits
   * for that.
   */
  gotoRef.current = (call, from) => {
    const decline = (why: string): GotoAnswer => ({ outcome: 'declined', epic: about.epic, why })
    const presence = from ? byIdRef.current.get(from) : undefined
    const plan = planJump(call, {
      name: presence?.name ?? presence?.module?.name ?? from ?? 'This module',
      navigates: navigatesOf(presence?.module as ShowingManifest | undefined),
      projects,
      open: projectId,
      press: {
        onScreen: from !== undefined && (open?.placements ?? []).some((placement) => placement.i === from),
        focused: document.visibilityState === 'visible' && document.hasFocus(),
        agentPressedAt: from ? (agentPressedAt.current.get(from) ?? null) : null,
        now: Date.now(),
      },
    })
    if (plan.kind === 'decline') return decline(plan.why)
    if (plan.kind === 'here') return gotoHere(plan.call, from)
    const { project: target, call: rest } = plan
    return new Promise<GotoAnswer>((resolve) => {
      jumping.current?.resolve(decline(NAVIGATE_SAYS.notArrived(target.name)))
      const timer = window.setTimeout(() => {
        if (jumping.current?.timer !== timer) return
        jumping.current = null
        resolve({ outcome: 'declined', epic: null, why: NAVIGATE_SAYS.notArrived(target.name) })
      }, ARRIVAL_WAIT_MS)
      jumping.current = { project: target.id, call: rest, from, cleared: false, timer, resolve }
      onProject(target.id)
    })
  }

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
   * A fold or an unfold glides, whoever asked for it — the person's press, an
   * agent at the door, a module's `view.fold` — so it is noticed here, where
   * all three arrive, rather than at each press. Worked out during the render
   * (React's own pattern for state derived from a change) because the glide
   * must be switched on in the SAME commit as the new heights: a transition
   * turned on a commit later starts after the change it was meant to animate.
   * Only the open kehikko's own folds: a switch changes them all, and is not
   * a fold.
   */
  const [foldsSeen, setFoldsSeen] = useState<{ open: number | null; placements: readonly Placement[] }>({ open: openId, placements })
  if (foldsSeen.open !== openId || foldsSeen.placements !== placements) {
    setFoldsSeen({ open: openId, placements })
    if (foldsSeen.open === openId && foldsOnlyChanged(foldsSeen.placements, placements)) setGliding((n) => n + 1)
  }

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
   *
   * And the arrangement is the one the grid will SETTLE on — every height
   * its stored wish is granted, at the top edge compaction gives it
   * (`arranged` in `columns.ts`) — so a kehikko is drawn where it ends up, on its first frame.
   */
  const laid = useMemo(
    () =>
      settledOn(containers).map(
        (one) =>
          ({
            ...one,
            /* A bottom edge travels as far as the column below can pay; a top
               edge as far as the containers on top can spare. */
            maxH: pulling === one.i ? Math.min(CANVAS_ROWS, one.h + mostUp(containers, one.i)) : mostFor(containers, one.i),
          }) as Layout,
      ),
    [containers, pulling],
  )
  const placed = placements.map((p) => p.i)

  /*
   * Where a new container landed. One that appears on the kehikko already open
   * (the add button, an agent's `place_modules`, anything else that adds one)
   * is ringed for about a second and scrolled into view if it is off screen —
   * `showLanded`. A kehikko opening or being filled for the first time is not
   * an arrival: the ids are compared only within the same kehikko, and an
   * empty one filled with several at once is skipped.
   */
  const arrivals = useRef<{ canvas: number | null; ids: Set<string> } | null>(null)
  useEffect(() => {
    const ids = new Set(placements.map((p) => p.i))
    const was = arrivals.current
    arrivals.current = { canvas: openId, ids }
    if (!was || was.canvas !== openId) return
    const added = [...ids].filter((one) => !was.ids.has(one))
    if (added.length === 0 || (was.ids.size === 0 && added.length > 1)) return
    showLanded(added)
  }, [placements, openId])

  /*
   * What the modules say they are doing (`activity.set`) and the lines they
   * emit (`kehikot.notifications@1`): ONE record, the Inbox, kept by the server
   * per project (`server/inbox.ts`) and drawn as small dots on what already
   * exists plus the one control in the bar. See `host/inbox.ts`. What a module
   * had open is closed when its container is on no kehikko of the project or
   * its server stops answering, and stays in the log.
   */
  const activityAlive = useMemo(() => {
    if (!registry) return null
    const on = new Set(here.flatMap((one) => one.placements.map((p) => p.i)))
    return new Set(registry.presences.filter((p) => p.condition === 'ready' && on.has(p.id)).map((p) => p.id))
  }, [registry, here])
  const activityAt = useMemo(
    () => ({ epic: about.epic, parts: about.parts, kehikko: open?.key ?? null }),
    [about.epic, about.parts, open?.key],
  )
  const moduleName = useCallback(
    (module: string) => registry?.presences.find((p) => p.id === module)?.name ?? module,
    [registry],
  )
  /* An entry that entered attention or done is delivered, as a line, to whoever
     consumes `kehikot.notifications@1` — a Notifications module on a canvas —
     as if the module had sent it. The record already holds it; this only
     forwards. See `noticeFor`. */
  const noticeRef = useRef<(entry: Entry, project: number) => void>(() => undefined)
  const inboxProjects = useMemo(() => projects.map(({ id, name, path, uid }) => ({ id, name, path, uid: uid ?? null })), [projects])
  const chime = useChime()
  const toasts = useToasts(chime.plays)
  /* The toast's words for an item; the names are resolved when it is shown, not kept. */
  const toastRef = useRef<(entry: Entry, project: number) => void>(() => undefined)
  /* A module's page answered a greeting: it is a new page, whose list the Inbox waits for. */
  const inboxGreetedRef = useRef<(module: string) => void>(() => undefined)
  /* "Restart module" on a Run menu: one word per module while it is out, and a look when it is in. */
  const restarts = useRestarts(useCallback(() => void look(true), [look]))
  const inbox = useInbox({
    project: projectId,
    projects: inboxProjects,
    alive: activityAlive,
    at: activityAt,
    nameOf: moduleName,
    notify: (entry, project) => {
      noticeRef.current(entry, project)
      /* The same news, as a sound: `useInbox` has already left out what is on screen. */
      const kind = kindOf(entry)
      if (kind) chime.offer(kind, entry.module, entry.named?.id)
      /* And as a toast: the same news, so the same decision. */
      toastRef.current(entry, project)
    },
  })
  activityRef.current = inbox.receive
  inboxGreetedRef.current = inbox.greeted
  inboxWokeRef.current = (id, rev) => inbox.refresh(id < 0 ? undefined : id, rev)
  legacyNoticeRef.current = (from, payload) => {
    const parsed = schemaFor('kehikot.notifications@1')?.safeParse(payload)
    if (!parsed?.success) return
    const line = parsed.data as NoticeLine
    const where = {
      epic: line.place?.epic ?? line.epic,
      ...(line.place?.parts?.length ? { parts: [...line.place.parts] } : {}),
      kehikko: line.place?.kehikko ?? kehikkoRef.current?.key,
    }
    /* A line about a place that is open on screen is not chimed for, like an item. */
    if (!placeOpened(where as Place, activityAt)) {
      chime.offer(line.level === 'attention' ? 'attention' : 'notice', from)
      if (projectRef.current !== null) {
        const { entry } = noticeEntry(from, moduleName(from), line, `toast-${Date.now()}`, Date.now(), kehikkoRef.current?.key)
        toastRef.current(entry, projectRef.current)
      }
    }
    inbox.notice(from, line, kehikkoRef.current?.key)
  }
  const activityNames = useMemo<Namer>(
    () => ({
      epic: (slug) => {
        const row = held?.epics.find((one) => one.slug === slug)
        return row ? (row.title ?? row.slug) : null
      },
      part: (epic, id) => {
        const rows = epic === null ? [] : (held?.epics.find((one) => one.slug === epic)?.parts ?? [])
        return rows.find((part) => part.id === id)?.heading ?? null
      },
      kehikko: (key) => here.find((one) => one.key === key)?.name ?? null,
    }),
    [held, here],
  )
  toastRef.current = (entry, project) => {
    const elsewhere = project !== projectRef.current ? (projects.find((one) => one.id === project)?.name ?? 'another project') : null
    toasts.offer({
      entry,
      project,
      by: moduleName(entry.module),
      place: placeWords(entry, activityNames, elsewhere),
    })
  }
  noticeRef.current = (entry, project) => {
    /* Another project's: its names are not this page's to read, so the line says the project instead. */
    const elsewhere = project !== projectRef.current ? (projects.find((one) => one.id === project)?.name ?? 'another project') : null
    const line = elsewhere
      ? noticeFor(entry, { epic: entry.place?.epic ?? null, parts: [], kehikko: null }, OTHER_NAMES)
      : noticeFor(entry, activityAt, activityNames)
    if (!line) return
    if (elsewhere) line.message = `${elsewhere}: ${line.message}`
    const out = bus.emit(entry.module, 'kehikot.notifications@1', line, kehikkoRef.current)
    if (!out.ok) console.info('The host did not carry a notice derived from activity.', out.error)
  }
  const activityMarks = useMemo(() => {
    const live = inbox.live
    const moduleOf = new Map<string, ActivityState>()
    for (const module of new Set(live.map((one) => one.module))) {
      const mark = moduleMark(live, module)
      if (mark) moduleOf.set(module, mark)
    }
    const counts = new Map<string, number>()
    for (const one of live) {
      const key = one.place?.kehikko
      if (one.state === 'attention' && key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return {
      modules: moduleOf,
      epics: epicMarks(live, about.epic, (slug) => (held?.epics.find((one) => one.slug === slug)?.parts ?? []).map((p) => p.id)),
      parts: partMarks(live, about.epic),
      kehikot: kehikkoMarks(live),
      counts,
      worst: worstActivity(live.map((one) => one.state)),
    }
  }, [inbox.live, about.epic, held])
  /* Light a module's container on the open kehikko: after a move, once the screen has caught up. */
  const flashContainer = useCallback((module: string, later: boolean) => {
    const flash = () => {
      const element = [...document.querySelectorAll<HTMLElement>('[data-module]')].find(
        (one) => one.dataset.module === module,
      )
      if (!element) return
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      element.setAttribute('data-activity-flash', '')
      window.setTimeout(() => element.removeAttribute('data-activity-flash'), 1600)
    }
    /* Once the kehikko it is on is shown: lit while it is still being
       prepared out of sight, the light would be spent before anybody saw it. */
    const whenShown = () => whenShownRef.current(flash)
    if (later) window.setTimeout(whenShown, 300)
    else whenShown()
  }, [])
  /* Whether the Inbox's panel is open, held here so that the keyboard can open it. */
  const [inboxOpen, setInboxOpen] = useState(false)
  /*
   * An item of another project: that project is opened, and once its epics
   * have been read again — `held` goes to null on the switch and back — the
   * item is gone to as any other. Never on the epics of the project left.
   */
  const goElsewhere = useRef<{ project: number; entry: Entry; cleared: boolean } | null>(null)
  /*
   * Pressing an item goes to where it happened (`host/goToPlace.ts`): its
   * project, its kehikko by key, its epic and parts, and then its module's
   * container is lit THERE — with the pickers' own functions. Where that stops
   * short, or the item named no place, a line says so (`WentTo`).
   */
  const placeGo = useGoToPlace({
    here: { project: projectId, epic: about.epic, parts: about.parts, kehikko: open?.key ?? null },
    targetOf: (project) => ({
      project,
      kehikot: inProject(canvases, project).flatMap((one) =>
        one.key === undefined ? [] : [{ key: one.key, name: one.name, modules: one.placements.map((p) => p.i) }],
      ),
      epics: project === projectId && held ? held.epics.map((one) => one.slug) : null,
    }),
    switchProject: (project, entry) => {
      goElsewhere.current = { project, entry, cleared: false }
      onProject(project)
    },
    openKehikko: (key) => {
      const target = here.find((one) => one.key === key)
      if (target) setOpenId(target.id)
    },
    goto: (call) => gotoHereRef.current(call),
    highlight: flashContainer,
  })
  const goToEntry = useCallback(
    (entry: Entry, project: number | null = projectId) => {
      if (project === null) return
      if (entry.state === 'done') inbox.see([entry], project)
      setInboxOpen(false)
      /* The agent sync's lines have no place on a canvas: they are about Settings. */
      if (entry.module === SETTINGS_INBOX_MODULE) {
        openSettings()
        return
      }
      placeGo.go(entry, project)
    },
    [inbox, projectId, placeGo.go],
  )
  const goToElsewhere = useCallback((project: number, entry: Entry) => goToEntry(entry, project), [goToEntry])
  useEffect(() => {
    const pending = goElsewhere.current
    if (!pending || pending.project !== projectId) return
    if (held === null) {
      pending.cleared = true
      return
    }
    if (!pending.cleared) return
    goElsewhere.current = null
    placeGo.go(pending.entry, pending.project)
  }, [projectId, held, placeGo.go])
  /* A module's `view.goto` into another project, gone to once that project's
     epics are read there — `goElsewhere`'s rule. */
  useEffect(() => {
    const pending = jumping.current
    if (!pending || pending.project !== projectId) return
    if (held === null) {
      pending.cleared = true
      return
    }
    if (!pending.cleared) return
    jumping.current = null
    window.clearTimeout(pending.timer)
    pending.resolve(gotoHereRef.current(pending.call, pending.from))
  }, [projectId, held])
  /* Which scope the Inbox shows. The default is everywhere: what is going on in
     other kehikot, parts and epics is the point, one press from "This kehikko".
     Only a person who narrowed it is remembered, per project, in this browser. */
  const [inboxScopes, setInboxScopes] = useState<Record<number, Scope>>({})
  const inboxScope: Scope = useMemo(() => {
    if (projectId === null) return 'everywhere'
    const chosen = inboxScopes[projectId]
    if (chosen) return chosen
    try {
      return scopeFrom(window.localStorage.getItem(`kehikot.inbox.scope.${projectId}`))
    } catch {
      return 'everywhere'
    }
  }, [inboxScopes, projectId])
  const setInboxScope = useCallback(
    (scope: Scope) => {
      if (projectId === null) return
      setInboxScopes((was) => ({ ...was, [projectId]: scope }))
      try {
        window.localStorage.setItem(`kehikot.inbox.scope.${projectId}`, scope)
      } catch {
        /* Back to everywhere on the next load; nothing else is lost. */
      }
    },
    [projectId],
  )
  /* "Next that needs me": the most pressing open item and, pressed again, the
     next, across kehikot, epics and parts. See `nextOf`. */
  const [lastNext, setLastNext] = useState<string | null>(null)
  const nextEntry = useMemo(() => nextOf(inbox.open, lastNext), [inbox.open, lastNext])
  const goNextRef = useRef<() => void>(() => undefined)
  goNextRef.current = () => {
    if (!nextEntry) {
      /* Nothing asks for the person: say what is going on instead. */
      setInboxOpen(true)
      return
    }
    setLastNext(rowKey(nextEntry))
    goToEntry(nextEntry)
  }
  /* Alt+Shift+N. By `code`, so the Option key's dead keys on a Mac do not
     matter; not in a text field. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || event.code !== 'KeyN') return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      event.preventDefault()
      goNextRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const barActivity = useMemo<BarActivity | null>(() => {
    if (inbox.open.length === 0 && inbox.earlier === 0 && inbox.others.length === 0 && !inboxOpen) return null
    const narrowing = { scope: inboxScope, epic: about.epic, kehikko: open?.key ?? null }
    return {
      epics: activityMarks.epics,
      parts: activityMarks.parts,
      kehikot: activityMarks.kehikot,
      kehikotCounts: activityMarks.counts,
      /* Another project needing the person lights the control too: switching project silences nothing. */
      worst: worstActivity([...(activityMarks.worst ? [activityMarks.worst] : []), ...inbox.others.flatMap((one) => one.entries.map((entry) => entry.state))]),
      inbox: {
        entries: inbox.open,
        elsewhere: inbox.others,
        onGoElsewhere: goToElsewhere,
        onDismissElsewhere: (project, entries) => inbox.dismiss(entries, project),
        earlierCount: inbox.earlier,
        at: { epic: about.epic, kehikko: open?.key ?? null },
        scope: inboxScope,
        onScope: setInboxScope,
        names: activityNames,
        tally: tally(inbox.open, { epic: about.epic, kehikko: open?.key ?? null }),
        next: nextEntry,
        open: inboxOpen,
        onOpenChange: setInboxOpen,
        onGo: (entry) => goToEntry(entry),
        onNext: () => goNextRef.current(),
        onSee: inbox.see,
        onDismiss: inbox.dismiss,
        onForget: (keys) => inbox.act('forget', keys ?? undefined, narrowing),
        onSeeAll: () => inbox.act('seen-all', undefined, narrowing),
        loadLog: (offset, limit) =>
          projectId === null ? Promise.resolve(null) : fetchLog(projectId, narrowing, offset, limit),
        rev: inbox.rev,
        shortcut: 'Alt+Shift+N',
        now: () => Date.now(),
        /* The host's ask "which epic is this conversation for?": the person answers with one press. */
        choicesFor: (entry) =>
          isPlaceAsk(entry) && projectId !== null
            ? askChoices(about.epic, held?.epics ?? []).map((choice) => ({
                label: choice.label,
                run: () => void answerAsk({ project: projectId, session: entry.id, epic: choice.epic, kehikko: open?.id ?? null }),
              }))
            : null,
      },
    }
  }, [
    inbox,
    inboxOpen,
    inboxScope,
    setInboxScope,
    activityMarks,
    activityNames,
    nextEntry,
    goToEntry,
    goToElsewhere,
    about.epic,
    open?.key,
    open?.id,
    held,
    projectId,
  ])

  /**
   * What the modules on the open kehikko have declared, said to the server.
   *
   * So that `read_canvas` can list a container's header items and
   * `press_item` can refuse before anything is pressed. Only the open
   * kehikko's containers: a page loaded for the kehikko next door is declared
   * too, and is not what anybody is looking at. Posted whole whenever it
   * changes, and again when the stream reopens — a server that restarted
   * has forgotten it.
   */
  const declaredHere = useMemo(() => {
    if (!open) return null
    const on: [string, Headers[string]][] = []
    for (const placement of open.placements) {
      const items = headers[placement.i]
      if (items) on.push([placement.i, items])
    }
    return JSON.stringify(on)
  }, [open, headers])
  /* What this page last posted: a posting that says what the server already holds is not made
     (`headerPosting`), unless the stream reopened and the server may have forgotten it. */
  const postedRef = useRef(NOTHING_POSTED)
  const postDeclared = useCallback((again = false) => {
    if (openId === null || declaredHere === null) return
    const said = headerPosting(openId, declaredHere, codeAt, addressAt)
    if (!again && said === postedRef.current) return
    postedRef.current = said
    void postHeaders(
      openId,
      Object.fromEntries(JSON.parse(declaredHere) as [string, Headers[string]][]),
      codeAt ? (JSON.parse(codeAt) as SharedLocation) : null,
      addressAt ? (JSON.parse(addressAt) as SharedAddress) : null,
    )
  }, [openId, declaredHere, codeAt, addressAt])
  /* A moment after the last change: the modules of a kehikko greet one after another, and each
     greeting is a change, but one posting of the whole map says all of them. */
  useEffect(() => {
    const later = setTimeout(() => postDeclared(), HEADERS_SETTLE_MS)
    return () => clearTimeout(later)
  }, [postDeclared])
  repostRef.current = () => postDeclared(true)

  /**
   * Every module page that currently has a document, and where each one goes.
   *
   * A page is loaded when its module first appears on the open canvas, and is
   * kept while the module is on the open kehikko or on one of the last
   * `KEPT_KEHIKOT` left — which is what makes switching back free. It is
   * dropped when none of those has it any more (the oldest kehikko left falls
   * off the list), when the last canvas holding it lets go, or when its
   * registration disappears.
   *
   * Held in a ref rather than in state because it is a record of what has been
   * loaded, not a description of what should be on screen. Deriving it every
   * render from the canvases would forget, every render, which is the one thing
   * it exists to do.
   */
  const loadedRef = useRef<Set<string>>(new Set())
  /** The open kehikko and the ones left before it, most recent first. See `recentlyOpen`. */
  const recentRef = useRef<number[]>([])
  /**
   * Which version each loaded page is of: the open kehikko's pin when the
   * module is on it, else whatever it was last loaded as. One page per module,
   * still — a module is on a kehikko at most once, so two versions of it are
   * never on screen together, and switching to a kehikko pinned differently
   * reloads that one page at the other version's address. See `Frames.tsx`.
   */
  const loadedVersionRef = useRef<Map<string, string | null>>(new Map())

  /*
   * A page older than its server: the page said which process served it, and
   * the module's server now states another, later one — it was restarted under
   * a frame that stayed mounted, by somebody other than this host (`Runs` sees
   * the host's own restarts). The page's writes would all be refused. It gets
   * a new document, once per server process, and is covered as restarting
   * until that answers. See `isStale` and `Replacing` in `host/standing.ts`.
   *
   * Only for a container on the module's own checkout: one pinned to a version
   * is framed from another process, which `live` does not tell apart.
   */
  const replacing = useRef(new Replacing())
  const lookedFor = useRef(new Map<string, string>())
  const pinnedHere = useMemo(() => new Set(placements.filter((p) => p.version).map((p) => p.i)), [placements])
  const staleOf = useCallback(
    (id: string, found: Live | undefined): boolean =>
      !pinnedHere.has(id) && found?.condition === 'ready' && replacing.current.stale(id, found.build, byId.get(id)?.module?.build),
    [pinnedHere, byId],
  )
  useEffect(() => {
    const again: string[] = []
    let behind = false
    for (const [id, found] of Object.entries(live)) {
      if (pinnedHere.has(id) || found.condition !== 'ready') continue
      const server = byId.get(id)?.module?.build
      if (replacing.current.take(id, found.build, server)) again.push(id)
      /* The page is AHEAD of what the last sweep read: it reloaded itself onto
         a restarted server before this page heard of it. Look, once per page. */
      else if (registryBehind(found.build, server) && lookedFor.current.get(id) !== found.build!.started) {
        lookedFor.current.set(id, found.build!.started)
        behind = true
      }
    }
    if (again.length) {
      setGenerations((was) => {
        const next = { ...was }
        for (const id of again) next[id] = (next[id] ?? 0) + 1
        return next
      })
    }
    if (behind) void lookRef.current?.()
  }, [live, byId, pinnedHere])

  const framings = useMemo<Framing[]>(() => {
    const loaded = loadedRef.current
    const loadedVersion = loadedVersionRef.current
    const anywhere = new Set(everyPlaced(canvases))
    /* The open kehikko and the last few left: a page on none of them is let
       go (`framesKept`, `Frames.tsx`). */
    recentRef.current = recentlyOpen(recentRef.current, open?.id ?? null)
    const kept = framesKept(canvases, recentRef.current)
    for (const id of [...loaded]) {
      if (!anywhere.has(id) || !byId.has(id) || !kept.has(id)) loaded.delete(id)
    }
    const onOpen = new Set<string>()
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
      .map((id) => {
        const module = presenceOf(id)?.module
        if (!module) return null
        const found = live[id]
        return {
          module,
          /* Only for the module's own checkout: a container pinned to a
             version is served by another process, which an update of the
             checkout does not touch. */
          generation: loadedVersion.get(id) ? 0 : (generations[id] ?? 0),
          rect: rects[id] ?? null,
          away: !onOpen.has(id),
          /* A folded container's page is HIDDEN, by the same path a page on another
             kehikko is hidden — kept at its size, kept running, and not shown.
             `Frames.tsx` has the argument: unmounting it would destroy the
             document, and there is no getting one of those back. Folding a container
             with a shell in it must not kill the shell. */
          shown:
            onOpen.has(id) &&
            !placements.find((p) => p.i === id)?.collapsed &&
            /* The same decision the container's body draws from, so a page
               and a cover are never both up, or neither. */
            showing(presenceOf(id)!, found && { ...found, stale: staleOf(id, found) }, askedFor === openId, restarts.of(id)).kind === 'page' &&
            /* "All epics", and a module that works on one epic at a time: its
               container draws the sentence and the page is hidden under it —
               kept, as a folded page is, so it is all still there when an epic
               is picked again. See `host/scope.ts`. */
            !coveredForScope(about.scope, module, placements.find((p) => p.i === id)?.pinned ?? false, placements.find((p) => p.i === id)?.scope ?? null),
          state: byId.get(id)?.state ?? null,
          /* The container's scope (protocol 2.29.0): the person's pick among its
             module's, or its default, and `project` on "All epics" for one at
             Epic or Part. A pinned container is not moved by "All epics". */
          scope: scopeToTell(
            scopeOfContainer(module, placements.find((p) => p.i === id)?.scope ?? null).active,
            about.scope === 'project',
            placements.find((p) => p.i === id)?.pinned ?? false,
          ),
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
             is told what is stored, unreconciled, so it does not draw
             unnarrowed for the round trip until its offer arrives; it falls
             back on an id it does not know. See `host/filters.ts`. */
          filters: found?.filters
            ? chosen(found.filters, placements.find((p) => p.i === id)?.filters ?? {})
            : remembered(placements.find((p) => p.i === id)?.filters ?? {}),
        }
      })
      .filter((framing): framing is Framing => framing !== null)
  }, [byId, canvases, live, placements, rects, open, pinViews, readyVersions, askedFor, openId, generations, staleOf, about.scope])

  /*
   * A switch of kehikko or project, without the fidget: the kehikko being left
   * stays on screen, still, while the next is drawn out of sight at its final
   * size, and the two cross once it has settled. See `host/switching.ts` for
   * what moved before, and `canvas/useCalmSwitch.ts` for how. Ready once the
   * canvas has a width — before that there is nothing to draw a grid in.
   */
  const calm = useCalmSwitch({ ready: width !== null, framings })
  leavingRef.current = calm.leaving
  whenShownRef.current = calm.whenShown
  /* While a switch holds them, the pages that were seen stay where they were
     seen and the rest wait, hidden, at their new places. */
  const drawnFramings = useMemo(() => heldPages(framings, calm.seen), [framings, calm.seen])
  /* And what the pages being left are told, held with them: while they are on
     screen fading out, they go on showing what they showed. An epic switch is
     the case that needs it — the same pages, told a new epic, would redraw
     themselves in the middle of their own fade — and the new context is
     theirs the moment they are released, as they fade in. */
  const heldContext = useRef(context)
  if (!calm.pagesStill) heldContext.current = context
  const heldContexts = useRef(contextsFor)
  if (!calm.pagesStill) heldContexts.current = contextsFor

  /* Measure before the browser paints, not after. A canvas switch replaces
     every container in one commit, and a page positioned over where the last
     canvas's container used to be — even for a single frame — is a visible jump. */
  useLayoutEffect(() => {
    measure()
    /* And again for a moment afterwards. Adding a container, removing one, or
       switching canvases all reflow the grid, and the grid reflows by
       animating — so the position that is correct now is not the one that will
       be correct in a fifth of a second. */
    settle()
  }, [measure, settle, openId, placements, containers.length])

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
        return
      }
      covers[event](id)
      if (event === 'unmounted') {
        setSaid((was) => forgotten(was, id))
        setHeaders((was) => withdrawn(was, id))
      }
    },
    [covers],
  )

  const watcherFor = useCallback(
    (id: string): ConversationWatcher => ({
      ready: (_protocol, build) => {
        covers.answered(id)
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
      silent: (sentence) => {
        /* Its menus go with its offers: see `host/header.ts`. */
        setHeaders((was) => withdrawn(was, id))
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
    }),
    [covers, onHeight, onOffer, onClearable, onRefreshable],
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
        held={held !== null && heldProject === projectId ? held : null}
        heldBefore={projectId === null ? null : (heldBefore.current.get(projectId) ?? null)}
        onRetitleEpic={onRetitleEpic}
        onCreateEpic={onCreateEpic}
        onDeleteEpic={(slug) => void onDeleteEpic(slug)}
        onProject={onProject}
        onAddProject={(path) => void onAddProject(path)}
        onShareProject={(id, shared) => void onShareProject(id, shared)}
        onForgetProject={(id) => void onForgetProject(id)}
        onLocateProject={setLocating}
        storageViews={storageViews}
        onOpen={setOpenId}
        onRename={onRename}
        onCreate={() => openLayouts('new')}
        onDelete={(id) => void onDelete(id)}
        onSubject={setSubject}
        parts={epicParts}
        pickedParts={about.parts}
        /* Written at once, like the epic: `changeSubject` puts it on screen
           and on the server, and `setSubject` there is what clears it when
           the epic moves. */
        onParts={(ids) => changeSubject({ parts: ids })}
        /* Only once the project's epics have been READ and the open epic is
           among them: `epicParts` is empty while that list is on its way, and
           "no parts" said then would be said, for half a second, about every
           epic that has some. */
        onEditParts={about.epic !== null && held?.epics.some((one) => one.slug === about.epic) ? onEditParts : null}
        onPlace={onPlace}
        onUnplace={onUnplace}
        focus={focus}
        onFocus={onFocus}
        theme={theme}
        onTheme={onTheme}
        trouble={trouble}
        onLookAgain={() => void look(true)}
        looking={looking}
        tracker={projectId === null ? null : tracker}
        onRefreshTrackers={onRefreshTrackers}
        activity={barActivity}
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
       * `flex-1` takes whatever the strip above has not taken, and
       * `overflow-auto` is what happens when the arrangement wants more than
       * that: the CANVAS scrolls, and the window does not. Those are two
       * different behaviours and only one of them is acceptable — a document
       * that scrolls carries the strip, and the error line in it, off the
       * screen, which is the one thing an always-visible strip must not do.
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
        {/* A project whose folder is gone opens on the sentence, not on a canvas
            whose modules would be pointed at a path that is not there. */}
        {project?.missing ? (
          <MissingProject project={project} onLocate={() => setLocating(project.id)} />
        ) : (
          <>
        {/* Not over the still copy of a kehikko being left: an empty kehikko
            says so once it is the one shown. */}
        {containers.length === 0 && !calm.holding ? (
          <Nothing registry={registry} looking={looking} empty={open !== null && open.placements.length === 0} />
        ) : null}

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
        {/*
         * The kehikko arriving. Above the pages, so the container's own chrome
         * — its header, its edge, and the resize handle in its corner — is never
         * underneath one; the stacking is this element's, because while it
         * fades its opacity makes it a stacking context of its own and the
         * order has to hold through that.
         *
         * While a switch prepares it, it is drawn at its final size, invisible
         * and `inert`: no click, no Tab, no screen reader reaches a kehikko
         * that is not shown yet. See `canvas/useCalmSwitch.ts`.
         *
         * `pointer-events-none`, and that is the line this element cannot do
         * without. It is as big as the canvas and stacked above the pages, so
         * without it every click and wheel meant for a module's page landed on
         * this div instead, and with no click there is no focus to type into:
         * 0.1.54 and 0.1.55 shipped that, in every browser, and no module page
         * took input. The rule in
         * `index.css` that makes the grid transparent to the pointer covers
         * the grid and its items, not a wrapper put around them — any layer
         * added over the pages needs the same, and `dev/pages-take-input.drive.mjs`
         * (run by `bun test`) is what proves it with a real pointer.
         */}
        <div
          ref={calm.incomingRef}
          data-switch={calm.phase}
          inert={!calm.interactive}
          className="pointer-events-none relative z-[1] h-full"
          style={layerStyle(calm.incoming)}
        >
        {width === null ? null : (
        <Grid
          style={{ position: 'relative' }}
          /* Keyed by the canvas, so switching them is a new grid rather than
             the same grid being told every container moved at once. */
          key={openId ?? 'none'}
          /* Told, not measured: see `Grid` above. */
          width={width}
          /* Animated only for a person's own drag or resize, and a fold. */
          className={moving !== null || gliding ? 'min-h-full in-motion' : 'min-h-full'}
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
           * with this it is what makes a row's height `room / 56` regardless of
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
            /* The container let go of glides to where the grid puts it. */
            setGliding((n) => n + 1)
            settle()
          }}
          onResizeStart={(_all, _old, item, _placeholder, event) => {
            resized.current = item.i
            traded.current = new Map()
            setMoving(item.i)
            setPulling(cornerOf(event?.target)?.startsWith('n') ? item.i : null)
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
            if (before && pulling === item.i) {
              /* A top corner: the bottom edge stays where it is and the
                 container trades rows with what is on top of it. The grid
                 swapped places with whatever the top edge ran into; this puts
                 them back and gives each the rows it now has. */
              const pulled = topEdge(stored, item.i, item.h)
              traded.current = pulled.given
              for (const one of layout) {
                if (one.i === item.i) {
                  one.h = pulled.h
                  one.y = pulled.y
                  continue
                }
                const height = pulled.given.get(one.i)
                const was = stored.find((p) => p.i === one.i)
                if (height !== undefined && was) {
                  one.h = height
                  one.y = was.y
                }
              }
              remeasure()
              return
            }
            const heights = before ? wishing(stored, item.i, dragged(before, item.h)) : granted(stored)
            for (const one of layout) {
              const height = heights.get(one.i)
              if (height !== undefined) one.h = height
            }
            remeasure()
          }}
          onResizeStop={() => {
            setPulling(null)
            setMoving(null)
            setGliding((n) => n + 1)
            settle()
          }}
          /* A container cannot be dropped into another container's space; the grid pushes
             instead. Free placement would let one module hide another, and a
             module a person cannot find is worse than one they have to arrange
             around. */
          compactType="vertical"
          resizeHandles={['se', 'sw', 'ne', 'nw']}
          resizeHandle={cornerHandle}
        >
          {containers.map((placement) => {
            /* A pinned container shows its version's presence, or the pin's
               sentence while the version is on its way — never the latest
               copy's page. See `pinnedPresence`. */
            const { presence, waiting } = pinnedPresence(
              byId.get(placement.i),
              placement.version ?? null,
              open ? pinViews.get(`${open.id}|${placement.i}`) : undefined,
            )
            if (!presence) {
              return (
                <div key={placement.i}>
                  <Missing id={placement.i} onRemove={() => onUnplace(placement.i)} />
                </div>
              )
            }
            const found = waiting ? undefined : live[presence.id]
            return (
              <div key={placement.i}>
                <Container
                  presence={presence}
                  /* The page, the cover, or a notice. Nothing found yet is a
                     module that has been framed and has not spoken, which
                     `condition` alone cannot express: discovery said `ready`
                     because the manifest read, not because the page answered. */
                  showing={showing(presence, found && { ...found, stale: staleOf(presence.id, found) }, askedFor === openId, restarts.of(presence.id))}
                  restart={restarts.of(presence.id)}
                  onRestart={() => restarts.restart(presence.id)}
                  coverDetail={waiting ? presence.line : undefined}
                  fault={found?.fault ?? null}
                  body={body(presence.id)}
                  grow={placement.grow}
                  onGrow={(grow) => onGrow(presence.id, grow)}
                  pinned={placement.pinned}
                  onPin={(pinned) => onPin(presence.id, pinned)}
                  collapsed={placement.collapsed}
                  onCollapse={(collapsed) => onCollapse(presence.id, collapsed)}
                  foldedBy={signedBy(signed && signed.kehikko === openId ? signed.marks : null, placement)}
                  header={headers[presence.id] ?? NO_HEADER}
                  /* A press on whichever frame is standing, judged against
                     what is declared now — see `onPressItem`. */
                  onPress={(press) => onPressItem(presence.id, press)}
                  /* And the keyboard to that frame after a press that closed
                     its menu — see `focusAfter` in `host/header.ts`. */
                  onKeyboard={() => presses.focus(presence.id)}
                  /* Full screen for a run that asks for it, on THIS frame; an
                     agent's `press_item` never comes this way. */
                  surface={{
                    enter: () => presses.fullscreen(presence.id),
                    leave: () => presses.leaveFullscreen(presence.id),
                  }}
                  pressNote={pressNotes[presence.id] ?? null}
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
                  onSkills={() => setSkillsFor(presence.id)}
                  onSettings={() => setSettingsFor(presence.id)}
                  scope={presence.module ? scopeOfContainer(presence.module, placement.scope) : null}
                  onStarted={() => void look(true)}
                  onRemove={() => onUnplace(presence.id)}
                  kehikko={open?.name ?? null}
                  epic={about.epic}
                  oneEpic={!waiting && coveredForScope(about.scope, presence.module, placement.pinned, placement.scope)}
                  canvas={open?.id ?? null}
                  version={placement.version ?? null}
                  current={waiting ? null : (presence.module?.version ?? null)}
                  /* The server has written the pin and woken this page for the
                     kehikko; looking again picks up what the version is doing. */
                  onVersion={() => void look(true)}
                  activity={activityMarks.modules.get(presence.id) ?? null}
                  onActivitySeen={() =>
                    inbox.see(inbox.open.filter((one) => one.module === presence.id && one.state === 'done'))
                  }
                />
              </div>
            )
          })}
        </Grid>
        )}
        </div>

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

        {calm.left ? (
          <Underlay
            from={[...calm.left.values()]}
            to={framings.flatMap((one) => (one.shown && one.rect ? [one.rect] : []))}
            look={calm.underlay}
          />
        ) : null}
        <Frames
          framings={drawnFramings}
          context={calm.pagesStill ? heldContext.current : context}
          contextsFor={calm.pagesStill ? heldContexts.current : contextsFor}
          canvas={controls}
          bus={bus}
          presses={presses}
          watcherFor={watcherFor}
          onDocument={onDocument}
          moving={moving}
          still={calm.pagesStill}
          layer={layerStyle(calm.pages)}
        />
          </>
        )}
        {/* The still copy of the kehikko being left, while the next is
            prepared and as it fades. Filled and emptied by `useCalmSwitch`,
            never by React. */}
        <div ref={calm.outgoingRef} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-[1]" style={layerStyle(calm.outgoing)} />
        {calm.slow ? <Arranging /> : null}
      </main>

      {/* A brief glimpse of what just arrived in the Inbox; the Inbox keeps it all. */}
      <InboxToasts
        toasts={toasts.toasts}
        onClose={toasts.close}
        onOpen={(toast) => {
          toasts.close(toast.id)
          goToEntry(toast.entry, toast.project)
        }}
      />

      {/* A module asked to show a page and nothing here shows pages: the person
          chooses. Nothing is opened before a press. See `AddressOffer.tsx`. */}
      <AddressOffer
        offer={offer !== null && offer.kehikko === openId ? offer : null}
        askerName={registry?.presences.find((one) => one.id === offer?.by)?.name ?? offer?.by ?? ''}
        addable={(registry?.presences ?? [])
          .filter((one) => reactsOf(one.id)?.includes(SHOWS_PAGES) && !(open?.placements ?? []).some((p) => p.i === one.id))
          .map((one) => ({ id: one.id, name: one.name ?? one.id }))}
        onOpenOutside={(given) => {
          openExternal(given.url)
          setOffer(null)
        }}
        onAdd={(given, module) => {
          onPlace(module)
          const next = accepted(addressesRef.current, given, new Date().toISOString())
          addressesRef.current = next
          setAddresses(next)
          setOffer(null)
        }}
        onDismiss={() => setOffer(null)}
      />

      {/* "Locate…", for a project whose folder is gone. See `Locate.tsx`. */}
      <Locate
        project={projects.find((one) => one.id === locating) ?? null}
        onOpenChange={(open) => {
          if (!open) setLocating(null)
        }}
        onLocated={(found) => void onLocated(found)}
      />

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

      {/* A project whose folder was renamed or moved, followed there by the
          host itself; said once. See `Followed.tsx`. */}
      <Followed projects={projects} />
      <WentTo note={placeGo.note} onClose={placeGo.clearNote} />

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
          onChanged={() => void look(true)}
        />
      ) : null}

      {/* A module's Claude Code skills, read and installed on the person's press. Asked when it opens. */}
      {skillsFor ? (
        <SkillsDialog
          open
          onOpenChange={(isOpen) => setSkillsFor(isOpen ? skillsFor : null)}
          module={skillsFor}
          name={byId.get(skillsFor)?.name ?? skillsFor}
        />
      ) : null}

      {/* A module's settings window: what it declared, saved by the module (protocol 2.15.0), and its
          Providers & Consumers on the open kehikko (`host/connections.ts`). */}
      {settingsFor ? (
        <ModuleSettingsDialog
          open
          onOpenChange={(isOpen) => setSettingsFor(isOpen ? settingsFor : null)}
          module={settingsFor}
          name={byId.get(settingsFor)?.name ?? settingsFor}
          project={project ? { id: project.id, name: project.name } : null}
          hasSettings={settingsOf(byId.get(settingsFor)?.module).length > 0}
          connections={open ? { sides: connectionSides, setting: open.connections, onChange: onConnections } : null}
          scope={settingsScope}
        />
      ) : null}

      {/* The app-wide Settings for the person's agents, and the one-time
          question while it is unanswered. Opened from the projects menu, a
          module's Tools or Skills window, and the sync's lines in the Inbox.
          Its Project section is the open project's own. */}
      <AgentSettingsHost project={project} modules={registry?.presences.map((p) => ({ id: p.id, name: p.name ?? p.id, ...(p.module?.events?.length ? { events: p.module.events } : {}) })) ?? []} />

      {/* The introduction (once, by itself), the tour, the layout picker and
          "save as a layout". See `Onboarding.tsx`. */}
      <OnboardingHost
        facts={tourFacts}
        project={projectId}
        open={open}
        registered={registeredNames}
        scopes={registeredScopes}
        onMade={onMade}
        onFill={(placements) => change({ placements })}
        onInstalled={() => void look(true)}
      />

      {/* "What's new" after Kehikot or a module updates: it never opens by
          itself — the bar's notice (`WhatsNewNotice`) opens it. See `WhatsNew.tsx`. */}
      <WhatsNewHost />

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

/**
 * The quiet word for a switch that is taking longer than it should: said only
 * after `slowMs` (`host/switching.ts`), so a switch that is quick never flashes
 * it. The kehikko being left is still on screen while it shows.
 */
function Arranging() {
  return (
    <div role="status" className="text-muted-foreground pointer-events-none absolute inset-x-0 top-3 z-[2] flex justify-center text-xs">
      <span className="bg-background/80 rounded-full px-2 py-0.5">arranging…</span>
    </div>
  )
}

function Nothing({ registry, looking, empty }: { registry: RegistryView | null; looking: boolean; empty: boolean }) {
  const registered = registry?.presences.length ?? 0
  return (
    <div className="text-muted-foreground pointer-events-none absolute inset-x-0 top-1/3 flex flex-col items-center gap-3 text-center text-sm">
      {looking && !registry ? (
        <p>Asking every registered program what it is…</p>
      ) : registered ? (
        <p>
          {registered} module{registered === 1 ? '' : 's'} registered, none on this kehikko. Put one here from
          <span className="text-foreground"> Kehikko modules</span>, above right.
        </p>
      ) : (
        <p>
          Nothing is registered. A module is a program you run; a registration is a file saying where it
          answers.
        </p>
      )}
      {/* An empty kehikko is where a suggested layout helps most: one press
          fills it, installing nothing without asking. */}
      {empty && !(looking && !registry) ? (
        <Button variant="outline" size="sm" className="pointer-events-auto" onClick={() => openLayouts('fill')} data-start-layout="">
          <LayoutTemplate className="size-3.5" />
          Start from a suggested layout
        </Button>
      ) : null}
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
