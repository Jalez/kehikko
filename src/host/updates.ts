import { z } from 'zod'

import { buildDetailsSchema, buildToldSchema, type BuildDetails, type BuildTold } from './moduleBuilds.ts'
import type { ModuleRelease } from './moduleReleases.ts'
import type { WorksWith } from './worksWith.ts'

/**
 * Whether the host and its modules are behind GitHub — the page's side of
 * `server/updates.ts`, which has the rules. Every call takes a signal, because
 * the panel's Cancel is a real cancel: closing the request stops the git the
 * server was running for it.
 */

/**
 * Asks the updates panel in the header to open and check now. For a press
 * somewhere else whose remedy is an update — a container whose module's
 * manifest this host refused (`Start.tsx`), or that does not fit this Kehikot
 * ("Update Kehikot", "Update <Module>"). With a module's id the panel also
 * brings that module's row into view, listed even when it is up to date. The
 * panel listens (`Updates.tsx`).
 */
export const OPEN_UPDATES = 'kehikot:open-updates'
export function openUpdates(module?: string): void {
  window.dispatchEvent(new CustomEvent<{ module: string | null }>(OPEN_UPDATES, { detail: { module: module ?? null } }))
}

/** The module an `OPEN_UPDATES` event asks to be shown, or null. */
export function askedModule(event: Event): string | null {
  const detail = (event as CustomEvent<unknown>).detail
  const module = typeof detail === 'object' && detail !== null ? (detail as { module?: unknown }).module : null
  return typeof module === 'string' && module ? module : null
}

const incomingSchema = z.object({ hash: z.string(), subject: z.string() })

const appSchema = z.object({ app: z.string(), protocol: z.string() })

/** Which Kehikot a release works with. Mirrors `WorksWith` in `worksWith.ts`. */
const worksSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('from'),
    need: z.string(),
    from: z.string(),
    until: z.object({ last: z.string(), next: z.string(), major: z.number() }).nullable(),
    runningOnly: z.literal(true).optional(),
  }),
  z.object({ kind: z.literal('unreleased'), need: z.string(), newest: appSchema }),
  z.object({ kind: z.literal('none'), need: z.string() }),
  z.object({ kind: z.literal('unknown'), need: z.string() }),
]) satisfies z.ZodType<WorksWith, z.ZodTypeDef, unknown>

/** An installed module's releases. Mirrors `ModuleRelease` in `moduleReleases.ts`. */
const releaseSchema = z.object({
  follows: z.enum(['release', 'main', 'ahead']),
  installed: z.string().nullable(),
  newest: z.string().nullable(),
  target: z.string().nullable(),
  notes: z.array(z.string()).default([]),
  needsNewer: z.object({ tag: z.string(), protocol: z.string() }).nullable().default(null),
  repo: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  /* Absent from an older host; one a later host words differently is dropped, not refused. */
  works: z.record(z.string(), worksSchema).optional().catch(undefined),
}) satisfies z.ZodType<ModuleRelease, z.ZodTypeDef, unknown>

const checkoutSchema = z.object({
  id: z.string(),
  name: z.string(),
  dir: z.string(),
  branch: z.string().nullable(),
  commit: z.string(),
  dirty: z.boolean(),
  staleLock: z.boolean().optional(),
  upstream: z.string().nullable(),
  behind: z.number(),
  ahead: z.number(),
  incoming: z.array(incomingSchema),
  fetchFailed: z.string().nullable(),
  /** The automatic check saw the remote move and fetched nothing: Check now reads it. Absent from an older host. */
  waiting: z.boolean().optional(),
  blocked: z.string().nullable(),
  /** Absent for a checkout that is not an installed copy, and from an older host. */
  release: releaseSchema.optional(),
})

const unreadableSchema = z.object({ id: z.string(), name: z.string(), dir: z.string(), error: z.string() })

const readingSchema = z.union([checkoutSchema, unreadableSchema])

export type Checkout = z.infer<typeof checkoutSchema>
export type Reading = z.infer<typeof readingSchema>

/** How many containers pin a module to a version, and which versions. See `pinSummary` in `server/pins.ts`. */
export interface PinCount {
  containers: number
  versions: string[]
}

