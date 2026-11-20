import type { AppUpdateStatus } from './appUpdate.ts'
import type { HeldRestart } from './restartQueue.ts'
import {
  ago,
  hasUpdate,
  isCheckout,
  runsReleases,
  skippedAfter,
  triage,
  unfetchedCount,
  updateSets,
  waiting,
  type Armed,
  type Check,
  type Checkout,
  type NotRestarted,
  type Outcome,
  type Phase as UpdatePhase,
  type Reading,
  type Updated,
} from './updates.ts'
import { APP_ROW_ID, indicator, keptNote, moduleNote, previewAll, staleNote, stateText, updateRows, type Told } from './updateModel.ts'

/**
 * The update engine's state and every way it moves, as a pure reducer.
 *
 * `useUpdatesEngine` (`canvas/Updates.tsx`) does the I/O — the checks, the
 * updates, the restarts, the timers — and says what each came to here as an
 * action; this module is what the page then holds. `derive` reads what the
 * menu and the module list draw from that. The rules for when a check
 * happens, who restarts what and what a cancel stops are in `Updates.tsx`.
 */

export type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  /* `running` is how far the server says each update under way has got; `finished` counts those that ended. */
  | { kind: 'updating'; ids: string[]; running: Readonly<Record<string, UpdatePhase>>; finished: number }

/** A checkout "Update all" left alone, and why (`skippedAfter`). */
export interface Skipped {
  id: string
  name: string
  why: string
}

export interface EngineState {
  check: Check | null
  failed: { at: Date; why: string } | null
  open: boolean
  phase: Phase
  /** A quiet check is running — the icon pulses, nothing else moves. */
  quietly: boolean
  outcomes: Record<string, Outcome>
  notice: string | null
  /** Asked the app to restart; the window is about to go. */
  restarting: boolean
  /** Modules being started again from a failed row, so a second press does not start a second copy. */
  retryingIds: readonly string[]
  /** The one "Restart anyway" that has had its first press, and what the server said it would stop. */
  armed: (Armed & { id: string }) | null
  /** A first press the server has not answered yet, so a second one does not ask twice. */
  armingId: string | null
  /** The level checkouts are listed, not just counted. */
  showLevel: boolean
  /** The module a press elsewhere asked to see ("Update <Module>"): its row is shown and brought into view. */
  asked: string | null
  now: Date
  skipped: Skipped[]
  /** Why "Keep modules up to date automatically" could not be set, from the top of the panel. */
  autoTrouble: string | null
  /* An app restart held behind queued work (protocol 2.110.0, `restartQueue.ts`), as the host says it. */
  held: HeldRestart | null
  /** The desktop app's updater: its last status. Null outside the app. */
  app: AppUpdateStatus | null
}

export function initialState(now: Date): EngineState {
  return {
    check: null,
    failed: null,
    open: false,
    phase: { kind: 'idle' },
    quietly: false,
    outcomes: {},
    notice: null,
    restarting: false,
    retryingIds: [],
    armed: null,
    armingId: null,
    showLevel: false,
    asked: null,
    now,
    skipped: [],
    autoTrouble: null,
    held: null,
    app: null,
  }
}

/** A value, or what to make of the one held — as a React setter takes it. */
export type Next<T> = T | ((was: T) => T)

