/**
 * Which release an installed module runs, in words — shared by the server
 * (`server/moduleReleases.ts`, which decides), the Updates menu and the MCP
 * door. Pure: nothing here runs git or asks GitHub.
 *
 * ## What a module release is
 *
 * An annotated tag `vX.Y.Z` on the module's `main`, whose `package.json`
 * says `X.Y.Z`, and a GitHub Release named "<Module> X.Y.Z" with the notes.
 * A pre-release (`v2.0.0-beta.1`) is not one: an installed copy never moves to
 * it. A repository with no such tag has no releases yet, and its installed
 * copy follows `main` as every copy did before releases.
 *
 * ## The three ways an installed copy can be
 *
 * - `release`: on a release (checked out at its tag), or about to move to one.
 * - `main`: the repository has no release yet; the copy follows `main`.
 * - `ahead`: the copy is on a `main` commit newer than the newest release —
 *   what a copy installed before releases existed can be. It is held where it
 *   is, never moved back to an older release, and moves to the first release
 *   that contains it.
 *
 * ## Which Kehikot a release works with
 *
 * `works` says it per release (`src/host/worksWith.ts`): the first app whose
 * protocol meets the release's need, "Works with Kehikot 0.1.39 and later".
 */

import { needsKehikotSaid, protocolSaid, worksWithSaid, type WorksWith } from './worksWith.ts'

export type Follows = 'release' | 'main' | 'ahead'

export interface ModuleRelease {
  follows: Follows
  /** The release the copy is checked out at (`v1.5.0`), or null when it is on `main`. */
  installed: string | null
  /** The newest release this host can run, or null when there is none. */
  newest: string | null
  /** The release an update moves the copy to, or null when there is nothing to move to. */
  target: string | null
  /**
   * The releases whose notes "What's new" shows, newest first: every release
   * after the installed one up to the target, or the installed one alone when
   * the copy is up to date.
   */
  notes: string[]
  /** The newest release this host cannot run yet, and the protocol package it needs. */
  needsNewer: { tag: string; protocol: string } | null
  /** `owner/repo` on GitHub, where the release notes are; null elsewhere. */
  repo: string | null
  /** Why the releases could not be read just now, when they could not. */
  error: string | null
  /**
   * Which Kehikot each release named above works with — installed, newest,
   * target, every one in `notes`, and `needsNewer` — by tag. A release that
   * states no protocol need has no entry. Absent from a host that does not
   * read the app tags.
   */
  works?: Record<string, WorksWith>
  /**
   * The release it is on needs a newer Kehikot than this one, and an older
   * release works here: the one it steps back to. `ask` null: it moves like an
   * update, and `target` is `to`. Otherwise `target` is null and `ask` is the
   * risk the person is told before they press "Step back". Absent otherwise,
   * and from an older host.
   */
  back?: { to: string; ask: string | null }
}

const RELEASE = /^v(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/

/** Whether a tag is a module release: `vX.Y.Z`, no pre-release, no build metadata. */
export function isRelease(tag: unknown): tag is string {
  return typeof tag === 'string' && RELEASE.test(tag)
}

/** `v1.6.0` → `1.6.0`. */
export function releaseVersion(tag: string): string {
  return tag.replace(/^v/, '')
}

function triple(tag: string): [number, number, number] {
  const m = RELEASE.exec(tag)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1]
}

/** Negative when release `a` is older than release `b`. */
export function compareReleases(a: string, b: string): number {
  const x = triple(a)
  const y = triple(b)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return 0
}

/** The releases among some tags, newest first, without duplicates. Pre-releases and anything else are left out. */
export function releasesNewestFirst(tags: readonly string[]): string[] {
  return [...new Set(tags.filter(isRelease))].sort((a, b) => compareReleases(b, a))
}

/**
 * The releases an update moved through, newest first: every release among
 * `tags` after `from` up to and including `to`. When the list has none of them
 * (unread, or the move was off `main`), the release it arrived at alone.
 */