export interface Check {
  checked: Date
  checkouts: Reading[]
  /** Per module id: its pinned containers. Empty from a host older than versions. */
  pins: Record<string, PinCount>
  /** Whether the desktop app can restart this host — see `/host/restart`. */
  restartable: boolean
  /** Updates the server is still running, by checkout id — so a page that reloaded mid-update says so. */
  progress: Record<string, Phase>
  /** Modules the server knows are running older code than their checkout, with why. */
  stale: Record<string, string>
  /** Modules whose own build identity says their server is behind their checkout, with the sentence. Empty from an older host. */
  older: Record<string, string>
  /** What each waiting update would do to its running module — `previewUpdate` in `server/restart.ts`. */
  previews: Record<string, Preview>
  /** Running modules whose registration says to keep them: an ordinary restart of one is refused. Empty from an older host. */
  kept: string[]
  /** The protocol package this host has; null from an older host. What "you have" says outside the desktop app. */
  protocol: string | null
  /** Installed copies being built, and the ones whose build did not finish (`moduleBuilds.ts`). Empty from an older host. */
  builds: Record<string, BuildTold>
}

export type Preview = 'page' | 'restart' | 'self' | 'kept'

/** What an update is doing right now. */
/** `applying` is the checkout having moved: from there nothing is cancelled. */
export type Phase = 'updating' | 'applying' | 'installing' | 'preparing' | 'restarting'
const phaseSchema = z.enum(['updating', 'applying', 'installing', 'preparing', 'restarting'])

export function isCheckout(reading: Reading): reading is Checkout {
  return !('error' in reading)
}

/**
 * Read every checkout; `fetch` asks GitHub first, which is the slow part. `quiet`: the automatic
 * check, which only compares each remote with what was fetched and fetches no checkout somebody
 * edits (`readCheckout` in `server/updates.ts`); Check now leaves it out.
 */
export async function fetchUpdates(fetch: boolean, signal?: AbortSignal, app?: string | null, quiet = false): Promise<Check> {
  /* `app` is the running app's version: when it is newer than the newest app the host has read the tags of, the host reads them again. */
  const query = fetch ? `?fetch=1${quiet ? '&quiet=1' : ''}${app ? `&app=${encodeURIComponent(app)}` : ''}` : ''
  const response = await globalThis.fetch(`/host/updates${query}`, { signal })
  if (!response.ok) throw new Error(await reason(response))
  const body = z
    .object({
      checked: z.string(),
      checkouts: z.array(readingSchema),
      restartable: z.boolean().default(false),
      pins: z.record(z.string(), z.object({ containers: z.number(), versions: z.array(z.string()) })).default({}),
      progress: z.record(z.string(), phaseSchema).default({}),
      stale: z.record(z.string(), z.string()).default({}),
      older: z.record(z.string(), z.string()).default({}),
      previews: z.record(z.string(), z.enum(['page', 'restart', 'self', 'kept'])).default({}),
      kept: z.array(z.string()).default([]),
      protocol: z.string().nullable().default(null),
      /* One a later host words differently is dropped, not refused. */
      builds: z.record(z.string(), buildToldSchema).default({}).catch({}),
    })
    .parse(await response.json())
  return {
    checked: new Date(body.checked),
    checkouts: body.checkouts,
    restartable: body.restartable,
    pins: body.pins,
    progress: body.progress,
    stale: body.stale,
    older: body.older,
    previews: body.previews,
    kept: body.kept,
    protocol: body.protocol,
    builds: body.builds,
  }
}

/**
 * One installed module's releases, for its details in the modules list: the
 * one it runs, the newest, and which Kehikot each works with. Null for a
 * module that is not an installed copy, and from a host older than this.
 */
export async function fetchModuleRelease(
  id: string,
  signal?: AbortSignal,
): Promise<{ release: ModuleRelease | null; protocol: string | null; build: BuildDetails | null }> {
  const response = await globalThis.fetch(`/host/module-release?id=${encodeURIComponent(id)}`, { signal })
  if (response.status === 404) return { release: null, protocol: null, build: null }
  if (!response.ok) throw new Error(await reason(response))
  return z
    .object({
      release: releaseSchema.nullable().default(null),
      protocol: z.string().nullable().default(null),
      /* How the copy runs (`moduleBuilds.ts`); absent from an older host. */
      build: buildDetailsSchema.nullable().default(null).catch(null),
    })
    .parse(await response.json())
}

/** What the update came to for the module itself — `ModuleOutcome` in `server/server.ts`. */
const moduleOutcomeSchema = z.union([
  z.object({ ran: z.enum(['page', 'restarted', 'started', 'idle']) }),
  z.object({ ran: z.literal('stale'), why: z.string(), kept: z.boolean().optional() }),
  z.object({ ran: z.literal('failed'), why: z.string(), detail: z.array(z.string()).default([]) }),
])

