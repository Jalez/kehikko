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

export interface Check {
  checked: Date
  checkouts: Reading[]
  /** Whether the desktop app can restart this host — see `/host/restart`. */
  restartable: boolean
}

export function isCheckout(reading: Reading): reading is Checkout {
  return !('error' in reading)
}

/** Read every checkout; `fetch` asks GitHub first, which is the slow part. */
export async function fetchUpdates(fetch: boolean, signal?: AbortSignal): Promise<Check> {
  const response = await globalThis.fetch(`/host/updates${fetch ? '?fetch=1' : ''}`, { signal })
  if (!response.ok) throw new Error(await reason(response))
  const body = z
    .object({ checked: z.string(), checkouts: z.array(readingSchema), restartable: z.boolean().default(false) })
    .parse(await response.json())
  return { checked: new Date(body.checked), checkouts: body.checkouts, restartable: body.restartable }
}

const updatedSchema = z.object({
  checkout: readingSchema,
  changed: z.array(z.string()),
  installed: z.boolean(),
  installFailed: z.string().nullable(),
  restart: z.enum(['host', 'module']).nullable(),
})

export type Updated = z.infer<typeof updatedSchema>

/** Fast-forward one checkout. Refusals come back as the server's sentence. */
export async function applyUpdate(id: string, signal?: AbortSignal): Promise<Updated> {
  const response = await fetch('/host/updates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
    signal,
  })
  if (!response.ok) throw new Error(await reason(response))
  return updatedSchema.parse(await response.json())
}

/** Restart a module so it runs what was pulled — the same Start the canvas offers. */
export async function restartModule(id: string): Promise<string | null> {
  const response = await fetch('/host/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ module: id }),
  })
  const body = (await response.json().catch(() => null)) as { ok?: boolean; why?: string } | null
  return body?.ok ? null : (body?.why ?? 'it could not be restarted, and the host did not say why')
}

/** Ask the desktop app to restart, so an updated host server runs. Null when it was asked. */
export async function requestRestart(): Promise<string | null> {
  const response = await fetch('/host/restart', { method: 'POST' })
  return response.ok ? null : await reason(response)
}

/** How many commits, across everything, are waiting. */
export function waiting(checkouts: readonly Reading[]): number {
  return checkouts.reduce((sum, one) => sum + (isCheckout(one) ? one.behind : 0), 0)
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

/** What pressing Update or Restart in the panel came to, for one checkout. */
export type Outcome =
  | { kind: 'updated'; note: string; restart: 'host' | 'module' | null; installFailed: string | null }
  | { kind: 'failed'; why: string }
  | { kind: 'restarted' }

/**
 * Whether a checkout gets a row of its own in the panel: it is behind, it
 * could not be read, GitHub could not be reached for it, or something was just
 * done to it. Everything else is level and quiet, and is only counted.
 */
export function needsAttention(reading: Reading, outcome: Outcome | null | undefined): boolean {
  if (outcome) return true
  if (!isCheckout(reading)) return true
  return reading.behind > 0 || reading.fetchFailed !== null
}

/** The checkouts that need a person, most pressing first, and the level rest. */
export function triage(
  checkouts: readonly Reading[],
  outcomes: Readonly<Record<string, Outcome>>,
): { attention: Reading[]; level: Checkout[] } {
  const attention: Reading[] = []
  const level: Checkout[] = []
  for (const one of checkouts) {
    if (needsAttention(one, outcomes[one.id])) attention.push(one)
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