export function releasesMoved(from: string | null, to: string, tags: readonly string[]): string[] {
  const arrived = to.startsWith('v') ? to : `v${to}`
  const left = from === null ? null : from.startsWith('v') ? from : `v${from}`
  if (!isRelease(arrived)) return []
  const among = releasesNewestFirst(tags).filter((tag) => compareReleases(tag, arrived) <= 0 && (left === null || !isRelease(left) || compareReleases(tag, left) > 0))
  return among.length ? among : [arrived]
}

/**
 * What the Updates menu says beside a module's name:
 *
 * - "1.5.0 → 1.6.0" (or "main → 1.6.0" for a copy leaving `main`),
 * - "up to date · 1.6.0",
 * - "following main · no releases yet",
 * - "running main ahead of 1.6.0".
 */
export function releaseSaid(release: ModuleRelease): string {
  if (release.target && release.back) return `${release.installed ? releaseVersion(release.installed) : 'main'} → back to ${releaseVersion(release.target)}`
  if (release.back && release.installed) return `${releaseVersion(release.installed)} needs a newer Kehikot`
  if (release.target) return `${release.installed ? releaseVersion(release.installed) : 'main'} → ${releaseVersion(release.target)}`
  if (release.follows === 'main') return 'following main · no releases yet'
  if (release.follows === 'ahead' && release.newest) return `running main ahead of ${releaseVersion(release.newest)}`
  const at = release.installed ?? release.newest
  /* A newer release exists that this Kehikot cannot run: "up to date" alone would read as "nothing newer". */
  const upToDate = release.needsNewer ? 'up to date for this Kehikot' : 'up to date'
  return at ? `${upToDate} · ${releaseVersion(at)}` : upToDate
}

/** The question on a step back that waits for a press: "Step back to 1.4.0?", or null when there is none. */
export function stepBackAsked(release: ModuleRelease): string | null {
  return release.back && release.back.ask !== null && !release.target ? `Step back to ${releaseVersion(release.back.to)}?` : null
}

/** Said once a copy was moved back on its own: "<name> was moved back to 1.4.0, which works with this Kehikot." */
export function steppedBackSaid(name: string, to: string): string {
  return `${name} was moved back to ${releaseVersion(to)}, which works with this Kehikot.`
}

/** The whole line: "Journeys 1.5.0 → 1.6.0", "Journeys up to date · 1.6.0". */
export function releaseLine(name: string, release: ModuleRelease): string {
  return `${name} ${releaseSaid(release)}`
}

/** "Works with Kehikot 0.1.39 and later" for one release, or null when it is not known. */
export function worksSaid(release: ModuleRelease, tag: string | null): string | null {
  if (!tag || !release.works || !Object.hasOwn(release.works, tag)) return null
  return worksWithSaid(release.works[tag]!)
}

/** The release a row speaks of: the one an update moves to, else the one it runs, else the newest. */
export function releaseInView(release: ModuleRelease): string | null {
  return release.target ?? release.installed ?? release.newest
}

/**
 * Said once under the line when a newer release needs a newer app, or null:
 * "1.7.0 is out; it needs Kehikot 0.1.41 or later (you have 0.1.40)." When no
 * app has it yet: "1.7.0 is out; it needs a Kehikot newer than 0.1.40." The
 * protocol is the tooltip (`needsNewerTip`), not the sentence.
 */
export function needsNewerSaid(release: ModuleRelease, have: { app?: string | null; protocol?: string | null } = {}): string | null {
  if (!release.needsNewer) return null
  const version = releaseVersion(release.needsNewer.tag)
  const works = release.works && Object.hasOwn(release.works, release.needsNewer.tag) ? release.works[release.needsNewer.tag]! : null
  if (works?.kind === 'from') return `${version} is out; it needs Kehikot ${works.from} or later${have.app ? ` (you have ${have.app})` : ''}.`
  if (works?.kind === 'unreleased') return `${version} is out; it needs a Kehikot newer than ${works.newest.app}.`
  return `${version} is out; it needs a newer Kehikot.`
}

