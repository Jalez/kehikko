import { LIMITS, mirrorRelation, readTrackerRef, type TrackerContribution, type TrackerRow } from 'kehikot-module-protocol'

import { sourceKey } from './sources.ts'

/**
 * Changes that are part of an issue (protocol 2.19.0 `contributions`), put
 * right across the rows given on every read. Pure.
 *
 * The issue's own reading is the claim: GitHub hands an issue the
 * cross-references its pull requests' authors made (`contributionsOf` in
 * `github.ts`) and hands a pull request nothing. So each change the rows hold
 * is given `contributes-to` for every held issue whose `contributed-by` names
 * it, and loses one for a held issue that was read and no longer names it. A
 * mirror of an issue the rows do not hold is left alone: nothing here can say
 * it is wrong.
 *
 * A contribution that is also a link (a change that now says it closes the
 * issue) is taken off, on either side: closing is the stronger word.
 *
 * Refs are spelled per source and the two ends may be in different
 * repositories, so a ref is matched by what it names — the tracker, the
 * repository (a short spelling's is the row's own) and the number — and not
 * by its spelling.
 */
export function withContributors(rows: readonly TrackerRow[]): TrackerRow[] {
  const named = (row: TrackerRow, ref: string): string | null => {
    const one = readTrackerRef(ref)
    if (!one || one.tracker !== row.tracker) return null
    const kind = row.tracker === 'github' ? 'n' : (one.kind ?? 'issue')
    return `${sourceKey({ tracker: row.tracker, host: row.host, repo: one.repo ?? row.repo })}|${kind}|${one.number}`
  }
  const self = (row: TrackerRow) => `${sourceKey(row)}|${row.tracker === 'github' ? 'n' : row.kind}|${row.number}`

  const linked = (row: TrackerRow) => new Set(row.links.map((l) => named(row, l.ref)).filter((k): k is string => k !== null))

  const issues = new Map<string, TrackerRow>()
  const naming = new Map<string, TrackerRow[]>()
  for (const one of rows) {
    if (one.kind !== 'issue') continue
    issues.set(self(one), one)
    const closing = linked(one)
    for (const c of one.contributions ?? []) {
      const key = c.relation === 'contributed-by' ? named(one, c.ref) : null
      if (key && !closing.has(key)) naming.set(key, [...(naming.get(key) ?? []), one])
    }
  }

  return rows.map((one) => {
    if (one.kind === 'issue') {
      if (!one.contributions?.length) return one
      const closing = linked(one)
      const kept = one.contributions.filter((c) => !closing.has(named(one, c.ref) ?? ''))
      return kept.length === one.contributions.length ? one : { ...one, contributions: kept }
    }
    const by = naming.get(self(one)) ?? []
    if (!by.length && !one.contributions?.length) return one
    const closing = linked(one)
    const stands = (c: TrackerContribution) => {
      const issue = issues.get(named(one, c.ref) ?? '')
      if (!issue || issue.contributions === undefined) return true
      return issue.contributions.some((d) => d.relation === 'contributed-by' && named(issue, d.ref) === self(one))
    }
    const held = (one.contributions ?? []).filter((c) => stands(c) && !closing.has(named(one, c.ref) ?? ''))
    const known = new Set(held.map((c) => named(one, c.ref)))
    const added: TrackerContribution[] = []
    for (const issue of by) {
      if (known.has(self(issue)) || closing.has(self(issue))) continue
      known.add(self(issue))
      added.push({ ref: issue.ref, relation: mirrorRelation('contributed-by') })
    }
    const contributions = [...held, ...added].slice(0, LIMITS.TRACKER_LINKS)
    if (one.contributions && contributions.length === one.contributions.length && !added.length) return one
    if (!one.contributions && !contributions.length) return one
    return { ...one, contributions }
  })
}
