import { LIMITS, readTrackerRef, type TrackerRefreshResult, type TrackerRow } from 'kehikot-module-protocol'
import type { BoardsRead, HeldBoard } from './common.ts'
import { BRANCH_PAGES } from './gitlab.ts'
import { identity, rowIdentity } from './identity.ts'
import { detailCurrent } from './itemDetail.ts'
import type { ReadPlan } from './readPlan.ts'
import type { Stored, StoredBoards, StoredBranches } from './reading.ts'
import { sourceFor, sourceKey, type Source } from './sources.ts'
import { inScope, READS_DEFAULT, readsKey } from '../../src/host/trackerReads.ts'

/**
 * What a read that landed comes to, beside what the reading held: the rows, the boards, the branch
 * names, each source's line. Pure — `Trackers.#read` hands each what was read and what was held.
 */

/** Per source listed cleanly: whether it asked only for what changed. */
export type ListedHow = ReadonlyMap<string, { since: boolean }>

/**
 * Every identity somebody names: what this read asked by name (`plan`), and every ref an epic or a
 * module named before (`named`). These are never dropped to make room.
 */
export function wantedIdentities(plan: ReadPlan, named: readonly string[], sources: readonly Source[]): Set<string> {
  const wantedIds = new Set<string>()
  for (const { wanted } of plan.values()) for (const id of wanted.keys()) wantedIds.add(id)
  for (const ref of named) {
    const source = sourceFor(sources, ref)
    const name = readTrackerRef(ref)
    if (source && name) wantedIds.add(identity(source, name.kind, name.number))
  }
  return wantedIds
}

/**
 * Merge: fresh rows replace their identities; a listed source's rows that
 * neither its new listing nor anybody's ref still names are dropped, so
 * the reading does not grow forever. Rows of a failed source stay.
 */
export function mergeRows(
  held: readonly TrackerRow[],
  fresh: readonly TrackerRow[],
  at: {
    sources: readonly Source[]
    /** Sources listed whole and cleanly on this read. */
    listedNow: ReadonlySet<string>
    wanted: ReadonlySet<string>
    /** Identities a read handed back without everything (`unread`). */
    thin: ReadonlySet<string>
  },
): Map<string, TrackerRow> {
  const byId = new Map<string, TrackerRow>()
  const stillRead = new Set(at.sources.map(sourceKey))
  for (const row of held) {
    const key = sourceKey(row)
    /* A source that is no longer read (removed, or turned off) takes its rows with it. */
    if (!stillRead.has(key)) continue
    if (at.listedNow.has(key) && !at.wanted.has(rowIdentity(row))) continue
    byId.set(rowIdentity(row), row)
  }
  for (const fromRead of fresh) {
    const was = byId.get(rowIdentity(fromRead))
    /* Read, but not everything of it (a deeper query timed out): what it says wins, what it did not say stays. */
    const row = was && at.thin.has(rowIdentity(fromRead)) ? { ...was, ...fromRead } : fromRead
    /* A detail read earlier survives a summary read, unless the ref moved since (`detailCurrent`). */
    const detail = was?.detail && detailCurrent(row, was.detail) ? was.detail : undefined
    byId.set(rowIdentity(row), detail ? { ...row, detail } : row)
  }
  return byId
}

/**
 * A source's rows its `reads` leave out go, unless somebody names them; and one that reads
 * only what changed is trimmed to what a whole listing of it would hold, newest updated
 * first, so the held rows do not grow without end (#318). Only for a source that listed
 * cleanly this time: one that failed keeps everything it had.
 */
