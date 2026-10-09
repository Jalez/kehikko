import type { AppUpdateStatus } from './appUpdate.ts'
import { isCheckout, type Outcome, type Phase, type PinCount, type Reading } from './updates.ts'

/**
 * One update system: the desktop app's own updater and the module checkouts,
 * read into the same rows with the same states, so the Updates menu and the
 * header indicator say one thing about both. Pure functions only; the
 * component in `canvas/Updates.tsx` feeds them.
 *
 * The states, shared by every row:
 *
 * | state       | app (engine)              | module (checkout)                         |
 * | ----------- | ------------------------- | ----------------------------------------- |
 * | `unknown`   | `idle`: not checked yet   | —                                         |
 * | `checking`  | `checking`                | — (a module check is the whole panel's)   |
 * | `uptodate`  | `uptodate`                | level, or just updated with nothing to do |
 * | `available` | — (the engine downloads at once) | behind, and an update would go ahead |
 * | `updating`  | `downloading` (with %), `installing` | the fast-forward, an install, or the restart |
 * | `ready`     | `ready`: restart to update | — (a module is restarted by its update)  |
 * | `reopen`    | —                         | the HOST's own server changed: restart the host |
 * | `failed`    | `failed` + its error      | unreadable, unreachable, an update failed, or left on old code |
 * | `blocked`   | —                         | behind, but refused: uncommitted changes… |
 * | `pinned`    | —                         | containers are pinned to a tagged version |
 */
export type UpdateState =
  | 'unknown'
  | 'checking'
  | 'uptodate'
  | 'available'
  | 'updating'
  | 'ready'
  | 'reopen'
  | 'failed'
  | 'blocked'
  | 'pinned'

export interface UpdateRow {
  /** `app`, `host`, or the module's registration id. */
  id: string
  source: 'app' | 'module'
  name: string
  /** The running version: the app's semver, or a checkout's short commit. */
  current: string | null
  state: UpdateState
  /** What is coming: the app version being downloaded or waiting. */
  version: string | null
  /** 0..1 while downloading, null when unknown or not downloading. */
  progress: number | null
  /** Why it failed or is blocked, or what a restart is for. */
  reason: string | null
  /** For a module that is behind: how many commits. */
  behind: number
  /** What `updating` is doing, for the words. */
  activity: 'downloading' | 'installing' | 'updating' | 'applying' | 'restarting' | null
  /** A failed module can be started again from its row. */
  retry?: boolean
}

/** What the server says about one module beyond its checkout. See `Check.progress` and `Check.stale`. */
export interface Told {
  phase?: Phase
  stale?: string
}

export const APP_ROW_ID = 'app'

/** The app's row, or null when there is no engine or it never checks. */
export function appRow(status: AppUpdateStatus | null): UpdateRow | null {
  if (!status || !status.enabled) return null
  const base: UpdateRow = {
    id: APP_ROW_ID,
    source: 'app',
    name: 'Kehikot app',
    current: status.current,
    state: 'unknown',
    version: status.version,
    progress: null,
    reason: null,
    behind: 0,
    activity: null,
  }
  switch (status.state) {
    case 'idle':
      return base
    case 'checking':
      return { ...base, state: 'checking' }
    case 'uptodate':
      return { ...base, state: 'uptodate', version: null }
    case 'downloading':
      return { ...base, state: 'updating', activity: 'downloading', progress: clamp(status.progress) }
    case 'installing':
      return { ...base, state: 'updating', activity: 'installing' }
    case 'ready':
      return { ...base, state: 'ready' }
    case 'failed':
      return { ...base, state: 'failed', reason: status.error ?? 'the update did not finish, and the app did not say why' }
  }
}

/**
 * A module checkout's row, given what was just done to it.
 *
 * `pins` is how many containers pin this module to a version. Such a module
 * is `pinned` where it would otherwise be up to date, available or blocked:
 * those containers run the tag they were pinned to, and a new commit on the
 * checkout is not something they are waiting for — so the header does not
 * count it. Updating the checkout is still offered in the panel, for the
 * containers that run latest.
 */
