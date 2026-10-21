/**
 * Which folder and branch a module is running from, as the container's header
 * shows it. Read by `server/source.ts`; pure here, so the page and the tests
 * share one rule for when it is worth a person's attention.
 *
 * The app runs every module from its installed copy, which is checked out at a
 * release, or follows `main` while its repository has none. The plain cases —
 * a release, or `main` level with its upstream; nothing uncommitted, from the
 * folder the registration names — are shown quietly. Anything else is marked,
 * and says why.
 */
export interface Source {
  /** The folder the module runs from. */
  dir: string
  /** Whether that is the folder its registration names. */
  registered: boolean
  /** The checked-out branch, or null when detached. */
  branch: string | null
  /** `origin/main`, or null when the branch tracks nothing. */
  upstream: string | null
  behind: number
  ahead: number
  /** Changes to tracked files. */
  dirty: boolean
  /** The release (`v1.6.0`) a detached checkout is on, or null. Absent from an older host. */
  release?: string | null
}

/** Why a source is worth a person's attention, in words — empty when it is the plain case. */
export function offMain(source: Source): string[] {
  const said: string[] = []
  const onRelease = source.branch === null && !!source.release
  if (source.branch !== 'main' && !onRelease) said.push(source.branch ? `on ${source.branch}, not main` : 'on no branch (detached)')
  if (source.behind > 0) said.push(`${source.behind} ${source.behind === 1 ? 'commit' : 'commits'} behind ${source.upstream ?? 'its branch'}`)
  if (source.ahead > 0) said.push(`${source.ahead} ${source.ahead === 1 ? 'commit' : 'commits'} not on ${source.upstream ?? 'its branch'}`)
  if (source.dirty) said.push('uncommitted changes')
  if (!source.registered) said.push('not the folder the app runs it from')
  return said
}

/** What the header writes: the branch, or `detached`. */
export function branchWord(source: Source): string {
  if (source.branch === null && source.release) return 'release'
  return source.branch ?? 'detached'
}

/** The release a container's module runs, as its version chip says it (`1.6.0`), or null when it is not on one. */
export function releaseShown(source: Source | null | undefined): string | null {
  return source && source.branch === null && source.release ? source.release.replace(/^v/, '') : null
}

/** The whole tooltip: where it runs from, and why it is marked when it is. */
export function sourceHint(source: Source): string {
  const why = offMain(source)
  const where = `Running from ${source.dir}`
  if (why.length) return `${where} — ${why.join('; ')}.`
  if (source.branch === null && source.release) return `${where}, at release ${source.release}.`
  return `${where}, on main, level with ${source.upstream ?? 'its branch'}.`
}