export type ModuleOutcome = z.infer<typeof moduleOutcomeSchema>

const updatedSchema = z.object({
  checkout: readingSchema,
  changed: z.array(z.string()),
  installed: z.boolean(),
  installFailed: z.string().nullable(),
  lockfileReset: z.boolean().optional(),
  /** Only ever the host's own checkout: a module is restarted by the update itself. */
  restart: z.enum(['host']).nullable(),
  module: moduleOutcomeSchema.nullable().default(null),
})

export type Updated = z.infer<typeof updatedSchema>

/**
 * Raised when the request was closed after the checkout had already moved.
 * The server finishes such an update on its own, so the caller must read what
 * is true rather than say it was not changed.
 */
export class LeftRunning extends Error {}

/**
 * Fast-forward one checkout, and restart its module when that is needed.
 *
 * The answer is a stream of lines: `{phase}` as the server moves from the
 * merge to an install to a restart — told to `onPhase` — then `{done}` or
 * `{error}`. Refusals come back as the server's sentence.
 */
export async function applyUpdate(id: string, signal?: AbortSignal, onPhase?: (phase: Phase) => void): Promise<Updated> {
  const response = await fetch('/host/updates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
    signal,
  })
  if (!response.ok) throw new Error(await reason(response))
  let moved = false
  let ended: Updated | null = null
  const take = (line: string) => {
    if (!line.trim()) return
    const said = z
      .object({ phase: phaseSchema.optional(), done: updatedSchema.optional(), error: z.string().optional() })
      .parse(JSON.parse(line))
    if (said.error !== undefined) throw new Error(said.error)
    if (said.phase) {
      if (said.phase !== 'updating') moved = true
      onPhase?.(said.phase)
    }
    if (said.done) ended = said.done
  }
  try {
    const reader = response.body?.getReader()
    if (!reader) for (const line of (await response.text()).split('\n')) take(line)
    else {
      const decoder = new TextDecoder()
      let held = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        held += decoder.decode(value, { stream: true })
        const lines = held.split('\n')
        held = lines.pop() ?? ''
        for (const line of lines) take(line)
      }
      take(held)
    }
  } catch (error) {
    if (signal?.aborted && moved) throw new LeftRunning()
    throw error
  }
  if (!ended) throw new Error('the update ended without saying what it came to')
  return ended
}

/** Why a restart did not leave the module answering. `kept`: its registration says to keep it, and "Restart anyway" is the way on. */
export interface NotRestarted {
  why: string
  detail: string[]
  kept?: boolean
}

/** What `/host/start` and `/host/restart-anyway` answer a restart with: null when the module answers. */
async function restarted(response: Response): Promise<NotRestarted | null> {
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean
    why?: string
    detail?: string[]
    kept?: boolean
    presence?: { condition?: string } | null
  } | null
  if (body?.ok && body.presence?.condition === 'ready') return null
  const detail = Array.isArray(body?.detail) ? body.detail : []
  if (body?.ok) return { why: 'It was started and has not answered yet.', detail }
  return {
    why: body?.why ?? 'it could not be restarted, and the host did not say why',
    detail,
    ...(body?.kept === true ? { kept: true } : {}),
  }
}

/**
 * Start a module again after an update that could not — the retry on its row.
 * The same Start the canvas offers. Null when it answers; otherwise why not,
 * with the last it printed when the host has that.
 */
export async function restartModule(id: string): Promise<NotRestarted | null> {
  const response = await fetch('/host/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ module: id }),
  })
  return restarted(response)
}

/** A first press the server is holding: what it says will be stopped and lost, and for how long it stands. */
export interface Armed {
  token: string
  sentence: string
  forMs: number
}

/**
 * The first press of "Restart anyway", on a module whose registration says to
 * keep it: the server names the process it would stop and stops nothing — see
 * `server/anyway.ts`. A refusal is its sentence.
 */
export async function armRestartAnyway(id: string): Promise<{ armed: Armed } | NotRestarted> {
  const response = await fetch('/host/restart-anyway', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ module: id, press: 'arm' }),
  })
  const body = (await response.json().catch(() => null)) as { ok?: boolean; why?: string; kept?: boolean; armed?: Partial<Armed> } | null
  const armed = body?.armed
  if (body?.ok && armed && typeof armed.token === 'string' && typeof armed.sentence === 'string' && typeof armed.forMs === 'number') {
    return { armed: { token: armed.token, sentence: armed.sentence, forMs: armed.forMs } }
  }
  return {
    why: body?.why ?? 'the host did not say whether it could be restarted',
    detail: [],
    ...(body?.kept === true ? { kept: true } : {}),
  }
}

