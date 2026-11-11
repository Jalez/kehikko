import { z } from 'zod'

/**
 * What a tracker source reads (Jalez/kehikko#318): which kinds of item, which
 * states, and whether a read asks only for what changed since the last one.
 * Pure — no React, no server — and shared by the tracker panel, the server's
 * reading and its one writer of `trackers.json`, so all three say and decide
 * the same thing.
 *
 * ## In the file
 *
 * An entry of the project's `trackers.json` (`server/trackers/sources.ts`) may carry `reads`:
 *
 * ```json
 * { "tracker": "gitlab", "host": "gitlab.example.org", "repo": "group/project",
 *   "reads": { "kinds": ["issues", "changes"], "closed": 30, "since": true } }
 * ```
 *
 * - `kinds`: any of `issues`, `tasks` (a GitLab work item type) and `changes`
 *   (merge or pull requests). Absent: all of them.
 * - `closed`: `false` reads open items only; a number of days reads open items
 *   and the ones closed or merged within that many days; `true` or absent reads
 *   every state.
 * - `since`: after a whole read, each read asks only for what was updated since
 *   the last one and merges it into the rows held. Absent: off.
 *
 * Additive: an older host strips the key and reads everything, as it always
 * did. A `reads` this host cannot make sense of is ignored, never a reason to
 * call the whole file broken.
 *
 * A ref somebody named — in an epic, by a module, a row a person picked — is
 * always read by name, whatever the source's `reads` leaves out.
 */

export const READ_KINDS = ['issues', 'tasks', 'changes'] as const
export type ReadKind = (typeof READ_KINDS)[number]

/** The look-back windows the panel offers for closed items, in days. */
export const CLOSED_CHOICES = [7, 30, 90] as const
/** The longest look-back window the file may say, in days. */
const CLOSED_MAX_DAYS = 3650

/** `reads` as written in the file and sent by the page. */
export const readsSchema = z.object({
  kinds: z.array(z.enum(READ_KINDS)).min(1).max(READ_KINDS.length).optional(),
  closed: z.union([z.boolean(), z.number().int().min(1).max(CLOSED_MAX_DAYS)]).optional(),
  since: z.boolean().optional(),
})
export type ReadsWritten = z.infer<typeof readsSchema>

/** What a source reads, every choice made. */
export interface Reads {
  kinds: ReadKind[]
  /** `true`: every state. `false`: open only. A number: open, and closed within that many days. */
  closed: boolean | number
  since: boolean
}

export const READS_DEFAULT: Reads = { kinds: [...READ_KINDS], closed: true, since: false }

/** `reads` from the file or the page, each choice it does not make at its default. Null for what is not one. */
export function readsOf(written: unknown): Reads | null {
  const parsed = readsSchema.safeParse(written)
  if (!parsed.success) return null
  const kinds = parsed.data.kinds ? READ_KINDS.filter((k) => parsed.data.kinds!.includes(k)) : [...READ_KINDS]
  return { kinds, closed: parsed.data.closed ?? true, since: parsed.data.since ?? false }
}

/** Whether these are the defaults: a source that reads everything, whole, every time. */
export function isDefaultReads(reads: Reads | null | undefined): boolean {
  if (!reads) return true
  return reads.kinds.length === READ_KINDS.length && reads.closed === true && !reads.since
}

/** `reads` as the file keeps it: only the choices that differ from the defaults; null when none do. */
export function writtenReads(reads: Reads): ReadsWritten | null {
  if (isDefaultReads(reads)) return null
  return {
    ...(reads.kinds.length === READ_KINDS.length ? {} : { kinds: [...reads.kinds] }),
    ...(reads.closed === true ? {} : { closed: reads.closed }),
    ...(reads.since ? { since: true } : {}),
  }
}

/** A stable spelling of a source's reads: a change of it means the next read is a whole one. */
export function readsKey(reads: Reads | null | undefined): string {
  const r = reads ?? READS_DEFAULT
  return `${r.kinds.join(',')}|${String(r.closed)}`
}

/** The tracker's word for a change. */
export const changesWord = (tracker: 'github' | 'gitlab') => (tracker === 'github' ? 'pull requests' : 'merge requests')

/** The kinds a tracker has: tasks are a GitLab work item type. */
export const kindsFor = (tracker: 'github' | 'gitlab'): ReadKind[] => (tracker === 'github' ? ['issues', 'changes'] : [...READ_KINDS])

/** One kind as a person reads it. */
export function kindSaid(kind: ReadKind, tracker: 'github' | 'gitlab'): string {
  return kind === 'changes' ? changesWord(tracker) : kind
}

/** What a source reads, in words: "issues and merge requests, open and closed in the last 30 days, only what changed". */
export function readsSaid(reads: Reads | null | undefined, tracker: 'github' | 'gitlab'): string {
  const r = reads ?? READS_DEFAULT
  const has = kindsFor(tracker)
  const kinds = r.kinds.filter((k) => has.includes(k))
  const what = kinds.length === has.length || !kinds.length ? 'everything' : kinds.map((k) => kindSaid(k, tracker)).join(' and ')
  const states = r.closed === true ? 'in every state' : r.closed === false ? 'open only' : `open, and closed in the last ${r.closed} days`
  return `${what}, ${states}${r.since ? ', only what changed since the last read' : ''}`
}

/** What a row has to say for `inScope`. */
export interface ScopedRow {
  kind: 'issue' | 'change'
  workItem?: string
  state: string
  updatedAt?: string | null
  closedAt?: string | null
  mergedAt?: string | null
}

/** Which of `READ_KINDS` a row is. */
export const kindOf = (row: Pick<ScopedRow, 'kind' | 'workItem'>): ReadKind =>
  row.kind === 'change' ? 'changes' : row.workItem === 'task' ? 'tasks' : 'issues'

/** The instant a closed window counts from, for a read at `now`. Null when `closed` is not a window. */
export function closedSince(reads: Reads, now: number): string | null {
  return typeof reads.closed === 'number' ? new Date(now - reads.closed * 86_400_000).toISOString() : null
}

/**
 * Whether a source's listing would hold this row: its kind is read, and it is
 * open or closed in a way the source reads. A row outside is kept only while
 * somebody names it.
 */
export function inScope(row: ScopedRow, reads: Reads | null | undefined, now: number): boolean {
  const r = reads ?? READS_DEFAULT
  if (!r.kinds.includes(kindOf(row))) return false
  if (row.state === 'open' || r.closed === true) return true
  if (r.closed === false) return false
  const at = row.mergedAt ?? row.closedAt ?? row.updatedAt
  if (!at) return true
  return Date.parse(at) >= now - r.closed * 86_400_000
}
