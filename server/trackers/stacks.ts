import { LIMITS, type TrackerRow } from 'kehikot-module-protocol'

import { sourceKey } from './sources.ts'

/**
 * Stacked changes (protocol 2.8.0 `stack`), worked out across the whole
 * reading on every read. Pure.
 *
 * A change is stacked on another when both are open, in one repository, and
 * its base branch is the other's head branch. `below` is that other change;
 * `above` the open changes based on this one's head, in number order (several
 * where the stack forks). A row in no stack has no `stack`; a stack held from
 * an earlier read is taken off and worked out again, so a merged or retargeted
 * change leaves its stack at once.
 *
 * When two open changes come from the same branch (GitHub allows it, into
 * different bases), a change based on that branch has no `below`: which one it
 * sits on is not known, and it is not guessed.
 */
export function withStacks(rows: readonly TrackerRow[]): TrackerRow[] {
  const open = rows.filter((r) => r.kind === 'change' && r.state === 'open')
  const at = (r: TrackerRow, branch: string) => `${sourceKey(r)}|${branch}`
  /** Open changes by the branch they come from. */
  const heads = new Map<string, TrackerRow[]>()
  /** Open changes by the branch they merge into. */
  const bases = new Map<string, TrackerRow[]>()
  for (const r of open) {
    if (r.headBranch) heads.set(at(r, r.headBranch), [...(heads.get(at(r, r.headBranch)) ?? []), r])
    if (r.baseBranch) bases.set(at(r, r.baseBranch), [...(bases.get(at(r, r.baseBranch)) ?? []), r])
  }
  return rows.map((r) => {
    const { stack: _was, ...rest } = r
    if (r.kind !== 'change' || r.state !== 'open') return _was ? rest : r
    const under = r.baseBranch ? (heads.get(at(r, r.baseBranch)) ?? []).filter((o) => o !== r) : []
    const below = under.length === 1 ? under[0]!.ref : undefined
    const above = (r.headBranch ? (bases.get(at(r, r.headBranch)) ?? []) : [])
      .filter((o) => o !== r)
      .sort((a, b) => a.number - b.number)
      .map((o) => o.ref)
      .slice(0, LIMITS.TRACKER_LINKS)
    if (below === undefined && !above.length) return _was ? rest : r
    return { ...rest, stack: { ...(below !== undefined ? { below } : {}), above } }
  })
}