/** The protocol behind `needsNewerSaid`, for a tooltip: "Module protocol 2.37 or later is needed; this Kehikot has module protocol 2.36." */
export function needsNewerTip(release: ModuleRelease, have: { app?: string | null; protocol?: string | null } = {}): string | null {
  if (!release.needsNewer) return null
  const has = have.protocol ? `; this Kehikot has module protocol ${protocolSaid(have.protocol)}` : ''
  return `Module protocol ${protocolSaid(release.needsNewer.protocol)} or later is needed${has}.`
}

/** What an agent is told of the release this Kehikot cannot run: the app and the protocol, in one sentence. */
function needsNewerForAgents(release: ModuleRelease, have: { app?: string | null; protocol?: string | null }): string | null {
  if (!release.needsNewer) return null
  const version = releaseVersion(release.needsNewer.tag)
  const works = release.works && Object.hasOwn(release.works, release.needsNewer.tag) ? release.works[release.needsNewer.tag]! : null
  if (works) return needsKehikotSaid(version, works, have)
  return `${version} needs a newer Kehikot (module protocol ${protocolSaid(release.needsNewer.protocol)} or later).`
}

/** "1.14.0 works with Kehikot 0.1.95 and later": `worksSaid` bound to the version it speaks of. */
export function worksLineSaid(release: ModuleRelease, tag: string | null): string | null {
  const said = worksSaid(release, tag)
  return said && tag ? `${releaseVersion(tag)} ${said[0]!.toLowerCase()}${said.slice(1)}` : null
}

/** The title of the notes dialog: "What's new in Journeys 1.6.0", or "…1.5.0 → 1.6.0" over several. */
export function releaseNotesTitle(name: string, tags: readonly string[]): string {
  if (tags.length === 0) return `What's new in ${name}`
  if (tags.length === 1) return `What's new in ${name} ${releaseVersion(tags[0]!)}`
  return `What's new in ${name} ${releaseVersion(tags[tags.length - 1]!)} → ${releaseVersion(tags[0]!)}`
}

/** What `module_versions` tells an agent about the installed copy's releases. */
export function releaseForAgents(release: ModuleRelease, have: { protocol?: string | null } = {}): string {
  return [releaseStanding(release), ...worksForAgents(release, have)].join(' ')
}

function releaseStanding(release: ModuleRelease): string {
  const newer = release.needsNewer ? ` ${release.needsNewer.tag} exists but needs a newer Kehikot than this one (module protocol ${release.needsNewer.protocol}).` : ''
  const unread = release.error ? ` (its releases could not be read just now: ${release.error})` : ''
  if (release.follows === 'main') return `The installed copy follows main: it has no releases yet${unread}.${newer}`
  if (release.follows === 'ahead') {
    return `The installed copy runs main ahead of ${release.newest}, the newest release; it stays there and moves to the first release after it${unread}.${newer}`
  }
  const on = release.installed ? `release ${release.installed}` : 'main'
  if (release.back && release.target) {
    return `The installed copy runs ${on}, which needs a newer Kehikot than this one; it steps back to ${release.target}, the newest release this Kehikot can run, at its next start${unread}.`
  }
  if (release.back) {
    return `The installed copy runs ${on}, which needs a newer Kehikot than this one. ${release.back.to} works here, but stepping back waits for the person: ${release.back.ask}${unread}`
  }
  if (release.target) return `The installed copy runs ${on}; the newest release this Kehikot can run is ${release.target}, which it moves to at its next start${unread}.${newer}`
  return `The installed copy runs ${on}, the newest release this Kehikot can run${unread}.${newer}`
}

/** One sentence per release an agent is told about: installed, the newest it can run, and the one it cannot. */
function worksForAgents(release: ModuleRelease, have: { protocol?: string | null }): string[] {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const tag of [release.installed, release.target ?? release.newest]) {
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    const said = worksSaid(release, tag)
    if (said) lines.push(`${tag}: ${said}.`)
  }
  const newer = needsNewerForAgents(release, { protocol: have.protocol ?? null })
  if (newer && release.works && release.needsNewer && Object.hasOwn(release.works, release.needsNewer.tag)) lines.push(newer)
  return lines
}
