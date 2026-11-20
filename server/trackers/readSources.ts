import { LIMITS, type TrackerDetailFacts, type TrackerRow } from 'kehikot-module-protocol'
import { UNKNOWN, type Adapter, type BoardsRead, type Probe, type Read } from './common.ts'
import { checking, identity, rowIdentity } from './identity.ts'
import { joinBoards } from './merge.ts'
import { listHowFor, readAgain, type ListedBefore, type ReadPlan, type SourcePlan } from './readPlan.ts'
import type { ReadBy } from './reading.ts'
import { sourceKey, type Source } from './sources.ts'

/**
 * Asking the trackers what a `ReadPlan` says to ask: every source at once, each on its own, then
 * the boards and branch names a whole read reads apart, then the detail somebody asked for.
 * `Trackers.#read` runs these between planning (`readPlan.ts`) and merging (`merge.ts`).
 */

export type Adapters = Record<Source['tracker'], Adapter>

/** What every source's read is asked under. */
export interface ReadAt {
  /** A whole-project read. */
  whole: boolean
  by: ReadBy
  now: string
  nowMs: number
  /** The rows held from earlier reads, by identity. */
  held: ReadonlyMap<string, TrackerRow>
  /** What was held of each source's last listing, by `sourceKey`. */
  listedBefore: ReadonlyMap<string, ListedBefore>
  listLimit: number
}

/** What reading one source came to. */
export interface SourceRead {
  /** Why part or all of it is not newer, in a sentence; null when it read cleanly. */
  error: string | null
  /** Its read failed outright, as against one that read with a sentence (part of it unread). */
  failedOutright: boolean
  /** Set when it listed cleanly: whether it asked only for what changed. */
  listed?: { since: boolean }
  /** It listed whole, cleanly. */
  listedWhole: boolean
  boards?: BoardsRead
  /** The sentence when it would not say who reviews, or null when it did; absent when nothing said. */
  people?: string | null
  rows: TrackerRow[]
  /** Identities asked for, answered for, and not among the rows. */
  gone: string[]
  /** Identities handed back without everything (`unread`): what was held of them is kept under the new fields. */
  thin: string[]
}

/** Read one source as its plan says; null when nothing is asked of it. */
export async function readSource(adapter: Adapter, { source, list, wanted }: SourcePlan, at: ReadAt): Promise<SourceRead | null> {
  const key = sourceKey(source)
  if (!list && !wanted.size) return null
  const out: SourceRead = { error: null, failedOutright: false, listedWhole: false, rows: [], gone: [], thin: [] }
  const failed = (why: string): SourceRead => ({ ...out, error: why, failedOutright: true })
  let got: TrackerRow[] = []
  let unread: { why: string; refs: Array<{ number: number; kind: 'issue' | 'change' | null }> } | undefined
  let partial: string | undefined
  /* Whether this read knows everything in the source that changed since the last one. */
  let covered = false
  /* Asked before anything is read, so that what it keeps predates what is read after it. On
     every whole-project read of a source with something to read, so the next one can skip. */
  const probe: Probe = at.whole && adapter.changed && (list || [...wanted.keys()].some((id) => at.held.has(id)))
    ? await adapter.changed(source).catch(() => UNKNOWN)
    : UNKNOWN
  if (list) {
    const how = listHowFor(source, at.listedBefore.get(key), at.nowMs, at.by)
    if (how.since && probe.changed === false) {
      /* Nothing in the source was updated since the last listing: there is nothing to list. */
      covered = true
      out.listed = { since: true }
    } else {
      const read = await adapter.list(source, at.listLimit, at.now, how)
      if (!read.ok) return failed(read.why)
      got = read.rows
      /* A listing that stopped part way did not see everything recent: the rows it did not reach
         stay. So do a listing of only what changed: the rest did not change. */
      if (read.partial) partial = read.partial
      else {
        out.listed = { since: Boolean(how.since) }
        if (!how.since) out.listedWhole = true
        covered = Boolean(how.since) && !read.unread
        if (!read.unread) probe.keep()
      }
      unread = read.unread
      if (read.boards) out.boards = read.boards
      out.people = read.people?.unreadable ?? null
    }
  } else if (probe.changed === false) covered = true
  const have = new Set(got.map(rowIdentity))
  const rest = [...wanted.entries()].filter(([id]) => !have.has(id) && readAgain(at.held.get(id), source, covered, at)).map(([id, w]) => ({ ...w, id }))
  /* And the source's open changes whose CI was still running at the last read, named or not:
     their checks finishing is news no listing of what changed carries. Batched with the rest. */
  if (at.whole) {
    for (const [id, row] of at.held) {
      if (sourceKey(row) !== key || have.has(id) || wanted.has(id) || !checking(row)) continue
      rest.push({ number: row.number, kind: source.tracker === 'github' ? null : row.kind, refs: [row.ref], id })
    }
  }
  if (rest.length) {
    const read: Read = await adapter.refs(source, rest, at.now)
    if (!read.ok) return failed(read.why)
    got = [...got, ...read.rows]
    if (read.unread) unread = unread ? { why: unread.why, refs: [...unread.refs, ...read.unread.refs] } : read.unread
    if (read.people || out.people === undefined) out.people = read.people?.unreadable ?? null
    const joined = joinBoards(out.boards, read.boards)
    if (joined) out.boards = joined
  }
  const refused = new Set((unread?.refs ?? []).map((r) => identity(source, r.kind, r.number)))
  out.error = unread?.why ?? partial ?? null
  /* An unlisted source read cleanly by name: the probe it was asked after stands. */
  if (!list && !unread && probe.changed) probe.keep()
  out.thin = [...refused]
  out.rows = got
  /* Asked for, answered for, and not among the rows: either the tracker
     said so, or what it said would not make a row. Either way it is not
     asked again until something names it afresh, so no question and no
     read can chase each other. Only what was asked: a held row this read
     did not ask again is not gone. */
  const made = new Set(got.map(rowIdentity))
  const askedNow = new Set([...have, ...rest.map((w) => w.id)])
  for (const [id] of wanted) if (askedNow.has(id) && !made.has(id) && !refused.has(id)) out.gone.push(id)
  return out
}

