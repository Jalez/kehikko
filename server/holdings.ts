import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What this host actually holds, when it is pointed at something.
 *
 * ## The host used to hold nothing, on purpose
 *
 * Every answer in `answers.ts` was an answer about emptiness, and the essay
 * there is still right about why the two kinds of emptiness must be told apart.
 * What has changed is only that there is now something to read: a roadmap
 * directory on this machine, named by `KEHIKKO_ROADMAP_DIR`.
 *
 * Unset, nothing here reports anything and the host answers exactly as it did
 * before — which is the important property. A host with no holdings says "not
 * mine to say" and means it; it does not say "no epics" and quietly mean "I was
 * not configured". Those are the two sentences the whole design exists to keep
 * apart, and a misconfiguration must land on the honest side of the line.
 *
 * ## Two directories, and the split between them is not ours
 *
 * `data/epics/<slug>.json` is what a person wrote: the title, the project, the
 * prose, the order of things. `data/state/<slug>.json` is what the trackers
 * last reported, written by a refresh and never by hand. The roadmap that owns
 * those files enforces the split, and this reads both without blurring it —
 * `epic.get` answers from the first, `live.get` from the second, and neither
 * borrows from the other.
 *
 * ## Read on every call, and cached not at all
 *
 * A refresh rewrites those files while this host is running. Anything cached
 * here would be a copy of what the trackers said at some earlier moment,
 * presented as what they say now, which is the failure this whole codebase has
 * spent its time on. The files are small and local; reading them per call costs
 * nothing worth having.
 */

/** Where the roadmap's own data lives, or null when this host holds nothing. */
export function holdingsDir(env: Record<string, string | undefined> = process.env): string | null {
  const dir = env.KEHIKKO_ROADMAP_DIR
  if (!dir) return null
  return existsSync(join(dir, 'data', 'epics')) ? dir : null
}

/**
 * A slug, checked before it is put in a path.
 *
 * This arrives from a framed module over the wire. `../../etc/passwd` is a
 * string, and joining it onto a directory is how a read of somebody's own data
 * becomes a read of anything on the disk. The shape is the check, and it
 * refuses identically whether or not a file exists — a refusal that came faster
 * for a real slug than a made-up one would answer the question anyway.
 */
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/

export interface EpicSummary {
  slug: string
  title?: string
  project?: string
  lede?: string
  /** How many things this epic names, when the file says. Never invented. */
  size?: number
}

/**
 * Every epic the roadmap holds.
 *
 * Sorted by title so the list is stable between calls; a list that reordered
 * itself on every refresh would make a module look like it was flickering.
 * Unreadable files are skipped rather than throwing — one corrupt epic must not
 * make the other ten unreachable — and skipping is safe here because the caller
 * is being told what exists, not being told nothing exists.
 */
export function listEpics(dir: string): EpicSummary[] {
  const epics: EpicSummary[] = []
  let files: string[]
  try {
    files = readdirSync(join(dir, 'data', 'epics'))
  } catch {
    return []
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const slug = file.slice(0, -'.json'.length)
    if (!SLUG.test(slug)) continue
    const epic = read(join(dir, 'data', 'epics', file))
    if (!epic) continue

    /* Only fields that are actually there, and only at the type they are
       actually at. A title that arrived as a number is a title this host could
       not read, and sending `String(title)` would put somebody's object id on
       screen as the name of an epic. */
    const summary: EpicSummary = { slug: str(epic.slug) ?? slug }
    const title = str(epic.title)
    if (title) summary.title = title
    const project = str(epic.project)
    if (project) summary.project = project
    const lede = str(epic.lede)
    if (lede) summary.lede = lede
    const size = countOf(epic)
    if (size !== null) summary.size = size

    epics.push(summary)
  }

  return epics.sort((a, b) => (a.title ?? a.slug).localeCompare(b.title ?? b.slug))
}

/** One epic, exactly as it is written down. `null` when there is no such file. */
export function readEpic(dir: string, slug: string): Record<string, unknown> | null {
  if (!SLUG.test(slug)) return null
  return read(join(dir, 'data', 'epics', `${slug}.json`))
}

/**
 * What the trackers last reported about one epic.
 *
 * The file is handed back close to verbatim: its four bags — `issues`, `mrs`,
 * `ghIssues`, `ghPrs` — are the shape a module reading references already
 * expects, because both sides learned it from the same roadmap. `generated` is
 * carried with them, and it is the most important field in the answer: it is
 * the only thing that says how old this is, and a module drawing tracker state
 * with no date on it is a module presenting last week as now.
 */
export function readLive(dir: string, slug: string): Record<string, unknown> | null {
  if (!SLUG.test(slug)) return null
  return read(join(dir, 'data', 'state', `${slug}.json`))
}

/** The steps of one epic, when it has any written down. */
export function readSteps(dir: string, slug: string): unknown[] | null {
  const epic = readEpic(dir, slug)
  if (!epic) return null
  return Array.isArray(epic.steps) ? epic.steps : []
}

function read(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    /* Absent, unreadable, or not JSON. All three mean the same thing to a
       caller — there is nothing here to hand over — and none of them is worth
       an exception thrown through a wire call. */
    return null
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * How much an epic names, when that can be said honestly.
 *
 * `null` rather than `0` when there is nothing to count, because a module is
 * required to tell "no size given" from "a size of none" — see the reading
 * rules in Atlas, which say the same thing from the other end. A zero here
 * would be this host asserting a fact it does not have.
 */
function countOf(epic: Record<string, unknown>): number | null {
  const steps = Array.isArray(epic.steps) ? epic.steps.length : 0
  const exists = Array.isArray(epic.exists) ? epic.exists.length : 0
  const open = Array.isArray(epic.open) ? epic.open.length : 0
  const total = steps + exists + open
  return total > 0 ? total : null
}
