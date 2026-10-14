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
const standingSchema = z.object({ fetched: z.string().nullable(), stale: z.boolean(), off: z.boolean().optional(), repo: z.string().optional() })
export type ListStanding = z.infer<typeof standingSchema>

export type Installing = z.infer<typeof installingSchema>
export type OfficialModule = z.infer<typeof moduleSchema>

export async function fetchOfficial(signal?: AbortSignal): Promise<{ modules: OfficialModule[]; standing: ListStanding | null }> {
  const response = await fetch('/host/official', { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(await reason(response))
  const read = z.object({ modules: z.array(moduleSchema), list: standingSchema.optional() }).parse(await response.json())
  return { modules: read.modules, standing: read.list ?? null }
}

/**
 * The one sentence under the module list when the official list is not the
 * current one; null when there is nothing to say. Three cases: the machine
 * switched asking off; asking failed with an earlier answer kept (say how
 * old); asking failed and there is none.
 */
export function staleLine(standing: ListStanding | null, now: number = Date.now()): string | null {
  if (!standing) return null
  const from = standing.repo ? ` It comes from ${standing.repo.replace(/^https?:\/\//, '')}.` : ''
  if (standing.off) {
    return `The official module list is switched off on this machine, so only the modules this app came with are shown. Nothing to do.${from}`
  }
  if (!standing.stale) return null
  if (!standing.fetched) {
    return `The official module list could not be reached, so only the modules this app came with are shown. Check the connection; it is asked again when this opens.${from}`
  }
  const read = new Date(standing.fetched).getTime()
  const age = Number.isNaN(read) ? 'earlier' : ageOf(now - read)
  return `The official module list could not be refreshed, so the one read ${age} is shown. Check the connection; it is asked again when this opens.${from}`
}

function ageOf(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return `${Math.round(hours / 24)} days ago`
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
