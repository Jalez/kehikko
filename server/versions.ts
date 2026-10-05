import { QUIET_ENV } from './updates.ts'

/**
 * A module's versions: the semver tags on its repository, read without a token.
 *
 * ## What a version is
 *
 * A git tag that reads as semver — `v1.4.0`, `1.4.0`, `v2.0.0-beta.1` — on the
 * repository the module's checkout came from. A module author publishes a
 * version by tagging; nothing new is hosted anywhere. Tags that are not semver
 * (`release-candidate`, `old`) are not versions and are not listed, because the
 * list is sorted newest first and an unsortable name has no place in it.
 *
 * "Latest" is not a tag. It is the module's own checkout, running exactly as it
 * did before versions existed — see `server/versionRuns.ts` for how a tag is
 * run beside it, and `server/pins.ts` for how a container is pointed at one.
 *
 * ## How the list is read
 *
 * `git ls-remote --tags --refs <url>`, which asks the remote for its refs and
 * downloads no objects. The URL is the checkout's own remote, so a public
 * GitHub repository needs nothing, a private one uses the ssh key the person
 * already pulls with, and either way nothing prompts: the same `QUIET_ENV` as
 * `updates.ts`, batch-mode ssh and no terminal.
 *
 * Cached per URL for `TAGS_FRESH_MS`, because a picker opened twice in a minute
 * should not be two round trips to GitHub. A failure is cached for less time,
 * so a person who has just come back online is not told "unreachable" for ten
 * minutes.
 */

/* ------------------------------------------------------------------ *
 * Semver, as much as sorting needs
 * ------------------------------------------------------------------ */

export interface Semver {
  major: number
  minor: number
  patch: number
  /** The pre-release identifiers, e.g. `['beta', '1']`, or empty for a release. */
  pre: string[]
}

/**
 * A tag as it may be written. Bounded so a tag is a short word, as every other
 * string this host stores is: it goes into the database, the project file, a
 * directory name and a header.
 */
export const TAG_MAX = 64
const TAG = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

/** The semver a tag spells, or null when it spells none. Build metadata (`+…`) is refused: it is not a version. */
export function parseTag(tag: string): Semver | null {
  if (typeof tag !== 'string' || tag.length > TAG_MAX) return null
  const m = TAG.exec(tag)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] }
}

/** Whether a string is a tag this host would run. */
export function isVersionTag(tag: unknown): tag is string {
  return typeof tag === 'string' && parseTag(tag) !== null
}

