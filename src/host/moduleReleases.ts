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
  if (release.target) return `${release.installed ? releaseVersion(release.installed) : 'main'} → ${releaseVersion(release.target)}`
  if (release.follows === 'main') return 'following main · no releases yet'
  if (release.follows === 'ahead' && release.newest) return `running main ahead of ${releaseVersion(release.newest)}`
  const at = release.installed ?? release.newest
  return at ? `up to date · ${releaseVersion(at)}` : 'up to date'
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
 * Said under the line when a newer release needs a newer app, or null:
 * "1.7.0 needs Kehikot 0.1.41 or later; you have 0.1.40." `have.app` is the
 * running app's version, inside the desktop app; elsewhere the host's protocol.
 */
export function needsNewerSaid(release: ModuleRelease, have: { app?: string | null; protocol?: string | null } = {}): string | null {
  if (!release.needsNewer) return null
  const version = releaseVersion(release.needsNewer.tag)
  const works = release.works && Object.hasOwn(release.works, release.needsNewer.tag) ? release.works[release.needsNewer.tag]! : null
  if (works) return needsKehikotSaid(version, works, have)
  return `${version} needs a newer Kehikot (protocol ${protocolSaid(release.needsNewer.protocol)} or later).`
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
  const newer = release.needsNewer ? ` ${release.needsNewer.tag} exists but needs protocol ${release.needsNewer.protocol}, newer than this host has.` : ''
  const unread = release.error ? ` (its releases could not be read just now: ${release.error})` : ''
  if (release.follows === 'main') return `The installed copy follows main: it has no releases yet${unread}.${newer}`
  if (release.follows === 'ahead') {
    return `The installed copy runs main ahead of ${release.newest}, the newest release; it stays there and moves to the first release after it${unread}.${newer}`
  }
  const on = release.installed ? `release ${release.installed}` : 'main'
  if (release.target) return `The installed copy runs ${on}; the newest release this host can run is ${release.target}, which it moves to at its next start${unread}.${newer}`
  return `The installed copy runs ${on}, the newest release this host can run${unread}.${newer}`
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
  const newer = needsNewerSaid(release, { protocol: have.protocol ?? null })
  if (newer && release.works && release.needsNewer && Object.hasOwn(release.works, release.needsNewer.tag)) lines.push(newer)
  return lines
}
