import type { AppUpdateStatus } from './appUpdate.ts'

/**
 * Release notes, the page's side: what the version beside "Kehikot" says,
 * Kehikot's releases as a read-only list, and the two requests behind them.
 * The fetching, the allowlist and the cache are the server's —
 * `server/releaseNotes.ts`. The notes are drawn by `canvas/ReleaseNotes.tsx`
 * through the safe subset in `markdown.ts`.
 */

/** Where Kehikot's own releases are published: the desktop app's repository. */
export const APP_REPO = 'Jalez/kehikko-desktop'
export const APP_NAME = 'Kehikot'

/** One release, as the server reads it. Mirrors `Release` in `server/releaseNotes.ts`. */
export interface Release {
  repo: string
  tag: string
  name: string | null
  body: string
  url: string
  publishedAt: string | null
  prerelease: boolean
}

export type ReleaseSummary = Omit<Release, 'body'>

/**
 * The version beside the name.
 *
 * Inside the desktop app it is the app's own version, as its updater says
 * (`update_status.current`). Anywhere else — a browser tab on a development
 * host — there is no app release to name, so it is the host's own version and
 * says so: "host 0.1.0", never a bare number that reads as a release.
 *
 * `engine` is whether the page runs inside the app at all; while the app has
 * not answered yet (`settled` false) nothing is shown, so the host's version
 * never flashes up where the app's is about to be.
 */
export interface VersionShown {
  kind: 'app' | 'host'
  /** The bare version: `0.1.24`. */
  version: string
  /** The words on the control. */
  text: string
}

export function versionShown(input: {
  app: AppUpdateStatus | null
  engine: boolean
  settled: boolean
  host: string | null
}): VersionShown | null {
  if (input.app?.current) return { kind: 'app', version: input.app.current, text: input.app.current }
  if (input.engine && !input.settled) return null
  if (input.host) return { kind: 'host', version: input.host, text: `host ${input.host}` }
  return null
}

/** What the version says when pointed at. */
export function versionHintFor(shown: VersionShown): string {
  return shown.kind === 'app'
    ? `${APP_NAME} ${shown.version} — press for its releases and what's new`
    : `This page is served by a development host (version ${shown.version}), not a ${APP_NAME} release — press for ${APP_NAME}'s releases`
}

/** The tag a version is released under: `0.1.24` → `v0.1.24`; a tag is left as it is. */
export function tagFor(version: string): string {
  return /^v/i.test(version) ? version : `v${version}`
}

/** Whether a tag and a version name the same release (`v0.1.24` and `0.1.24`). */
export function sameRelease(tag: string, version: string | null | undefined): boolean {
  if (!version) return false
  return tag.replace(/^v/i, '') === version.replace(/^v/i, '')
}

/** One row of Kehikot's releases. */
export interface AppReleaseRow {
  tag: string
  /** `0.1.24`, without the v. */
  version: string
  publishedAt: string | null
  prerelease: boolean
  /** What this computer has to do with it, when anything. */
  mark: 'installed' | 'downloading' | 'ready' | null
}

/**
 * Kehikot's releases, newest first as GitHub lists them, marked: the one this
 * app runs as `installed`, and an update on its way as `downloading` or
 * `ready`. Read-only — the app updates itself; nothing here installs one.
 */
export function appReleaseRows(releases: readonly ReleaseSummary[], app: AppUpdateStatus | null): AppReleaseRow[] {
  const pending =
    app && app.version && (app.state === 'downloading' || app.state === 'installing' || app.state === 'ready')
      ? { version: app.version, mark: app.state === 'ready' ? ('ready' as const) : ('downloading' as const) }
      : null
  return releases.map((one) => ({
    tag: one.tag,
    version: one.tag.replace(/^v/i, ''),
    publishedAt: one.publishedAt,
    prerelease: one.prerelease,
    mark: sameRelease(one.tag, app?.current)
      ? 'installed'
      : pending && sameRelease(one.tag, pending.version)
        ? pending.mark
        : null,
  }))
}

/** "What's new in Kehikot 0.1.24": the dialog's title. */
export function notesTitle(name: string, version: string): string {
  return `What's new in ${name} ${version}`
}

/** The tooltip and accessible name of a notes button. */
export function notesLabel(version: string): string {
  return `Show release notes for ${version}`
}

/** The release page on GitHub, for "Open on GitHub" before or without an answer. */
export function releasePage(repo: string, tag?: string): string {
  return tag ? `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}` : `https://github.com/${repo}/releases`
}

export class NotesTrouble extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly missing: boolean,
  ) {
    super(message)
  }
}

export async function fetchNotes(repo: string, tag: string, signal?: AbortSignal): Promise<Release> {
  const query = new URLSearchParams({ repo, tag })
  const response = await fetch(`/host/release-notes?${query}`, { signal })
  const body = (await response.json().catch(() => null)) as (Release & { error?: string; url?: string }) | null
  if (!response.ok || !body || typeof body.body !== 'string') {
    throw new NotesTrouble(body?.error ?? `the host answered ${response.status}`, body?.url ?? releasePage(repo, tag), response.status === 404)
  }
  return body
}

export async function fetchReleases(repo: string, signal?: AbortSignal): Promise<ReleaseSummary[]> {
  const response = await fetch(`/host/releases?${new URLSearchParams({ repo })}`, { signal })
  const body = (await response.json().catch(() => null)) as { releases?: ReleaseSummary[]; error?: string; url?: string } | null
  if (!response.ok || !body || !Array.isArray(body.releases)) {
    throw new NotesTrouble(body?.error ?? `the host answered ${response.status}`, body?.url ?? releasePage(repo), false)
  }
  return body.releases
}

/** The host's own version, from `/host/health`; null when it does not say. */
export async function fetchHostVersion(signal?: AbortSignal): Promise<string | null> {
  const response = await fetch('/host/health', { signal, cache: 'no-store' })
  const body = (await response.json().catch(() => null)) as { version?: unknown } | null
  return response.ok && typeof body?.version === 'string' ? body.version : null
}

/**
 * Open a web address in the person's browser.
 *
 * In a browser tab this is a new tab. In the desktop app it is the same call:
 * the shell answers every request for a new window by handing a web address to
 * the operating system's opener — the default browser — and opening no window
 * of its own (kehikko-desktop `src-tauri/src/links.rs`). Only `https:` is
 * opened from here; anything else is refused and false is returned.
 */
export function openExternal(url: string, open: (url: string) => unknown = (one) => window.open(one, '_blank', 'noopener,noreferrer')): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  open(parsed.href)
  return true
}

/** "19 Oct 2026", for a release row. */
export function releaseDate(at: string | null): string | null {
  if (!at) return null
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}
