import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { protocolPin } from './moduleReleases.ts'
import { HOST_REPO } from './official.ts'
import type { Runner } from './versions.ts'
import { appsInOrder, compareVersions, type AppProtocol } from '../src/host/worksWith.ts'

/**
 * Which protocol package each Kehikot app release shipped — so a module
 * release can be said to work with "Kehikot 0.1.39 and later"
 * (`src/host/worksWith.ts`).
 *
 * ## Where it is read
 *
 * Every app release tags the host commit it was built from: `app-v<version>`
 * in this repository (the desktop release workflow makes the tag). That
 * commit's `package.json` pins `kehikot-module-protocol`, read with the rule a
 * module release's pin is read with (`protocolPin`). So:
 *
 *  - the tags: `git ls-remote --tags` on the repository, through the person's
 *    git — read-only, nothing cloned;
 *  - each tag's `package.json`: `raw.githubusercontent.com` at the tag's
 *    COMMIT, redirects refused, bounded; through the person's `gh api` only
 *    when that is refused. A commit does not change, so a tag read once is
 *    never asked again.
 *
 * An app built before the protocol was pinned (`#main`) shipped no version
 * anybody can name; it is kept as read (so it is not asked again) and left out
 * of the mapping.
 *
 * ## How often
 *
 * At most once a day after a good reading, and an hour after a failed one;
 * only when somebody asks (start, a check for updates) — never on a timer.
 * The last good mapping is kept in memory and in the machine directory
 * (`appProtocolsFile`), so a start with no network still says app versions.
 * When the running app is newer than the newest tag read, the day's wait is
 * skipped, at most once an hour (`catchUpAfter`). Nothing waits long for it and nothing fails with it: when it cannot be
 * built, the words fall back to the protocol ("Needs protocol 2.6 or later").
 *
 * ## Off
 *
 * `KEHIKOT_APP_PROTOCOLS=off` asks nobody and reads no cache: the test suite
 * sets it, as it sets `KEHIKOT_OFFICIAL_LIST=off`.
 */

export const APP_TAG = /^app-v(\d{1,6}\.\d{1,6}\.\d{1,6})$/
export const REFRESH_EVERY_MS = 24 * 60 * 60_000
export const RETRY_AFTER_MS = 60 * 60_000
export const LS_REMOTE_TIMEOUT_MS = 15_000
export const FETCH_TIMEOUT_MS = 5_000
/** A host `package.json` is under 2 KB; anything this big is not one. */
export const MAX_BYTES = 64 * 1024
/** At most this many tags are read in one refresh; the rest wait for the next. */
export const MAX_READS = 100
const COMMIT = /^[0-9a-f]{40}$/

/** One app tag as read: the commit it names and the protocol its `package.json` pins (null: none that reads). */
export interface ReadTag {
  commit: string
  protocol: string | null
}

/** Whether this host asks at all: `KEHIKOT_APP_PROTOCOLS=off` turns it off. */
export function appProtocolsOn(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(off|none|0|false)$/i.test(env.KEHIKOT_APP_PROTOCOLS?.trim() ?? '')
}

/**
 * The app tags in `git ls-remote --tags` output, each with the COMMIT it names:
 * an annotated tag's peeled line (`^{}`) wins over the tag object's own.
 */
export function appTagsFromLsRemote(out: string): Map<string, string> {
  const object = new Map<string, string>()
  const peeled = new Map<string, string>()
  for (const line of out.split('\n')) {
    const [sha, ref] = line.trim().split('\t')
    if (!sha || !ref || !COMMIT.test(sha) || !ref.startsWith('refs/tags/')) continue
    let name = ref.slice('refs/tags/'.length)
    const isPeeled = name.endsWith('^{}')
    if (isPeeled) name = name.slice(0, -3)
    if (!APP_TAG.test(name)) continue
    ;(isPeeled ? peeled : object).set(name, sha)
  }
  const tags = new Map<string, string>()
  for (const [name, sha] of object) tags.set(name, peeled.get(name) ?? sha)
  for (const [name, sha] of peeled) if (!tags.has(name)) tags.set(name, sha)
  return tags
}