/**
 * Semver precedence: negative when `a` is older than `b`.
 *
 * A pre-release is older than its release (`1.0.0-rc.1` < `1.0.0`); numeric
 * identifiers compare as numbers and sort before alphanumeric ones; a shorter
 * set of identifiers is older when all before it are equal. The rules are
 * semver.org's section 11, and nothing more.
 */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (!a.pre.length && !b.pre.length) return 0
  if (!a.pre.length) return 1
  if (!b.pre.length) return -1
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d
    } else if (xn !== yn) {
      return xn ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/**
 * Version tags, newest first, without duplicates.
 *
 * `v1.2.0` and `1.2.0` are the same version; when a repository has both, the
 * `v` spelling is kept, because it is the one the issue and the picker write.
 * Anything that is not semver is dropped.
 */
export function newestFirst(tags: readonly string[]): string[] {
  const byVersion = new Map<string, { tag: string; v: Semver }>()
  for (const tag of tags) {
    const v = parseTag(tag)
    if (!v) continue
    const key = `${v.major}.${v.minor}.${v.patch}${v.pre.length ? `-${v.pre.join('.')}` : ''}`
    const was = byVersion.get(key)
    if (!was || (!was.tag.startsWith('v') && tag.startsWith('v'))) byVersion.set(key, { tag, v })
  }
  return [...byVersion.values()].sort((a, b) => compareSemver(b.v, a.v)).map((one) => one.tag)
}

/**
 * The tags in what `git ls-remote --tags` printed.
 *
 * One `<sha>\trefs/tags/<name>` per line. With `--refs` there are no peeled
 * `^{}` lines, but they are skipped anyway so the parser is right about output
 * from a call made without it.
 */
export function tagsFromLsRemote(out: string): string[] {
  const names: string[] = []
  for (const line of out.split('\n')) {
    const ref = line.split('\t')[1]?.trim()
    if (!ref || !ref.startsWith('refs/tags/') || ref.endsWith('^{}')) continue
    names.push(ref.slice('refs/tags/'.length))
  }
  return newestFirst(names)
}

/* ------------------------------------------------------------------ *
 * Running git, injected so tests never touch a network or a disk
 * ------------------------------------------------------------------ */

export type Ran = { ok: true; out: string } | { ok: false; why: string }

/** Run a program with no terminal and no prompts. `cwd` defaults to this process's. */
export type Runner = (argv: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<Ran>

export const RUN_TIMEOUT_MS = 20_000

/** The real runner: `Bun.spawn`, the quiet environment, a timeout, and the last lines of stderr as the reason. */
export const run: Runner = async (argv, options = {}) => {
  const timeout = options.timeoutMs ?? RUN_TIMEOUT_MS
  let child
  try {
    child = Bun.spawn([...argv], {
      cwd: options.cwd,
      env: QUIET_ENV,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    })
  } catch (error) {
    return { ok: false, why: `${argv[0]} could not be run: ${(error as Error).message}` }
  }
  const timer = setTimeout(() => child.kill(), timeout)
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timer)
  if (code === 0) return { ok: true, out: out.trim() }
  if (child.signalCode) return { ok: false, why: `${argv.slice(0, 2).join(' ')} took longer than ${Math.round(timeout / 1000)}s and was stopped` }
  return { ok: false, why: (err.trim() || out.trim() || `${argv.slice(0, 2).join(' ')} failed`).split('\n').slice(-3).join(' ') }
}

/**
 * Where a checkout's versions come from: its `origin`, or else its only remote.
 *
 * Read from the checkout the registration names, never from a request. A
 * checkout with several remotes and no `origin` is not guessed at.
 */
export async function remoteOf(dir: string, runner: Runner = run): Promise<string | null> {
  const origin = await runner(['git', '-C', dir, 'remote', 'get-url', 'origin'])
  if (origin.ok && origin.out) return origin.out
  const remotes = await runner(['git', '-C', dir, 'remote'])
  if (!remotes.ok) return null
  const names = remotes.out.split('\n').filter(Boolean)
  if (names.length !== 1) return null
  const url = await runner(['git', '-C', dir, 'remote', 'get-url', names[0]!])
  return url.ok && url.out ? url.out : null
}

/** How long a list of tags is believed. A release is not published every ten minutes. */
export const TAGS_FRESH_MS = 10 * 60_000
/** How long "could not reach it" is believed: briefly, so coming back online is noticed. */
export const TAGS_FAILED_MS = 60_000

export type Tags = { ok: true; tags: string[]; at: number } | { ok: false; why: string; at: number }

/** The tags of each remote, cached. */
export class TagLister {
  #cache = new Map<string, Tags>()
  readonly #runner: Runner
  readonly #now: () => number

  constructor(runner: Runner = run, now: () => number = Date.now) {
    this.#runner = runner
    this.#now = now
  }

  async tags(url: string, fresh = false): Promise<Tags> {
    const was = this.#cache.get(url)
    const now = this.#now()
    if (was && !fresh && now - was.at < (was.ok ? TAGS_FRESH_MS : TAGS_FAILED_MS)) return was
    const ran = await this.#runner(['git', 'ls-remote', '--tags', '--refs', url])
    const got: Tags = ran.ok ? { ok: true, tags: tagsFromLsRemote(ran.out), at: now } : { ok: false, why: ran.why, at: now }
    this.#cache.set(url, got)
    return got
  }

  /** The cached answer, without asking. */
  cached(url: string): Tags | null {
    return this.#cache.get(url) ?? null
  }
}
