import { z } from 'zod'

/**
 * The page's side of `server/feedback.ts`: a module's GitHub issues opened by
 * this person, and a new one. Refusals arrive as the server's sentence.
 */

const statusSchema = z.enum(['open', 'completed', 'not planned', 'closed'])

const itemSchema = z.object({
  number: z.number(),
  title: z.string(),
  status: statusSchema,
  url: z.string(),
  updatedAt: z.string(),
})

const listingSchema = z.object({ repo: z.string(), items: z.array(itemSchema) })

export type Status = z.infer<typeof statusSchema>
export type Item = z.infer<typeof itemSchema>
export type Listing = z.infer<typeof listingSchema>

/* The last listing per module, so a menu opened a second time draws at once
   while it asks again. */
const seen = new Map<string, Listing>()

export function cachedFeedback(module: string): Listing | null {
  return seen.get(module) ?? null
}

export async function fetchFeedback(module: string, signal?: AbortSignal): Promise<Listing> {
  const response = await fetch(`/host/feedback?module=${encodeURIComponent(module)}`, { signal })
  if (!response.ok) throw new Error(await reason(response))
  const listing = listingSchema.parse(await response.json())
  seen.set(module, listing)
  return listing
}

export interface Draft {
  module: string
  title: string
  body: string
  kehikko: string | null
  epic: string | null
}

/** File one issue; the new item is put at the top of the kept listing. */
export async function sendFeedback(draft: Draft): Promise<Item> {
  const response = await fetch('/host/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  })
  if (!response.ok) throw new Error(await reason(response))
  const { repo, item } = z.object({ repo: z.string(), item: itemSchema }).parse(await response.json())
  const was = seen.get(draft.module)
  seen.set(draft.module, { repo, items: [item, ...(was?.items ?? []).filter((one) => one.number !== item.number)] })
  return item
}

async function reason(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null
  if (body && typeof body.error === 'string') return body.error
  return `the host's server answered ${response.status}`
}
