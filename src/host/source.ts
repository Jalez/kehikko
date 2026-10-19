/**
 * Which folder and branch a module is running from, as the container's header
 * shows it. Read by `server/source.ts`; pure here, so the page and the tests
 * share one rule for when it is worth a person's attention.
 *
 * The app runs every module from its installed copy, which follows `main`. The
 * plain case — `main`, level with its upstream, nothing uncommitted, from the
 * folder the registration names — is shown quietly. Anything else is marked,
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
}

/** Why a source is worth a person's attention, in words — empty when it is the plain case. */
export function offMain(source: Source): string[] {
  const said: string[] = []
  if (source.branch !== 'main') said.push(source.branch ? `on ${source.branch}, not main` : 'on no branch (detached)')
  if (source.behind > 0) said.push(`${source.behind} ${source.behind === 1 ? 'commit' : 'commits'} behind ${source.upstream ?? 'its branch'}`)
  if (source.ahead > 0) said.push(`${source.ahead} ${source.ahead === 1 ? 'commit' : 'commits'} not on ${source.upstream ?? 'its branch'}`)
  if (source.dirty) said.push('uncommitted changes')
  if (!source.registered) said.push('not the folder the app runs it from')
  return said
}

/** What the header writes: the branch, or `detached`. */
export function branchWord(source: Source): string {
  return source.branch ?? 'detached'
}

/** The whole tooltip: where it runs from, and why it is marked when it is. */
export function sourceHint(source: Source): string {
  const why = offMain(source)
  const where = `Running from ${source.dir}`
  return why.length ? `${where} — ${why.join('; ')}.` : `${where}, on main, level with ${source.upstream ?? 'its branch'}.`
}
