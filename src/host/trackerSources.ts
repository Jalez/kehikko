import { z } from 'zod'

/**
 * A project's tracker sources as a person is told about them, in one place.
 *
 * The panel in the bar and the MCP tool both say what a source is for and what
 * it is doing, and they must say it in the same words — so the words are here,
 * with no React and no server in them, and both import them.
 */

export const trackerNames = ['github', 'gitlab'] as const

export const listedSourceSchema = z.object({
  tracker: z.enum(trackerNames),
  host: z.string(),
  repo: z.string(),
  default: z.boolean(),
  listed: z.boolean(),
  origin: z.enum(['remote', 'file']),
  remote: z.string().nullable(),
  off: z.boolean(),
  at: z.string().nullable(),
  error: z.string().nullable(),
  issues: z.number().nullable(),
  changes: z.number().nullable(),
})
export type ListedSource = z.infer<typeof listedSourceSchema>

export const trackerListingSchema = z.object({
  sources: z.array(listedSourceSchema),
  /** Whether the project's git remotes are read at all. */
  remotes: z.boolean(),
  /** Minutes between scheduled reads; 0 is off. */
  every: z.number(),
  /** The file would not read: where, and why. Nothing else in the listing is then the file's. */
  broken: z.object({ file: z.string(), why: z.string() }).nullable(),
})
export type TrackerListing = z.infer<typeof trackerListingSchema>

/** The schedule's choices, in minutes. */
export const EVERY_CHOICES = [0, 5, 15, 30, 60] as const

/** What the whole thing is for, said once at the top of the panel and in the tool's answer. */
export const TRACKERS_ARE_FOR =
  'Where references like gh#41 or !7 are looked up. Every module that shows issues or changes reads from here.'

/** A source as a person writes it: the repository, with its host when it is not the usual one. */
export function sourceName(s: Pick<ListedSource, 'host' | 'repo'>): string {
  return s.host === 'github.com' || s.host === 'gitlab.com' ? s.repo : `${s.host}/${s.repo}`
}

/** The short spellings a default source answers to. */
export function defaultFor(tracker: ListedSource['tracker']): string {
  return tracker === 'github' ? 'gh#12' : '#12 and !7'
}

/** What a source is for, in words, in the order a person needs them. */
export function rolesOf(s: ListedSource): string[] {
  if (s.off) {
    return [s.origin === 'remote' ? `turned off — this project's git remote ${s.remote ?? ''} names it`.replace('  ', ' ') : 'turned off']
  }
  const out: string[] = []
  out.push(s.origin === 'remote' ? `from this project's git remote ${s.remote ?? ''}`.trim() : 'added by you')
  if (s.default) out.push(`the default for ${defaultFor(s.tracker)}`)
  out.push(s.listed ? 'recent issues and changes are listed' : 'read only for the refs that name it')
  return out
}

/** How long ago, in the words a strip has room for. */
export function ago(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** What it last read: "12 issues, 3 changes, 4 min ago", or why it could not. */
export function readSaid(s: ListedSource, now: number): string {
  if (s.off) return ''
  if (!s.at) return 'not read yet'
  const counts =
    s.issues === null && s.changes === null
      ? ''
      : `${plural(s.issues ?? 0, 'issue', 'issues')}, ${plural(s.changes ?? 0, 'change', 'changes')}, `
  return `${counts}${ago(Date.parse(s.at), now)}`
}

/** The whole listing as sentences, for an agent. */
export function listingText(listing: TrackerListing, now: number): string {
  const lines = listing.sources.map(
    (s) =>
      `- ${s.tracker} ${sourceName(s)}: ${rolesOf(s).join('; ')}.`
      + (s.off ? '' : ` ${s.error ? `Last read failed — ${s.error}` : `Last read: ${readSaid(s, now)}.`}`),
  )
  const schedule = listing.every > 0 ? `reads again every ${listing.every} minutes while somebody is looking` : 'does not read on a schedule'
  return [
    TRACKERS_ARE_FOR,
    listing.sources.length ? lines.join('\n') : 'No sources: this project has no GitHub or GitLab remote and nobody has added one.',
    `The project's git remotes are ${listing.remotes ? 'read' : 'not read'}, and the host ${schedule}.`,
  ].join('\n')
}

const entryKeys = { tracker: z.enum(trackerNames), host: z.string().max(253), repo: z.string().max(400) }

/** What the page may ask of `POST /host/trackers`. One thing at a time. */
export const trackerEditSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('check'), input: z.string().max(600), tracker: z.enum(trackerNames).optional(), host: z.string().max(253).optional() }),
  z.object({
    kind: z.literal('add'),
    input: z.string().max(600),
    tracker: z.enum(trackerNames).optional(),
    host: z.string().max(253).optional(),
    default: z.boolean().optional(),
    list: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('remove'), ...entryKeys }),
  z.object({
    kind: z.literal('set'),
    ...entryKeys,
    default: z.boolean().optional(),
    list: z.boolean().optional(),
    off: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('schedule'), every: z.number().int().min(0).max(1440) }),
  z.object({ kind: z.literal('remotes'), on: z.boolean() }),
  /** The file will not read: set it aside as `.broken` and start fresh. */
  z.object({ kind: z.literal('fresh') }),
])
export type TrackerEdit = z.infer<typeof trackerEditSchema>

/** The answer to an edit. */
export const trackerEditedSchema = z.object({
  outcome: z.enum(['changed', 'unchanged', 'declined', 'read', 'failed']),
  why: z.string(),
  said: z.string(),
  needs: z.literal('tracker').nullable().optional(),
  issues: z.number().optional(),
  changes: z.number().optional(),
  listing: trackerListingSchema.optional(),
})
export type TrackerEdited = z.infer<typeof trackerEditedSchema>
