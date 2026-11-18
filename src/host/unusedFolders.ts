import { z } from 'zod'

import { pathSaid } from './development.ts'

/**
 * "Move unused folders to the Trash": after development is switched off, the folders Kehikot no
 * longer uses are the person's to keep or to clear. This is the words and shapes the page and the
 * server share; the checks and the moving are `server/unusedFolders.ts`.
 *
 * ## From the person's side
 *
 * One press, one list: every folder, its size, and either "will go to the Trash" or why it is kept
 * (it has changes not committed, commits not pushed, or something still uses it). Nothing that
 * fails a check is ever offered. The Trash, never a delete: it can be put back from there.
 */

export const unusedFolderSchema = z.object({
  dir: z.string(),
  bytes: z.number(),
  /** Whether it will go to the Trash. */
  trash: z.boolean(),
  /** Why it is kept, when it is. */
  why: z.string().nullable(),
  /** Whether this is a folder of worktrees beside a checkout. */
  worktrees: z.boolean(),
})
export type UnusedFolder = z.infer<typeof unusedFolderSchema>

export const unusedListSchema = z.object({ folders: z.array(unusedFolderSchema), freedBytes: z.number() })
export type UnusedList = z.infer<typeof unusedListSchema>

export const trashedSchema = z.object({
  moved: z.array(z.object({ dir: z.string(), bytes: z.number() })),
  kept: z.array(z.object({ dir: z.string(), why: z.string() })),
})
export type Trashed = z.infer<typeof trashedSchema>

export const TRASH_BUTTON = 'Move unused folders to the Trash'

/** A size as a person reads it: 3.1 GB, 240 MB, 12 KB. */
export function sizeSaid(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

/** What one folder's line says it will do. */
export function verdictSaid(one: UnusedFolder): string {
  return one.trash ? 'will go to the Trash' : `kept: ${one.why ?? 'it did not pass a check'}`
}

/** What was done: "12 folders moved to the Trash, 3.1 GB; 2 kept: ~/a (has uncommitted changes), ~/b (...)". */
export function trashedSaid(done: Trashed, home: string | null): string {
  const bytes = done.moved.reduce((sum, one) => sum + one.bytes, 0)
  const parts: string[] = []
  if (done.moved.length) parts.push(`${done.moved.length} folder${done.moved.length === 1 ? '' : 's'} moved to the Trash, ${sizeSaid(bytes)}`)
  else parts.push('Nothing was moved to the Trash')
  if (done.kept.length) parts.push(`${done.kept.length} kept: ${done.kept.map((one) => `${pathSaid(one.dir, home)} (${one.why})`).join(', ')}`)
  return `${parts.join('; ')}.`
}

async function said(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null
  return typeof body?.error === 'string' ? body.error : `Kehikot answered ${response.status}.`
}

/** Every folder Kehikot no longer uses, each checked now. Moves nothing. */
export async function fetchUnused(signal?: AbortSignal): Promise<UnusedList> {
  const response = await fetch('/host/unused-folders', { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(await said(response))
  return unusedListSchema.parse(await response.json())
}

/** Move these to the Trash (each is checked again first, and one that fails is kept). */
export async function trashUnused(dirs: string[]): Promise<Trashed> {
  const response = await fetch('/host/unused-folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trash: dirs }) })
  if (!response.ok) throw new Error(await said(response))
  return trashedSchema.parse(await response.json())
}
