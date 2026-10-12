import { z } from 'zod'

/**
 * The page's side of the official module list: what is on it, installing one
 * that is not on this machine, and proposing a module for it. See
 * `server/official.ts`, `server/installs.ts` and `server/proposals.ts`.
 * Refusals arrive as the server's sentence.
 */

const installingSchema = z.union([
  z.object({ state: z.literal('installing'), step: z.enum(['cloning', 'installing', 'registering']) }),
  z.object({ state: z.literal('failed'), why: z.string() }),
])

const moduleSchema = z.object({
  id: z.string(),
  name: z.string(),
  repo: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  installed: z.boolean(),
  install: installingSchema.optional(),
  /* The entry asks for a newer protocol package than this host has. */
  newer: z.object({ protocol: z.string(), has: z.string() }).optional(),
  /* Installed from another repository than the list now names: that repository. */
  from: z.string().optional(),
})

/* How current the list is: when it was last read from where it is published
   (null when only the one the app came with is in use), and whether the last
   ask failed. Absent from a host that only has the list it was built with. */
const standingSchema = z.object({ fetched: z.string().nullable(), stale: z.boolean() })
export type ListStanding = z.infer<typeof standingSchema>

export type Installing = z.infer<typeof installingSchema>
export type OfficialModule = z.infer<typeof moduleSchema>

export async function fetchOfficial(signal?: AbortSignal): Promise<{ modules: OfficialModule[]; standing: ListStanding | null }> {
  const response = await fetch('/host/official', { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(await reason(response))
  const read = z.object({ modules: z.array(moduleSchema), list: standingSchema.optional() }).parse(await response.json())
  return { modules: read.modules, standing: read.list ?? null }
}

/** The one quiet line under the module list when the official list could not be refreshed; null when there is nothing to say. */
export function staleLine(standing: ListStanding | null): string | null {
  if (!standing?.stale) return null
  if (!standing.fetched) return 'The official module list could not be refreshed. Showing the one this app came with.'
  const when = new Date(standing.fetched)
  const day = Number.isNaN(when.getTime()) ? null : when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  return `The official module list could not be refreshed. Showing the one read${day ? ` on ${day}` : ' earlier'}.`
}

/** Start installing one official module. It returns at once; the list says how it is going. */
export async function installOfficial(id: string): Promise<void> {
  const response = await post('/host/official/install', id)
  if (!response.ok) throw new Error(await reason(response))
}

const proposalSchema = z.object({ url: z.string(), number: z.number(), existing: z.boolean() })
export type Proposal = z.infer<typeof proposalSchema>

/** File a proposal for a registered module, or be handed the one already open. */
export async function proposeModule(id: string): Promise<Proposal> {
  const response = await post('/host/official/propose', id)
  if (!response.ok) throw new Error(await reason(response))
  return proposalSchema.parse(await response.json())
}

function post(path: string, module: string): Promise<Response> {
  return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ module }) })
}

async function reason(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null
  if (body && typeof body.error === 'string') return body.error
  return `the host's server answered ${response.status}`
}