export type EngineAction =
  /** The tooltip's "4 minutes ago" moves. */
  | { type: 'ticked'; now: Date }
  /** The shell pushed the app updater's status, or answered a check. */
  | { type: 'appStatus'; status: AppUpdateStatus }
  /** "Restart to update" went to the shell, which pushes `installing` and relaunches: said meanwhile. */
  | { type: 'appInstalling' }
  | { type: 'held'; held: HeldRestart | null }
  | { type: 'checkStarted'; loud: boolean }
  | { type: 'checked'; check: Check }
  /** The checkouts read again as they are, without asking GitHub. */
  | { type: 'read'; check: Check }
  | { type: 'checkCancelled'; loud: boolean }
  | { type: 'checkFailed'; at: Date; why: string }
  | { type: 'checkEnded'; loud: boolean; now: Date }
  | { type: 'opened' }
  | { type: 'closed' }
  | { type: 'openSet'; open: Next<boolean> }
  /** A press elsewhere whose remedy is an update (`openUpdates`), for one module or none. */
  | { type: 'askedFor'; module: string | null }
  | { type: 'askedSet'; asked: Next<string | null> }
  | { type: 'showLevelSet'; showLevel: Next<boolean> }
  /** "Update all" (or one Update) began; `fetching` when it first fetches checkouts only a press fetches. */
  | { type: 'updateAllStarted'; fetching: boolean }
  | { type: 'fetchedForUpdate'; check: Check }
  | { type: 'fetchForUpdateFailed'; why: string }
  | { type: 'updateStarted'; ids: string[]; id: string }
  | { type: 'phaseReached'; id: string; phase: UpdatePhase }
  | { type: 'updateDone'; id: string; done: Updated }
  | { type: 'updateFailed'; id: string; why: string }
  | { type: 'updateEnded'; id: string }
  | { type: 'updatesEnded'; cancelled: boolean }
  | { type: 'autoSet'; on: boolean }
  | { type: 'autoFailed'; why: string }
  /** A module is being started again from its row: a retry, or the second press of "Restart anyway". */
  | { type: 'restartStarted'; id: string }
  /** What a restart from a row came to: null when the module answers. */
  | { type: 'restarted'; id: string; failed: NotRestarted | null }
  | { type: 'arming'; id: string }
  | { type: 'armed'; id: string; armed: Armed }
  /** "Restart anyway" refused before anything was stopped: the server's sentence, in the row. */
  | { type: 'anywayRefused'; id: string; said: NotRestarted }
  | { type: 'disarmed' }
  | { type: 'appRestarting' }
  | { type: 'appRestartRefused'; why: string }

const UPDATE_CANCELLED = 'Update cancelled. Anything not marked as updated was left as it was.'
const CHECK_CANCELLED = 'Check cancelled. What is shown is from the last check that finished.'

function settle<T>(next: Next<T>, was: T): T {
  return typeof next === 'function' ? (next as (was: T) => T)(was) : next
}

function withRetrying(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id) ? ids : [...ids, id]
}

export function updatesReducer(state: EngineState, action: EngineAction): EngineState {
  switch (action.type) {
    case 'ticked':
      return { ...state, now: action.now }
    case 'appStatus':
      return { ...state, app: action.status }
    case 'appInstalling':
      return state.app && state.app.state === 'ready' ? { ...state, app: { ...state.app, state: 'installing' } } : state
    case 'held':
      return { ...state, held: action.held }
    case 'checkStarted':
      return action.loud ? { ...state, phase: { kind: 'checking' }, notice: null } : { ...state, quietly: true }
    case 'checked':
      return { ...state, check: action.check, failed: null }
    case 'read':
      return { ...state, check: action.check }
    case 'checkCancelled':
      return action.loud ? { ...state, notice: CHECK_CANCELLED } : state
    case 'checkFailed':
      return { ...state, failed: { at: action.at, why: action.why } }
    case 'checkEnded':
      return action.loud ? { ...state, now: action.now, phase: { kind: 'idle' } } : { ...state, now: action.now, quietly: false }
    case 'opened':
      return {
        ...state,
        open: true,
        /* What was done last time is cleared, except a host update still waiting
           on a restart: that is not history, it is the thing the header is asking
           for, and forgetting it here took the restart button away with it. */
        outcomes: Object.fromEntries(Object.entries(state.outcomes).filter(([, outcome]) => awaitsRestart(outcome))),
        showLevel: false,
        skipped: [],
      }
    case 'closed':
      return { ...state, armed: null, asked: null, open: false }
    case 'openSet':
      return { ...state, open: settle(action.open, state.open) }
    case 'askedFor':
      /* A module asked for by name is shown even when it is up to date. */
      return { ...state, asked: action.module, showLevel: action.module !== null }
    case 'askedSet':
      return { ...state, asked: settle(action.asked, state.asked) }
    case 'showLevelSet':
      return { ...state, showLevel: settle(action.showLevel, state.showLevel) }
    case 'updateAllStarted':
      return { ...state, notice: null, skipped: [], ...(action.fetching ? { phase: { kind: 'checking' } as const } : {}) }
    case 'fetchedForUpdate':
      return { ...state, check: action.check, skipped: skippedAfter(action.check.checkouts, action.check.pins) }
    case 'fetchForUpdateFailed':
      return { ...state, notice: `GitHub could not be asked, so the local checkouts were not fetched: ${action.why}` }
    case 'updateStarted': {
      const running = state.phase.kind === 'updating' ? state.phase.running : {}
      const finished = state.phase.kind === 'updating' ? state.phase.finished : 0
      return { ...state, phase: { kind: 'updating', ids: action.ids, running: { ...running, [action.id]: 'updating' }, finished } }
    }
    case 'phaseReached':
      if (state.phase.kind !== 'updating') return state
      return { ...state, phase: { ...state.phase, running: { ...state.phase.running, [action.id]: action.phase } } }
    case 'updateDone':
      return updateDone(state, action.id, action.done)
    case 'updateFailed':
      return { ...state, outcomes: { ...state.outcomes, [action.id]: { kind: 'failed', why: action.why } } }
    case 'updateEnded': {
      if (state.phase.kind !== 'updating') return state
      const { [action.id]: _gone, ...running } = state.phase.running
      return { ...state, phase: { ...state.phase, running, finished: state.phase.finished + 1 } }
    }
    case 'updatesEnded':
      return { ...state, phase: { kind: 'idle' }, ...(action.cancelled ? { notice: UPDATE_CANCELLED } : {}) }
    case 'autoSet':
      return {
        ...state,
        autoTrouble: null,
        check: state.check?.auto ? { ...state.check, auto: { ...state.check.auto, on: action.on } } : state.check,
      }
    case 'autoFailed':
      return { ...state, autoTrouble: action.why }
    case 'restartStarted':
      return { ...state, armed: null, retryingIds: withRetrying(state.retryingIds, action.id) }
    case 'restarted':
      return {
        ...state,
        retryingIds: state.retryingIds.filter((one) => one !== action.id),
        outcomes: { ...state.outcomes, [action.id]: restartOutcome(action.failed) },
      }
    case 'arming':
      return { ...state, armingId: action.id }
    case 'armed':
      return { ...state, armingId: null, armed: { id: action.id, ...action.armed } }
    case 'anywayRefused':
      return {
        ...state,
        armingId: null,
        armed: null,
        outcomes: { ...state.outcomes, [action.id]: { kind: 'failed', why: action.said.why, retry: true, ...(action.said.kept ? { kept: true } : {}) } },
      }
    case 'disarmed':
      return { ...state, armed: null }
    case 'appRestarting':
      return { ...state, restarting: true }
    case 'appRestartRefused':
      /* On success there is nothing more to do: the app stops this page and comes back with the new server. A refusal goes back to the list. */
      return { ...state, restarting: false, notice: action.why }
  }
}

