import type { AppUpdateStatus } from './appUpdate.ts'
import { isCheckout, type Outcome, type Reading } from './updates.ts'

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
 * | `updating`  | `downloading` (with %), `installing` | the fast-forward is running    |
 * | `ready`     | `ready`: restart to update | updated, and needs a restart to run it   |
 * | `failed`    | `failed` + its error      | unreadable, unreachable, or an update failed |
 * | `blocked`   | —                         | behind, but refused: uncommitted changes… |
 * | `pinned`    | —                         | reserved for version pinning (issue #30)  |
 */
export type UpdateState =
  | 'unknown'
  | 'checking'
  | 'uptodate'
  | 'available'
  | 'updating'
  | 'ready'
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
  activity: 'downloading' | 'installing' | 'updating' | null
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

/** A module checkout's row, given what was just done to it. */
export function moduleRow(reading: Reading, outcome: Outcome | null | undefined, running: boolean): UpdateRow {
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
  if (running) return { ...row, state: 'updating', activity: 'updating' }
  if (outcome?.kind === 'failed') return { ...row, state: 'failed', reason: outcome.why }
  if (outcome?.kind === 'updated') {
    return outcome.restart ? { ...row, state: 'ready', reason: outcome.note } : { ...row, state: 'uptodate', reason: outcome.note }
  }
  if (outcome?.kind === 'restarted') return row
  if (reading.behind > 0) {
    return reading.blocked === null ? { ...row, state: 'available' } : { ...row, state: 'blocked', reason: reading.blocked }
  }
  if (reading.fetchFailed) return { ...row, state: 'failed', reason: `GitHub could not be reached: ${reading.fetchFailed}` }
  return row
}

/** Every row: the app first (when there is one), then the modules in the order given. */
export function updateRows(
  app: AppUpdateStatus | null,
  checkouts: readonly Reading[],
  outcomes: Readonly<Record<string, Outcome>>,
  running: string | null,
): UpdateRow[] {
  const first = appRow(app)
  const modules = checkouts.map((one) => moduleRow(one, outcomes[one.id], running === one.id))
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
  if (moving) return { label: `Updating ${moving.name}`, tone: 'busy' }
  if (rows.some((one) => one.state === 'ready')) return { label: 'Restart to update', tone: 'action' }
  const available = rows.filter((one) => one.state === 'available').length
  if (available) return { label: `${available} update${available === 1 ? '' : 's'}`, tone: 'info' }
  if (app?.state === 'failed') return { label: 'Update failed', tone: 'error' }
  return null
}

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
      if (row.activity === 'installing') return `Installing ${row.version ?? 'the update'}…`
      if (row.activity === 'downloading') {
        return `Downloading ${row.version ?? 'the update'}${row.progress === null ? '…' : ` · ${Math.round(row.progress * 100)}%`}`
      }
      return 'Updating…'
    case 'ready':
      return row.source === 'app' ? `${kehikot(row.version)} is ready — restart to update` : 'Updated — restart to run it'
    case 'failed':
      return `Failed: ${row.reason ?? 'no reason given'}`
    case 'blocked':
      return `Not updated automatically: ${row.reason ?? 'no reason given'}`
    case 'pinned':
      return `Pinned${row.version ? ` to ${row.version}` : ''}`
  }
}

function kehikot(version: string | null): string {
  return version ? `Kehikot ${version}` : 'the Kehikot update'
}

function clamp(progress: number | null): number | null {
  if (progress === null || !Number.isFinite(progress)) return null
  return Math.min(1, Math.max(0, progress))
}
