import { z } from 'zod'

import { moduleSchema, type OfficialModule } from './official.ts'

/**
 * The page's side of "My modules": the modules this person installed from a
 * repository that is on no official list. See `server/myModules.ts`. Every
 * write here is a route only this page may send (`PAGE_ONLY`); refusals
 * arrive as the server's sentence.
 */

const adoptableSchema = z.object({
  id: z.string(),
  name: z.string(),
  from: z.string(),
  moves: z.object({ from: z.number().nullable(), to: z.number() }).optional(),
})
export type Adoptable = z.infer<typeof adoptableSchema>

export interface MineList {
  modules: OfficialModule[]
  adoptable: Adoptable[]
  broken: string | null
}

/** The person's list and what could be kept. Null from a host that has no such list. */
export async function fetchMine(signal?: AbortSignal): Promise<MineList | null> {
  const response = await fetch('/host/mine', { signal, cache: 'no-store' })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(await reason(response))
  const read = z
    .object({ modules: z.array(moduleSchema), adoptable: z.array(adoptableSchema), broken: z.string().optional() })
    .parse(await response.json())
  return { modules: read.modules, adoptable: read.adoptable, broken: read.broken ?? null }
}

const checkedSchema = z.union([
  z.object({ ok: z.literal(true), kind: z.literal('official'), id: z.string(), name: z.string(), summary: z.string(), repo: z.string(), installed: z.boolean() }),
  z.object({
    ok: z.literal(true),
    kind: z.literal('mine'),
    id: z.string(),
    name: z.string(),
    summary: z.string(),
    tags: z.array(z.string()),
    repo: z.string(),
    host: z.string(),
    protocol: z.string().optional(),
    newer: z.object({ protocol: z.string(), has: z.string() }).optional(),
    private: z.boolean(),
  }),
])
export type Checked = z.infer<typeof checkedSchema>

/** Read a repository with the person's login and say what module it holds. Nothing is written. */
export async function checkRepository(repo: string): Promise<Checked> {
  const response = await post('/host/mine/check', { repo })
  if (!response.ok) throw new Error(await reason(response))
  return checkedSchema.parse(await response.json())
}

/** Add the repository to My modules and start installing it (or install the official module it is). */
export async function addRepository(repo: string): Promise<void> {
  const response = await post('/host/mine/add', { repo })
  if (!response.ok) throw new Error(await reason(response))
}

/** Install one of the person's modules again. */
export async function installMine(id: string): Promise<void> {
  const response = await post('/host/mine/install', { module: id })
  if (!response.ok) throw new Error(await reason(response))
}

/** Stop one of the person's modules, delete its installed copy and registration, and forget it. */
export async function removeMine(id: string): Promise<void> {
  const response = await post('/host/mine/remove', { module: id })
  if (!response.ok) throw new Error(await reason(response))
}

/** Keep a module installed by hand as one of the person's own. */
export async function adoptMine(id: string): Promise<void> {
  const response = await post('/host/mine/adopt', { module: id })
  if (!response.ok) throw new Error(await reason(response))
}

/** How a repository is named: `owner/repo` on GitHub, `host/group/repo` anywhere else. */
export function repoSaid(entry: Pick<OfficialModule, 'repo' | 'host'>): string {
  return !entry.host || entry.host === 'github.com' ? entry.repo : `${entry.host}/${entry.repo}`
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function reason(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null
  if (body && typeof body.error === 'string') return body.error
  return `the host's server answered ${response.status}`
}