/** One update finished: its checkout as it now is, what it came to, and — unless its module still runs old code — no staleness left. */
function updateDone(state: EngineState, id: string, done: Updated): EngineState {
  const reading = done.checkout
  let check = state.check ? { ...state.check, checkouts: state.check.checkouts.map((one) => (one.id === reading.id ? reading : one)) } : null
  if (check && done.module?.ran !== 'stale') check = { ...check, stale: without(check.stale, id), older: without(check.older, id) }
  return { ...state, check, outcomes: { ...state.outcomes, [id]: outcomeOf(id, done) } }
}

/** What a restart from a row came to, as that row's outcome. */
function restartOutcome(failed: NotRestarted | null): Outcome {
  return failed
    ? { kind: 'failed', why: failed.why, detail: failed.detail, retry: true, ...(failed.kept ? { kept: true } : {}) }
    : { kind: 'updated', note: moduleNote({ ran: 'restarted' }), restart: null, installFailed: null }
}

/** The checkouts "Update all" updates after fetching the ones only a press fetches: those asked for that are ready now. */
export function idsToUpdate(found: Check, readyIds: readonly string[], unfetchedIds: readonly string[]): string[] {
  const wanted = new Set([...readyIds, ...unfetchedIds])
  const { ready: taken } = updateSets(found.checkouts)
  return taken.filter((one) => wanted.has(one.id)).map((one) => one.id)
}

/** A host update that still needs a restart to run: kept across opening the panel. */
export function awaitsRestart(outcome: Outcome): boolean {
  return outcome.kind === 'updated' && outcome.restart !== null
}

function without(record: Record<string, string>, id: string): Record<string, string> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== id))
}