/** What the reads of every source came to, gathered as each lands. */
export interface Fetched {
  /** Per source asked: its sentence, or null when it read cleanly. */
  errors: Map<string, string | null>
  /** Sources whose read failed outright, as against one that read with a sentence (part of it unread). */
  failedOutright: Set<string>
  boardsRead: Map<string, BoardsRead>
  /** Per source read: the sentence when it would not say who reviews, or null when it did. */
  peopleRead: Map<string, string | null>
  /** Per source listed cleanly: whether it asked only for what changed. */
  listedHow: Map<string, { since: boolean }>
  /** Sources listed whole, cleanly. */
  listedNow: Set<string>
  fresh: TrackerRow[]
  gone: Set<string>
  /** Identities a read handed back without everything (`unread`): what was held of them is kept under the new fields. */
  thin: Set<string>
}

function gather(into: Fetched, key: string, read: SourceRead): void {
  into.errors.set(key, read.error)
  if (read.failedOutright) into.failedOutright.add(key)
  if (read.listed) into.listedHow.set(key, read.listed)
  if (read.listedWhole) into.listedNow.add(key)
  if (read.boards) into.boardsRead.set(key, read.boards)
  if (read.people !== undefined) into.peopleRead.set(key, read.people)
  for (const id of read.thin) into.thin.add(id)
  into.fresh.push(...read.rows)
  for (const id of read.gone) into.gone.add(id)
}

/** Read every source of the plan at once, each gathered as it lands. */
export async function readSources(plan: ReadPlan, adapters: Adapters, at: ReadAt): Promise<Fetched> {
  const fetched: Fetched = {
    errors: new Map(),
    failedOutright: new Set(),
    boardsRead: new Map(),
    peopleRead: new Map(),
    listedHow: new Map(),
    listedNow: new Set(),
    fresh: [],
    gone: new Set(),
    thin: new Set(),
  }
  await Promise.all(
    [...plan.values()].map(async (entry) => {
      const read = await readSource(adapters[entry.source.tracker], entry, at)
      if (read) gather(fetched, sourceKey(entry.source), read)
    }),
  )
  return fetched
}

/**
 * A whole read asks a tracker that reads its boards apart (GitLab) for
 * them: one call per source that read cleanly. A failure keeps the boards
 * held before, and fails nothing. Into `fetched.boardsRead`.
 */
export async function readBoards(sources: readonly Source[], adapters: Adapters, fetched: Fetched): Promise<void> {
  await Promise.all(
    sources.map(async (source) => {
      const key = sourceKey(source)
      const boards = adapters[source.tracker].boards
      /* Boards move rarely: read on a whole listing (the first, the daily one, Refresh all), not on one of what changed. */
      if (!boards || fetched.failedOutright.has(key) || fetched.boardsRead.has(key) || fetched.listedHow.get(key)?.since) return
      const got = await boards(source).catch(() => null)
      if (got) fetched.boardsRead.set(key, got)
    }),
  )
}

/**
 * And its branch names, for an issue's related branches (GitLab, 2.19.0):
 * a listing of them per source that read cleanly, never a request per
 * issue. A failure keeps the names held before.
 */
export async function readBranches(sources: readonly Source[], adapters: Adapters, failedOutright: ReadonlySet<string>): Promise<Map<string, string[]>> {
  const branchesRead = new Map<string, string[]>()
  await Promise.all(
    sources.map(async (source) => {
      const key = sourceKey(source)
      const read = adapters[source.tracker].branches
      if (!read || failedOutright.has(key)) return
      const got = await read(source).catch(() => null)
      if (got) branchesRead.set(key, got)
    }),
  )
  return branchesRead
}

/**
 * Read the detail `detailFor` names: what a source says goes on its row in `rows`; a source whose
 * detail would not read says why in `errors`.
 */
export async function readDetail(
  need: ReadonlyMap<string, { source: Source; rows: TrackerRow[] }>,
  adapters: Adapters,
  rows: Map<string, TrackerRow>,
  errors: Map<string, string | null>,
  now: string,
): Promise<void> {
  await Promise.all(
    [...need.values()].map(async ({ source, rows: asked }) => {
      const got = await adapters[source.tracker].detail(source, asked.slice(0, LIMITS.TRACKER_ASK), now)
      if (!(got instanceof Map)) return errors.set(sourceKey(source), got.why)
      for (const row of asked) {
        const facts: TrackerDetailFacts | undefined = got.get(row.ref)
        if (facts) rows.set(rowIdentity(row), { ...row, detail: facts })
      }
    }),
  )
}