/** The mapping from what was read: app version → protocol, oldest app first; null when it says nothing. */
export function appProtocolsFrom(read: ReadonlyMap<string, ReadTag> | Record<string, ReadTag>): AppProtocol[] | null {
  const entries = read instanceof Map ? [...read.entries()] : Object.entries(read)
  const apps: AppProtocol[] = []
  for (const [tag, one] of entries) {
    const app = APP_TAG.exec(tag)?.[1]
    if (app && one.protocol) apps.push({ app, protocol: one.protocol })
  }
  const ordered = appsInOrder(apps)
  return ordered.length ? ordered : null
}

export interface AppProtocolDeps {
  /** git, quiet. */
  run: Runner
  /** Where the last good reading is kept; null keeps none. */
  cache: string | null
  /** `owner/repo` of the host; `HOST_REPO`. */
  repo?: string
  /** False asks nobody and reads no cache. */
  on?: boolean
  fetch?: (url: string, init: { signal: AbortSignal; redirect: 'error'; headers: Record<string, string> }) => Promise<Response>
  /** The same file through the person's `gh` (`gh api repos/…/contents/package.json?ref=…`), the JSON or null. */
  gh?(path: string): Promise<unknown | null>
  now?(): number
  log?(line: string): void
}

export interface AppProtocolStanding {
  /** App version → protocol, oldest first; null when none is known. */
  apps: AppProtocol[] | null
  /** When the tags were last read; null when they never were. */
  read: string | null
  /** True when the last ask failed, so a newer app may be missing. */
  stale: boolean
}

async function bounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (declared > MAX_BYTES) throw new Error(`${declared} bytes`)
  const text = await response.text()
  if (text.length > MAX_BYTES) throw new Error(`more than ${MAX_BYTES} bytes`)
  return text
}

