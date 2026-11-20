import { readTrackerRef, type TrackerRow } from 'kehikot-module-protocol'
import type { ListHow, Wanted } from './common.ts'
import { checking, identity } from './identity.ts'
import { detailCurrent } from './itemDetail.ts'
import type { ReadBy } from './reading.ts'
import { sourceFor, sourceKey, type Source } from './sources.ts'
import { inScope, READS_DEFAULT, readsKey } from '../../src/host/trackerReads.ts'

/**
 * What a read asks of each tracker, worked out before anything is asked — pure, so each rule can be
 * held to by a test without a tracker. `Trackers.#read` runs it; `readSources.ts` asks what it says.
 */

/**
 * A source that reads only what changed is still listed whole this often: an
 * item deleted or moved away says nothing in a list of changes, and the held
 * rows are trimmed back to what a whole listing holds (Jalez/kehikko#318).
 */
export const WHOLE_EVERY_MS = 24 * 60 * 60_000
/** A read of only what changed asks from this long before the last one started, so nothing between falls through. */
const SINCE_OVERLAP_MS = 2 * 60_000

/** A named ref as one source is asked it: the number, its kind, and every spelling that named it. */
export type WantedRef = Wanted & { refs: string[] }
/** What one source is asked on a read: its listing (`list`), and the named refs by identity. */
export interface SourcePlan {
  source: Source
  list: boolean
  wanted: Map<string, WantedRef>
}
/** Per `sourceKey`, what that source is asked. Every source has an entry, asked or not. */
export type ReadPlan = Map<string, SourcePlan>

/**
 * What each source is asked: its listing on a whole read, and the named
 * refs the listing will not cover.
 */
export function planRead(sources: readonly Source[], refs: readonly string[], whole: boolean): ReadPlan {
  const plan: ReadPlan = new Map()
  for (const source of sources) {
    plan.set(sourceKey(source), { source, list: whole && source.listed, wanted: new Map() })
  }
  for (const ref of refs) {
    const source = sourceFor(sources, ref)
    const name = readTrackerRef(ref)
    if (!source || !name) continue
    const id = identity(source, name.kind, name.number)
    const entry = plan.get(sourceKey(source))!
    const was = entry.wanted.get(id)
    entry.wanted.set(id, { number: name.number, kind: name.kind, refs: [...(was?.refs ?? []), ref] })
  }
  return plan
}

/** What the reading held of a source's last listing: when it listed cleanly, whole or not, and what it read. */
export interface ListedBefore {
  listedAt?: string | null
  wholeAt?: string | null
  readsKey?: string
}

/**
 * What a listed source's listing asks (#318): its `reads`, and, when it reads only what
 * changed and the last clean listing read the same, the instant to ask from. The person's
 * Refresh all is always whole.
 */
export function listHowFor(source: Source, was: ListedBefore | undefined, nowMs: number, by: ReadBy): ListHow {
  const reads = source.reads ?? READS_DEFAULT
  const same = was?.readsKey === readsKey(source.reads)
  const wholeRecently = was?.wholeAt ? nowMs - Date.parse(was.wholeAt) < WHOLE_EVERY_MS : false
  const since = by !== 'press' && reads.since && same && was?.listedAt && wholeRecently
    ? new Date(Date.parse(was.listedAt) - SINCE_OVERLAP_MS).toISOString()
    : null
  return { reads, since }
}

/**
 * Whether a ref somebody names, held from an earlier read (`row`, or undefined when none is held),
 * is read again by name on this one. Everything is on the person's Refresh all, and on a read of a
 * few refs (the item somebody has open). On the schedule, a held row is not read again when its
 * source said what changed since (`covered`: a clean listing of only what changed, or a probe that
 * found nothing updated) — except an open change whose CI is still running, since a check
 * finishing moves no item's `updatedAt` — nor when it is a closed item older than the source reads
 * (read once, then on demand: reopening it moves `updatedAt`, which the next listing of what
 * changed sees).
 */
export function readAgain(
  row: TrackerRow | undefined,
  source: Source,
  covered: boolean,
  at: { whole: boolean; by: ReadBy; nowMs: number },
): boolean {
  if (!at.whole || at.by === 'press') return true
  if (!row) return true
  if (checking(row)) return true
  if (covered) return false
  return inScope(row, source.reads ?? READS_DEFAULT, at.nowMs)
}

/**
 * Detail, for the refs somebody asked the detail of (`detailed`) and that this read covers: per
 * source, the held rows whose detail is not current, of a source whose read did not fail.
 */
export function detailFor(
  detailed: Iterable<string>,
  at: {
    refs: readonly string[]
    whole: boolean
    sources: readonly Source[]
    rows: ReadonlyMap<string, TrackerRow>
    failed: (key: string) => boolean
  },
): Map<string, { source: Source; rows: TrackerRow[] }> {
  const needDetail = new Map<string, { source: Source; rows: TrackerRow[] }>()
  for (const ref of detailed) {
    if (!at.refs.includes(ref) && !at.whole) continue
    const source = sourceFor(at.sources, ref)
    const name = readTrackerRef(ref)
    if (!source || !name || at.failed(sourceKey(source))) continue
    const row = at.rows.get(identity(source, name.kind, name.number))
    if (!row || detailCurrent(row)) continue
    const entry = needDetail.get(sourceKey(source)) ?? { source, rows: [] }
    entry.rows.push(row)
    needDetail.set(sourceKey(source), entry)
  }
  return needDetail
}