/** The second press: stop the process the first one named and start the module again. Null when it answers. */
export async function confirmRestartAnyway(id: string, token: string): Promise<NotRestarted | null> {
  const response = await fetch('/host/restart-anyway', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ module: id, press: 'confirm', token }),
  })
  return restarted(response)
}

/** Ask the desktop app to restart, so an updated host server runs. Null when it was asked. */
export async function requestRestart(): Promise<string | null> {
  const response = await fetch('/host/restart', { method: 'POST' })
  return response.ok ? null : await reason(response)
}

/**
 * Whether a checkout has something for an update to do: a newer release for an
 * installed copy that runs releases, new commits on its branch for anything
 * else. The same rule as `hasUpdate` in `server/updates.ts`.
 */
export function hasUpdate(one: Pick<Checkout, 'behind' | 'release'>): boolean {
  return one.release && one.release.follows !== 'main' ? one.release.target !== null : one.behind > 0
}

/** Whether a checkout runs releases (rather than following a branch). */
export function runsReleases(one: Pick<Checkout, 'release'>): boolean {
  return one.release !== undefined && one.release.follows !== 'main'
}

/**
 * How many commits, across everything, are waiting. A copy that runs releases
 * counts the commits up to its newer release, and at least one: moving onto a
 * release at the commit it is already on is still an update.
 */
export function waiting(checkouts: readonly Reading[], pins: Readonly<Record<string, PinCount>> = {}): number {
  /* A module with pinned containers is not counted: those containers run the
     version they were pinned to, whatever its checkout is behind by. */
  return checkouts.reduce((sum, one) => {
    if (!isCheckout(one) || Object.hasOwn(pins, one.id) || !hasUpdate(one)) return sum
    return sum + (runsReleases(one) ? Math.max(1, one.behind) : one.behind)
  }, 0)
}

/** "just now", "4 minutes ago", "2 hours ago", or a date. */
export function ago(then: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return `on ${then.toLocaleDateString()}`
}

async function reason(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null
  if (body && typeof body.error === 'string') return body.error
  return `the host's server answered ${response.status}`
}

/**
 * What pressing Update in the panel came to, for one checkout.
 *
 * `restart` is only ever about the HOST's own checkout: a module is restarted
 * by the update itself, so there is no outcome that waits on one. `retry` is a
 * module that was updated and did not come back, which can be started again.
 */
export type Outcome =
  | { kind: 'updated'; note: string; restart: 'host' | null; installFailed: string | null }
  | { kind: 'failed'; why: string; detail?: string[]; retry?: boolean; /** Refused because it is kept: "Restart anyway" is offered. */ kept?: boolean }

/**
 * Whether a checkout gets a row of its own in the panel: it is behind, it
 * could not be read, GitHub could not be reached for it, something was just
 * done to it, or the server says something is (`flagged`: an update still
 * running, or a module left on old code). Everything else is level and quiet.
 */
export function needsAttention(reading: Reading, outcome: Outcome | null | undefined, flagged = false): boolean {
  if (outcome || flagged) return true
  if (!isCheckout(reading)) return true
  return hasUpdate(reading) || reading.fetchFailed !== null || reading.waiting === true
}

/** The checkouts that need a person, most pressing first, and the level rest. */
export function triage(
  checkouts: readonly Reading[],
  outcomes: Readonly<Record<string, Outcome>>,
  flagged: ReadonlySet<string> = new Set(),
): { attention: Reading[]; level: Checkout[] } {
  const attention: Reading[] = []
  const level: Checkout[] = []
  for (const one of checkouts) {
    if (needsAttention(one, outcomes[one.id], flagged.has(one.id))) attention.push(one)
    else if (isCheckout(one)) level.push(one)
  }
  attention.sort((a, b) => weight(b) - weight(a))
  return { attention, level }
}

/* What needs a person first: new commits, then what could not be read, then
   what GitHub could not be asked about, then what was just updated. */
function weight(one: Reading): number {
  if (!isCheckout(one)) return 2
  if (hasUpdate(one)) return 3
  return one.fetchFailed || one.waiting ? 1 : 0
}

/** Whether "Restart Kehikot" is offered for an outcome: the host's server changed and the app can restart it. */
export function offersAppRestart(outcome: Outcome | null | undefined, restartable: boolean): boolean {
  return restartable && outcome?.kind === 'updated' && outcome.restart === 'host'
}