export function moduleRow(
  reading: Reading,
  outcome: Outcome | null | undefined,
  /** What the update running on it has reached, or null when none is. */
  running: Phase | null,
  pins?: PinCount,
  told: Told = {},
): UpdateRow {
  const base: UpdateRow = {
    id: reading.id,
    source: 'module',
    name: reading.name,
    current: null,
    state: 'uptodate',
    version: null,
    progress: null,
    reason: null,
    behind: 0,
    activity: null,
  }
  if (!isCheckout(reading)) return { ...base, state: 'failed', reason: reading.error }
  const row = { ...base, current: reading.commit, behind: reading.behind }
  /* This page's own press first, then what the server says is still running —
     which is all a page that reloaded mid-update has. */
  const phase = running ?? told.phase ?? null
  if (phase) return { ...row, state: 'updating', activity: phase }
  if (outcome?.kind === 'failed') return { ...row, state: 'failed', reason: outcome.why, retry: outcome.retry === true }
  if (outcome?.kind === 'updated') {
    /* Only the host's own checkout can be left needing a restart. */
    return outcome.restart === 'host' ? { ...row, state: 'reopen', reason: outcome.note } : { ...row, state: 'uptodate', reason: outcome.note }
  }
  /* Left on old code — unless there is something newer to take, which is the
     better thing to offer: an update restarts it, or says again why it cannot. */
  if (told.stale && reading.behind === 0) return { ...row, state: 'failed', reason: staleNote(told.stale), retry: true }
  if (pins && pins.containers > 0) {
    return {
      ...row,
      state: 'pinned',
      version: pins.versions.join(', '),
      reason: `${pins.containers} container${pins.containers === 1 ? '' : 's'} pinned to ${pins.versions.join(', ')}`,
    }
  }
  if (reading.behind > 0) {
    return reading.blocked === null ? { ...row, state: 'available' } : { ...row, state: 'blocked', reason: reading.blocked }
  }
  if (reading.fetchFailed) return { ...row, state: 'failed', reason: `GitHub could not be reached: ${reading.fetchFailed}` }
  return row
}

/**
 * The sentence for a module that was updated and that this host could not
 * restart. "May", because the host cannot see which code a running process
 * holds: a module whose Vite restarts in-process on a config change (Explorer,
 * Source) is on the new code with the same pid, and one whose dependencies
 * moved is not. A build identity settles it — see `server/stale.ts`.
 */
export function staleNote(why: string): string {
  return `Updated, but it was not restarted and may still be running the old code: ${why}`
}

/**
 * The sentence a module's row ends on after an update — `ModuleOutcome` in
 * `server/server.ts` has what each one means. Never a request to restart it.
 */
export function moduleNote(module: { ran: 'page' | 'restarted' | 'started' | 'idle' }): string {
  switch (module.ran) {
    case 'page':
      return 'Updated — running the new code. Only its page changed, and that reloads itself.'
    case 'restarted':
      /* Said because the restart is the host's doing and takes with it whatever
         the module held only in its process — a terminal's shell. */
      return 'Updated — running the new code. It was restarted, which ended anything it was running.'
    case 'started':
      return 'Updated — running the new code.'
    case 'idle':
      return 'Updated. It is not running; it starts on the new code when a kehikko that has it is opened.'
  }
}

/** Every row: the app first (when there is one), then the modules in the order given. */
export function updateRows(
  app: AppUpdateStatus | null,
  checkouts: readonly Reading[],
  outcomes: Readonly<Record<string, Outcome>>,
  /** The checkout this page is updating right now, and how far that has got. */
  running: { id: string; phase: Phase } | null,
  pins: Readonly<Record<string, PinCount>> = {},
  told: Readonly<Record<string, Told>> = {},
): UpdateRow[] {
  const first = appRow(app)
  const modules = checkouts.map((one) =>
    moduleRow(
      one,
      outcomes[one.id],
      running?.id === one.id ? running.phase : null,
      Object.hasOwn(pins, one.id) ? pins[one.id] : undefined,
      Object.hasOwn(told, one.id) ? told[one.id] : undefined,
    ),
  )
  return first ? [first, ...modules] : modules
}