export function trimToReads(
  rows: ReadonlyMap<string, TrackerRow>,
  at: { sources: readonly Source[]; listedHow: ListedHow; wanted: ReadonlySet<string>; nowMs: number; listLimit: number },
): Map<string, TrackerRow> {
  const byId = new Map(rows)
  const bySource = new Map(at.sources.map((s) => [sourceKey(s), s]))
  const counts = new Map<string, number>()
  const newestFirst = [...byId.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  for (const row of newestFirst) {
    const key = sourceKey(row)
    const source = bySource.get(key)
    const how = at.listedHow.get(key)
    if (!source || !how) continue
    const id = rowIdentity(row)
    if (at.wanted.has(id)) continue
    if (!inScope(row, source.reads ?? READS_DEFAULT, at.nowMs)) {
      byId.delete(id)
      continue
    }
    if (!how.since) continue
    const per = `${key}|${row.kind}`
    const n = (counts.get(per) ?? 0) + 1
    counts.set(per, n)
    if (n > at.listLimit) byId.delete(id)
  }
  return byId
}

/**
 * The rows a reading keeps, at most `TRACKER_ROWS`: every row somebody names, then the rest newest
 * updated first, in the order they came. A ref read by name and then cut for room would be missing
 * at the next question and read again on every one (Jalez/kehikko#384).
 */
export function keptRows(rows: TrackerRow[], named: ReadonlySet<string>): TrackerRow[] {
  if (rows.length <= LIMITS.TRACKER_ROWS) return rows
  const unnamed = rows.filter((row) => !named.has(rowIdentity(row)))
  const room = Math.max(0, LIMITS.TRACKER_ROWS - (rows.length - unnamed.length))
  const roomFor = new Set(
    unnamed
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      .slice(0, room)
      .map(rowIdentity),
  )
  return rows.filter((row) => named.has(rowIdentity(row)) || roomFor.has(rowIdentity(row))).slice(0, LIMITS.TRACKER_ROWS)
}

/** Identities held as gone: those held before that this read did not bring back as rows, and what it found gone. */
export function notFoundAfter(was: readonly string[], fresh: readonly TrackerRow[], gone: ReadonlySet<string>): Set<string> {
  const notFound = new Set([...was].filter((id) => !fresh.some((r) => rowIdentity(r) === id)))
  for (const id of gone) notFound.add(id)
  return notFound
}

/** A board's identity across sources: one GitHub project may hold several repositories' items. */
export const boardKey = (b: Pick<HeldBoard, 'board' | 'boardUrl'>) => `${b.board}|${b.boardUrl ?? ''}`

/** Boards `fresh` over `was`, by identity, fresh ones winning and first. */
export function unionBoards(was: readonly HeldBoard[], fresh: readonly HeldBoard[]): HeldBoard[] {
  const out = new Map<string, HeldBoard>()
  for (const b of [...fresh, ...was]) if (!out.has(boardKey(b))) out.set(boardKey(b), b)
  return [...out.values()].slice(0, LIMITS.TRACKER_BOARDS)
}

/** Two reads of one source's boards as one: unreadable wins, since then none of them were seen. */
export function joinBoards(a: BoardsRead | undefined, b: BoardsRead | undefined): BoardsRead | undefined {
  if (!a) return b
  if (!b) return a
  if ('unreadable' in a) return a
  if ('unreadable' in b) return b
  return { boards: unionBoards(a.boards, b.boards) }
}

/** Each source's boards after a read: what it read, else what was held. */
export function boardsAfter(
  sources: readonly Source[],
  held: readonly StoredBoards[],
  read: ReadonlyMap<string, BoardsRead>,
  listedNow: ReadonlySet<string>,
): StoredBoards[] {
  const boardsWas = new Map(held.map((b) => [b.source, b]))
  const boards: StoredBoards[] = []
  for (const source of sources) {
    const key = sourceKey(source)
    const was = boardsWas.get(key)
    const got = read.get(key)
    if (!got) {
      if (was) boards.push(was)
      continue
    }
    if ('unreadable' in got) {
      boards.push({ source: key, boards: [], unreadable: got.unreadable.slice(0, LIMITS.REASON) })
      continue
    }
    /* A listing saw everything recent, so it replaces; a read by name saw a few, so it adds. */
    const whole = listedNow.has(key) || source.tracker !== 'github'
    boards.push({ source: key, boards: whole ? got.boards.slice(0, LIMITS.TRACKER_BOARDS) : unionBoards(was?.boards ?? [], got.boards), unreadable: null })
  }
  return boards
}

/** Each source's branch names after a read: what it read, else what was held. */
export function branchesAfter(sources: readonly Source[], held: readonly StoredBranches[], read: ReadonlyMap<string, string[]>): StoredBranches[] {
  const branchesWas = new Map(held.map((b) => [b.source, b]))
  const branches: StoredBranches[] = []
  for (const source of sources) {
    const key = sourceKey(source)
    const got = read.get(key)
    if (got) branches.push({ source: key, names: got.slice(0, BRANCH_PAGES * 100) })
    else if (branchesWas.has(key)) branches.push(branchesWas.get(key)!)
  }
  return branches
}

type StoredSource = Stored['sources'][number]

/**
 * Each source's line after a read: its error (null once it read cleanly; what it held when it was
 * not asked), when it last read cleanly, and when it last listed.
 */
export function sourcesAfter(
  sources: readonly Source[],
  held: readonly StoredSource[],
  at: { errors: ReadonlyMap<string, string | null>; listedHow: ListedHow; now: string },
): StoredSource[] {
  const { errors, listedHow, now } = at
  const stored = new Map(held.map((s) => [sourceKey(s), s]))
  /** When each source last listed cleanly, whole or only what changed, and what it read. */
  const listedSaid = (key: string, was: StoredSource | undefined) => {
    const how = listedHow.get(key)
    const source = sources.find((s) => sourceKey(s) === key)
    if (!how || !source) {
      return {
        ...(was?.listedAt !== undefined ? { listedAt: was.listedAt } : {}),
        ...(was?.wholeAt !== undefined ? { wholeAt: was.wholeAt } : {}),
        ...(was?.readsKey !== undefined ? { readsKey: was.readsKey } : {}),
      }
    }
    return { listedAt: now, wholeAt: how.since ? (was?.wholeAt ?? null) : now, readsKey: readsKey(source.reads) }
  }
  return sources.map((s) => {
    const was = stored.get(sourceKey(s))
    const key = sourceKey(s)
    const error = errors.has(key) ? errors.get(key)! : (was?.error ?? null)
    return {
      tracker: s.tracker,
      host: s.host,
      repo: s.repo,
      default: s.default,
      listed: s.listed,
      at: errors.has(key) && errors.get(key) === null ? now : (was?.at ?? null),
      error: error === null ? null : error.slice(0, LIMITS.REASON),
      ...listedSaid(key, was),
    }
  })
}

/** What the read answers: read, or failed with every failed source's sentence. */
export function readOutcome(errors: ReadonlyMap<string, string | null>, now: string): TrackerRefreshResult {
  const failed = [...errors.entries()].filter(([, why]) => why !== null)
  if (failed.length) {
    return {
      outcome: 'failed',
      at: now,
      why: failed
        .map(([key, why]) => `${key.split('|').slice(1).join('/')}: ${why}`)
        .join(' ')
        .slice(0, LIMITS.REASON),
    }
  }
  return { outcome: 'read', at: now, why: '' }
}