/** What one finished update is, as the row's outcome. */
export function outcomeOf(id: string, done: Updated): Outcome {
  const files = `${done.changed.length} file${done.changed.length === 1 ? '' : 's'} changed${done.lockfileReset ? ', a leftover dependency lock file was reset' : ''}${done.installed ? ', dependencies installed' : ''}.`
  if (id === 'host' || !done.module) {
    return {
      kind: 'updated',
      note:
        done.restart === 'host'
          ? `Updated — ${files} The page reloads by itself, but Kehikot itself changed too. Quit and reopen Kehikot to use it.`
          : `Updated — ${files} The page reloads by itself.`,
      restart: done.restart,
      installFailed: done.installFailed,
    }
  }
  if (done.module.ran === 'failed') {
    return { kind: 'failed', why: `Updated, but it did not start again. ${done.module.why}`, detail: done.module.detail, retry: true }
  }
  if (done.module.ran === 'stale') {
    return { kind: 'failed', why: done.module.kept ? keptNote(done.checkout.name) : staleNote(done.module.why), retry: true, ...(done.module.kept ? { kept: true } : {}) }
  }
  /* Commits that cancel out: the checkout moved and no file is different. */
  if (done.module.ran === 'page' && done.changed.length === 0) {
    return { kind: 'updated', note: "Updated. Nothing it runs changed, so it wasn't restarted.", restart: null, installFailed: done.installFailed }
  }
  return { kind: 'updated', note: moduleNote(done.module), restart: null, installFailed: done.installFailed }
}

/**
 * What the server says beyond the checkouts, per module. An update this page
 * is running (`mine`) is told by its own stream, which is ahead of the last check.
 */
export function toldOf(check: Check | null, outcomes: Readonly<Record<string, Outcome>>, mine: (id: string) => boolean): Record<string, Told> {
  const told: Record<string, Told> = {}
  for (const [id, reached] of Object.entries(check?.progress ?? {})) if (!mine(id)) told[id] = { phase: reached }
  for (const [id, why] of Object.entries(check?.stale ?? {})) told[id] = { ...told[id], stale: why }
  for (const [id, why] of Object.entries(check?.older ?? {})) told[id] = { ...told[id], older: why }
  /* An installed copy being built, or whose build did not finish (`moduleBuilds.ts`). */
  for (const [id, build] of Object.entries(check?.builds ?? {})) if (!mine(id)) told[id] = { ...told[id], build }
  /* Why the switch has not put a module's update in place yet: "Terminal updates when its sessions end". */
  for (const [id, wait] of Object.entries(check?.auto?.waiting ?? {})) if (!mine(id)) told[id] = { ...told[id], auto: wait }
  /* Only on a module something is already said about: being kept is not news. */
  for (const id of check?.kept ?? []) if (Object.hasOwn(told, id)) told[id] = { ...told[id], kept: true }
  /* Whether a restart ends its sessions: only said on a restart button, so only where one can be drawn. */
  for (const id of check?.holds ?? []) if (Object.hasOwn(told, id) || outcomes[id]?.kind === 'failed') told[id] = { ...told[id], holds: true }
  return told
}

/** How many updates wait for a press: what the switch puts in place by itself once the module is off screen or stops is not counted. */
function waitingCount(check: Check | null): number {
  if (!check) return 0
  const scheduled = new Set(
    Object.entries(check.auto?.on ? check.auto.waiting : {})
      .filter(([, wait]) => wait.until === 'off-screen' || wait.until === 'stopped')
      .map(([id]) => id),
  )
  return waiting(
    check.checkouts.filter((one) => !scheduled.has(one.id)),
    check.pins,
  )
}

/** The panel's status line: what is happening now, or what the last check found. */
function statusOf(state: EngineState, updating: Extract<Phase, { kind: 'updating' }> | null, lastFailed: EngineState['failed'], count: number, unfetched: number): string {
  if (state.restarting) return 'Restarting Kehikot to run the update…'
  if (state.phase.kind === 'checking') return 'Asking GitHub what is new for Kehikot and each module…'
  if (updating) return updatingStatus(updating, (id) => nameOf(state.check?.checkouts ?? [], id))
  return summaryOf(state.check, lastFailed, count, unfetched)
}