export interface Indicator {
  label: string
  tone: 'busy' | 'action' | 'info' | 'error'
}

/**
 * The header's one line about all of it, or null when there is nothing to say.
 * The most pressing thing wins: something moving, then something waiting on a
 * restart, then how many updates can be taken, then an app update that failed.
 * A module that could not reach GitHub, or that is behind but blocked, does not
 * reach the header: the first is usually being offline, the second is somebody's
 * working tree, and neither is anything a click on the header could fix.
 *
 * "Restart to update" is the desktop app's update and nothing else. A module
 * never asks for a restart — its update does that — and the host's own
 * checkout, which only a development host has, says "Restart the host".
 */
export function indicator(rows: readonly UpdateRow[]): Indicator | null {
  const app = rows.find((one) => one.source === 'app') ?? null
  if (app?.state === 'updating') {
    const what = kehikot(app.version)
    if (app.activity === 'installing') return { label: `Installing ${what}`, tone: 'busy' }
    const percent = app.progress === null ? '' : ` · ${Math.round(app.progress * 100)}%`
    return { label: `Downloading ${what}${percent}`, tone: 'busy' }
  }
  const moving = rows.find((one) => one.source === 'module' && one.state === 'updating')
  if (moving) return { label: `${moving.activity === 'restarting' ? 'Restarting' : 'Updating'} ${moving.name}`, tone: 'busy' }
  if (app?.state === 'ready') return { label: RESTART_TO_UPDATE, tone: 'action' }
  if (rows.some((one) => one.state === 'reopen')) return { label: RESTART_THE_HOST, tone: 'action' }
  const available = rows.filter((one) => one.state === 'available').length
  if (available) return { label: `${available} update${available === 1 ? '' : 's'}`, tone: 'info' }
  if (app?.state === 'failed') return { label: 'Update failed', tone: 'error' }
  return null
}

/** The desktop app has an update downloaded: the one thing these words mean. */
export const RESTART_TO_UPDATE = 'Restart to update'
/** The host's own checkout moved under a running server. */
export const RESTART_THE_HOST = 'Restart the host'

/** One row's state in words, the same words for the app and a module. */
export function stateText(row: UpdateRow): string {
  switch (row.state) {
    case 'unknown':
      return 'Not checked yet'
    case 'checking':
      return 'Checking…'
    case 'uptodate':
      return 'Up to date'
    case 'available':
      return row.source === 'app'
        ? `${kehikot(row.version)} is available`
        : `${row.behind} new commit${row.behind === 1 ? '' : 's'}`
    case 'updating':
      if (row.activity === 'installing') return row.source === 'app' ? `Installing ${row.version ?? 'the update'}…` : 'Installing what changed…'
      if (row.activity === 'downloading') {
        return `Downloading ${row.version ?? 'the update'}${row.progress === null ? '…' : ` · ${Math.round(row.progress * 100)}%`}`
      }
      if (row.activity === 'restarting') return 'Restarting…'
      return 'Updating…'
    case 'ready':
      return `${kehikot(row.version)} is ready — restart to update`
    case 'reopen':
      return 'Updated — restart the host to run it'
    case 'failed':
      return `Failed: ${row.reason ?? 'no reason given'}`
    case 'blocked':
      return `Not updated automatically: ${row.reason ?? 'no reason given'}`
    case 'pinned': {
      const pinned = row.reason ?? `Pinned${row.version ? ` to ${row.version}` : ''}`
      return row.behind > 0 ? `${pinned} · latest has ${row.behind} new commit${row.behind === 1 ? '' : 's'}` : pinned
    }
  }
}

function kehikot(version: string | null): string {
  return version ? `Kehikot ${version}` : 'the Kehikot update'
}

function clamp(progress: number | null): number | null {
  if (progress === null || !Number.isFinite(progress)) return null
  return Math.min(1, Math.max(0, progress))
}
