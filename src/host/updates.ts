import { z } from 'zod'

/**
 * Whether the host and its modules are behind GitHub — the page's side of
 * `server/updates.ts`, which has the rules. Every call takes a signal, because
 * the panel's Cancel is a real cancel: closing the request stops the git the
 * server was running for it.
 */

const incomingSchema = z.object({ hash: z.string(), subject: z.string() })

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
  blocked: z.string().nullable(),
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
}

/** What an update is doing right now. */
/** `applying` is the checkout having moved: from there nothing is cancelled. */
export type Phase = 'updating' | 'applying' | 'installing' | 'restarting'
const phaseSchema = z.enum(['updating', 'applying', 'installing', 'restarting'])

export function isCheckout(reading: Reading): reading is Checkout {
  return !('error' in reading)
}

/** Read every checkout; `fetch` asks GitHub first, which is the slow part. */
export async function fetchUpdates(fetch: boolean, signal?: AbortSignal): Promise<Check> {
  const response = await globalThis.fetch(`/host/updates${fetch ? '?fetch=1' : ''}`, { signal })
  if (!response.ok) throw new Error(await reason(response))
  const body = z
    .object({
      checked: z.string(),
      checkouts: z.array(readingSchema),
      restartable: z.boolean().default(false),
      pins: z.record(z.string(), z.object({ containers: z.number(), versions: z.array(z.string()) })).default({}),
      progress: z.record(z.string(), phaseSchema).default({}),
      stale: z.record(z.string(), z.string()).default({}),
    })
    .parse(await response.json())
  return {
    checked: new Date(body.checked),
    checkouts: body.checkouts,
    restartable: body.restartable,
    pins: body.pins,
    progress: body.progress,
    stale: body.stale,
  }
}

/** What the update came to for the module itself — `ModuleOutcome` in `server/server.ts`. */
const moduleOutcomeSchema = z.union([
  z.object({ ran: z.enum(['page', 'restarted', 'started', 'idle']) }),
  z.object({ ran: z.literal('stale'), why: z.string() }),
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

/**
 * Start a module again after an update that could not — the retry on its row.
 * The same Start the canvas offers. Null when it answers; otherwise why not,
 * with the last it printed when the host has that.
 */
export async function restartModule(id: string): Promise<{ why: string; detail: string[] } | null> {
  const response = await fetch('/host/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ module: id }),
  })
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean
    why?: string
    detail?: string[]
    presence?: { condition?: string } | null
  } | null
  if (body?.ok && body.presence?.condition === 'ready') return null
  const detail = Array.isArray(body?.detail) ? body.detail : []
  if (body?.ok) return { why: 'It was started and has not answered yet.', detail }
  return { why: body?.why ?? 'it could not be restarted, and the host did not say why', detail }
}

/** Ask the desktop app to restart, so an updated host server runs. Null when it was asked. */
export async function requestRestart(): Promise<string | null> {
  const response = await fetch('/host/restart', { method: 'POST' })
  return response.ok ? null : await reason(response)
}

/** How many commits, across everything, are waiting. */
export function waiting(checkouts: readonly Reading[], pins: Readonly<Record<string, PinCount>> = {}): number {
  /* A module with pinned containers is not counted: those containers run the
     version they were pinned to, whatever its checkout is behind by. */
  return checkouts.reduce((sum, one) => sum + (isCheckout(one) && !Object.hasOwn(pins, one.id) ? one.behind : 0), 0)
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
  | { kind: 'failed'; why: string; detail?: string[]; retry?: boolean }

/**
 * Whether a checkout gets a row of its own in the panel: it is behind, it
 * could not be read, GitHub could not be reached for it, something was just
 * done to it, or the server says something is (`flagged`: an update still
 * running, or a module left on old code). Everything else is level and quiet.
 */
export function needsAttention(reading: Reading, outcome: Outcome | null | undefined, flagged = false): boolean {
  if (outcome || flagged) return true
  if (!isCheckout(reading)) return true
  return reading.behind > 0 || reading.fetchFailed !== null
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
  if (one.behind > 0) return 3
  return one.fetchFailed ? 1 : 0
}

/** Whether "Restart Kehikot" is offered for an outcome: the host's server changed and the app can restart it. */
export function offersAppRestart(outcome: Outcome | null | undefined, restartable: boolean): boolean {
  return restartable && outcome?.kind === 'updated' && outcome.restart === 'host'
}