/** Everything the Updates menu and the module list draw, read from the engine's state. */
export function derive(state: EngineState) {
  const { check, phase, outcomes, app, failed, open, quietly, now, asked } = state
  const pins = check?.pins ?? {}
  const count = waitingCount(check)
  const checkouts = check?.checkouts ?? []
  const unfetched = unfetchedCount(checkouts, pins)
  const updating = phase.kind === 'updating' ? phase : null
  /** The checkouts this page is updating now. */
  const mine = (id: string) => updating !== null && Object.hasOwn(updating.running, id)
  const told = toldOf(check, outcomes, mine)
  const rows = updateRows(app, checkouts, outcomes, updating ? updating.running : null, pins, told)
  const appOne = rows[0]?.id === APP_ROW_ID && rows[0].source === 'app' ? rows[0] : null
  const shown = indicator(rows)
  const checking = phase.kind === 'checking' || quietly || appOne?.state === 'checking'
  const label = [tooltipFor(check, failed, count, now, checking && !open, unfetched), appOne ? `Kehikot app ${appOne.current}: ${stateText(appOne).toLowerCase()}` : null]
    .filter(Boolean)
    .join(' · ')
  const { attention, level } = triage(checkouts, outcomes, new Set(Object.keys(told)))
  /* The row a press elsewhere asked for, once it is drawn. */
  const askedDrawn = asked !== null && [...attention, ...level].some((one) => one.id === asked)
  const sets = updateSets(attention)
  const ready = sets.ready
  const unfetchedOnes = sets.unfetched
  const everything = ready.length + unfetchedOnes.length
  const endsAll = previewAll(ready.map((one) => ({ name: one.name, preview: check?.previews[one.id] })))
  const appCalm = !appOne || ['uptodate', 'unknown', 'checking'].includes(appOne.state)
  const lastFailed = failed && (!check || failed.at > check.checked) ? failed : null
  const status = statusOf(state, updating, lastFailed, count, unfetched)
  return { pins, count, checkouts, unfetched, updating, mine, told, rows, appOne, shown, checking, label, attention, level, askedDrawn, ready, unfetchedOnes, everything, endsAll, appCalm, lastFailed, status }
}

/** The panel's status line while this page updates: "Updating Notes and Terminal (1 of 3 done)…". */
export function updatingStatus(updating: { ids: readonly string[]; running: Readonly<Record<string, UpdatePhase>>; finished: number }, name: (id: string) => string): string {
  const now = Object.entries(updating.running)
  const verb = (phase: UpdatePhase) => (phase === 'restarting' ? 'Restarting' : phase === 'preparing' ? 'Preparing' : phase === 'installing' ? 'Installing for' : 'Updating')
  const count = updating.ids.length > 1 ? ` (${updating.finished} of ${updating.ids.length} done)` : ''
  if (now.length === 0) return `Updating${count}…`
  if (now.length === 1) return `${verb(now[0]![1])} ${name(now[0]![0])}${count}…`
  return `Updating ${now.map(([id]) => name(id)).join(' and ')}${count}…`
}

function nameOf(checkouts: readonly Reading[], id: string): string {
  return checkouts.find((one) => one.id === id)?.name ?? id
}

export function summaryOf(check: Check | null, failed: { why: string } | null, count: number, unfetched = 0): string {
  if (failed) return 'The last check did not finish.'
  if (!check) return 'Not checked yet.'
  if (count === 0 && unfetched === 0) return 'Everything is up to date with GitHub.'
  if (count === 0) return `${unfetchedSaid(unfetched)} Update all fetches ${unfetched === 1 ? 'it' : 'them'}.`
  const updating = check.checkouts.filter((one): one is Checkout => isCheckout(one) && !Object.hasOwn(check.pins, one.id) && hasUpdate(one))
  const releases = updating.filter(runsReleases).length
  if (releases > 0) {
    const n = updating.length
    return `${n} update${n === 1 ? '' : 's'} waiting${releases === n ? ` — ${n === 1 ? 'a new release' : 'new releases'}` : ''}.${unfetched ? ` ${unfetchedSaid(unfetched)}` : ''}`
  }
  return `${count} new commit${count === 1 ? '' : 's'} across ${updating.length} repositor${updating.length === 1 ? 'y' : 'ies'}.${unfetched ? ` ${unfetchedSaid(unfetched)}` : ''}`
}

/** Checkouts the automatic check saw move and fetched nothing of: never "up to date". */
function unfetchedSaid(n: number): string {
  return `${n} local checkout${n === 1 ? ' has' : 's have'} new commits not fetched yet.`
}

export function tooltipFor(
  check: Check | null,
  failed: { at: Date; why: string } | null,
  count: number,
  now: Date,
  checking: boolean,
  unfetched = 0,
): string {
  if (checking) return 'checking for updates…'
  if (failed && (!check || failed.at > check.checked)) {
    return `the last check for updates failed ${ago(failed.at, now)}: ${failed.why}`
  }
  if (!check) return 'not checked for updates yet — press to check now'
  const when = `last checked for updates ${ago(check.checked, now)} (${check.checked.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`
  const fetch = unfetched ? `${unfetched} local checkout${unfetched === 1 ? ' has' : 's have'} new commits not fetched yet` : ''
  if (count) return `${when} — ${count} new commit${count === 1 ? '' : 's'} waiting${fetch ? `, ${fetch}` : ''}`
  return fetch ? `${when} — ${fetch}` : `${when} — everything is up to date`
}