export function appProtocolSource(deps: AppProtocolDeps) {
  const on = deps.on ?? true
  const repo = deps.repo ?? HOST_REPO
  const now = deps.now ?? Date.now
  const ask = deps.fetch ?? ((url, init) => fetch(url, init))
  const remote = `https://github.com/${repo}.git`

  let tags: Record<string, ReadTag> = {}
  let readAt: string | null = null
  let stale = false
  let notBefore = 0
  let inFlight: Promise<void> | null = null
  /* Catching up with a newer running app: at most once per RETRY_AFTER_MS, so a tag that is not published yet costs one ls-remote an hour. */
  let catchUpAfter = 0

  /* The last good reading, re-checked: it is a file on a disk. */
  if (on && deps.cache) {
    try {
      const kept = JSON.parse(readFileSync(deps.cache, 'utf8')) as { from?: unknown; read?: unknown; tags?: unknown }
      if (kept.from === repo && typeof kept.read === 'string' && !Number.isNaN(Date.parse(kept.read)) && kept.tags && typeof kept.tags === 'object') {
        for (const [tag, one] of Object.entries(kept.tags as Record<string, unknown>)) {
          const read = one as { commit?: unknown; protocol?: unknown }
          if (!APP_TAG.test(tag) || typeof read.commit !== 'string' || !COMMIT.test(read.commit)) continue
          const protocol = typeof read.protocol === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(read.protocol) ? read.protocol : null
          tags[tag] = { commit: read.commit, protocol }
        }
        readAt = kept.read
        notBefore = Date.parse(kept.read) + REFRESH_EVERY_MS
      }
    } catch {
      /* No cache, or not one to use. */
    }
  }

  async function packageAt(commit: string): Promise<string | null> {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await ask(`https://raw.githubusercontent.com/${repo}/${commit}/package.json`, {
        signal: abort.signal,
        redirect: 'error',
        headers: { 'user-agent': 'kehikot-host' },
      })
      if (response.ok) return await bounded(response)
    } catch {
      /* Asked again through gh, below. */
    } finally {
      clearTimeout(timer)
    }
    if (!deps.gh) return null
    const got = (await deps.gh(`repos/${repo}/contents/package.json?ref=${commit}`).catch(() => null)) as { content?: unknown; encoding?: unknown } | null
    if (!got || typeof got.content !== 'string' || got.encoding !== 'base64') return null
    const text = Buffer.from(got.content, 'base64').toString('utf8')
    return text.length > MAX_BYTES ? null : text
  }

  async function once(): Promise<void> {
    const listed = await deps.run(['git', 'ls-remote', '--tags', remote, 'refs/tags/app-v*'], { timeoutMs: LS_REMOTE_TIMEOUT_MS })
    if (!listed.ok) throw new Error(listed.why)
    const found = appTagsFromLsRemote(listed.out)
    const next: Record<string, ReadTag> = {}
    const toRead: [string, string][] = []
    for (const [tag, commit] of found) {
      const had = tags[tag]
      if (had && had.commit === commit) next[tag] = had
      else toRead.push([tag, commit])
    }
    let missed = 0
    const batch = toRead.slice(0, MAX_READS)
    for (let i = 0; i < batch.length; i += 8) {
      await Promise.all(
        batch.slice(i, i + 8).map(async ([tag, commit]) => {
          const pkg = await packageAt(commit)
          if (pkg === null) {
            missed++
            return
          }
          next[tag] = { commit, protocol: protocolPin(pkg) }
        }),
      )
    }
    if (found.size > 0 && Object.keys(next).length === 0) throw new Error('no app tag could be read')
    tags = next
    readAt = new Date(now()).toISOString()
    if (missed > 0 || toRead.length > batch.length) {
      stale = true
      notBefore = now() + RETRY_AFTER_MS
    } else {
      stale = false
      notBefore = now() + REFRESH_EVERY_MS
    }
    if (!deps.cache) return
    try {
      mkdirSync(dirname(deps.cache), { recursive: true })
      const tmp = `${deps.cache}.writing-${process.pid}`
      writeFileSync(tmp, `${JSON.stringify({ from: repo, read: readAt, tags }, null, 2)}\n`)
      renameSync(tmp, deps.cache)
    } catch (error) {
      deps.log?.(`the app protocol mapping could not be kept at ${deps.cache}: ${(error as Error).message}`)
    }
  }

  /** Read the tags again, unless they were read today (or failed within the hour). Never rejects. */
  function refresh(running?: string | null): Promise<void> {
    if (!on) return Promise.resolve()
    if (inFlight) return inFlight
    if (now() < notBefore) {
      /* The running app is newer than the newest app read: the day's rest does not apply. Within the budget above. */
      if (!(running && now() >= catchUpAfter && behind(running))) return Promise.resolve()
      catchUpAfter = now() + RETRY_AFTER_MS
    }
    inFlight = once()
      .catch((error: unknown) => {
        stale = true
        notBefore = now() + RETRY_AFTER_MS
        deps.log?.(`the Kehikot app tags of ${repo} were not read: ${(error as Error).message}`)
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  /** Whether `running` is newer than every app the tags read so far name. */
  function behind(running: string): boolean {
    const newest = appProtocolsFrom(tags)?.at(-1)?.app
    return !newest || compareVersions(running, newest) > 0
  }

  /** `refresh`, waited for at most `ms`: what a reader that must answer soon uses. */
  async function settled(ms: number, running?: string | null): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([refresh(running), new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))])
    clearTimeout(timer)
  }

  return {
    /** App version → protocol, oldest first; null when none is known. */
    apps: (): AppProtocol[] | null => appProtocolsFrom(tags),
    standing: (): AppProtocolStanding => ({ apps: appProtocolsFrom(tags), read: readAt, stale }),
    refresh,
    settled,
  }
}

export type AppProtocolSource = ReturnType<typeof appProtocolSource>
