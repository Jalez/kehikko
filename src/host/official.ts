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
})

export type Installing = z.infer<typeof installingSchema>
export type OfficialModule = z.infer<typeof moduleSchema>

export async function fetchOfficial(signal?: AbortSignal): Promise<OfficialModule[]> {
  const response = await fetch('/host/official', { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(await reason(response))
  return z.object({ modules: z.array(moduleSchema) }).parse(await response.json()).modules
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
