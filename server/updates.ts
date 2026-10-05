import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Whether the programs this host runs are behind what is on GitHub, and
 * bringing them level.
 *
 * ## What "the installed version" is here
 *
 * Nothing is built or bundled. The desktop app runs `run.sh` in a checkout, and
 * the host runs each module's `run.sh` in its checkout, so the version a person
 * is looking at IS whatever those working trees have checked out. An update is
 * therefore not a download: it is the checkout catching up with the branch it
 * tracks. This reads each one — the host's own, and every registered module
 * that names a `dir` — and says how far behind it is.
 *
 * ## What an update will and will not do
 *
 * `git merge --ff-only` onto the branch's own upstream, and nothing else. It
 * refuses a checkout with uncommitted changes, one with commits of its own that
 * are not pushed, one on no tracked branch, and one already level — each with a
 * sentence, because these are somebody's working trees and the right response
 * to any of those is a person deciding, not this host merging. Untracked files
 * do not block it; git itself refuses if one would be overwritten, and that
 * refusal is passed on.
 *
 * ## No prompts, ever
 *
 * Every git call runs with `GIT_TERMINAL_PROMPT=0` and ssh in batch mode, so a
 * remote that wants a password fails and says so instead of hanging a server
 * that has no terminal to ask in.
 */

export interface Incoming {
  hash: string
  subject: string
}

export interface Checkout {
  /** `host`, or the module's registration id. What an update names. */
  id: string
  name: string
  dir: string
  /** Null when detached. */
  branch: string | null
  commit: string
  /** Changes to tracked files. Untracked files are not counted. */
  dirty: boolean
  /**
   * The only tracked change is `bun.lock`, which a plain `bun install` run by a
   * `run.sh` rewrites when it re-resolves a git dependency. Nobody edited it,
   * so an update resets it instead of refusing.
   */
  staleLock?: boolean
  /** `origin/main`, or null when the branch tracks nothing. */
  upstream: string | null
  behind: number
  ahead: number
  /** The newest commits not yet here, at most `INCOMING_MAX`. */
  incoming: Incoming[]
  /** Why the remote could not be read just now, when it could not. */
  fetchFailed: string | null
  /** Why `update` would refuse, or null when it would go ahead. */
  blocked: string | null
}

export interface Unreadable {
  id: string
  name: string
  dir: string
  error: string
}

export type Reading = Checkout | Unreadable

export interface Place {
  id: string
  name: string
  dir: string
}

const INCOMING_MAX = 10
const FETCH_TIMEOUT_MS = 20_000
const LOCAL_TIMEOUT_MS = 10_000

/** No terminal to prompt in, so nothing may prompt. */
export const QUIET_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
}

export const CANCELLED = 'cancelled'

type Ran = { ok: true; out: string } | { ok: false; why: string }

async function git(dir: string, args: string[], timeout = LOCAL_TIMEOUT_MS, signal?: AbortSignal): Promise<Ran> {
  if (signal?.aborted) return { ok: false, why: CANCELLED }
  const child = Bun.spawn(['git', '-C', dir, ...args], {
    env: QUIET_ENV,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  const timer = setTimeout(() => child.kill(), timeout)
  /* A person pressing Cancel closes the request, and the git it started goes
     with it rather than finishing a fetch nobody is waiting for. */
  const stop = () => child.kill()
  signal?.addEventListener('abort', stop, { once: true })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timer)
  signal?.removeEventListener('abort', stop)
  if (code === 0) return { ok: true, out: out.trim() }
  if (signal?.aborted) return { ok: false, why: CANCELLED }
  if (child.signalCode) return { ok: false, why: `git ${args[0]} took longer than ${timeout / 1000}s and was stopped` }
  return { ok: false, why: (err.trim() || out.trim() || `git ${args[0]} failed`).split('\n').slice(-3).join(' ') }
}

/**
 * When each repository was last fetched. A page polling, a second window and a
 * person pressing "check now" should not become three fetches in a minute.
 */
const fetchedAt = new Map<string, number>()
const FETCH_AT_MOST_EVERY_MS = 60_000

/** The places worth reading: one per repository, the first name kept. */
export async function topLevels(places: readonly Place[]): Promise<{ places: Place[]; unreadable: Unreadable[] }> {
  const seen = new Set<string>()
  const out: Place[] = []
  const unreadable: Unreadable[] = []
  for (const place of places) {
    if (!existsSync(place.dir)) {
      unreadable.push({ ...place, error: `${place.dir} is not there` })
      continue
    }
    const top = await git(place.dir, ['rev-parse', '--show-toplevel'])
    if (!top.ok) {
      unreadable.push({ ...place, error: 'not a git checkout, so there is nothing to compare it with' })
      continue
    }
    if (seen.has(top.out)) continue
    seen.add(top.out)
    out.push({ ...place, dir: top.out })
  }
  return { places: out, unreadable }
}

/** One checkout, read; fetched first when `fetch` and not fetched in the last minute. */
export async function readCheckout(place: Place, fetch: boolean, signal?: AbortSignal): Promise<Reading> {
  const { dir } = place
  const head = await git(dir, ['rev-parse', '--short', 'HEAD'])
  if (!head.ok) return { ...place, error: head.why }

  const branchRead = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const branch = branchRead.ok ? branchRead.out : null

  const upstreamRead = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  const upstream = upstreamRead.ok ? upstreamRead.out : null

  let fetchFailed: string | null = null
  if (fetch && upstream) {
    const last = fetchedAt.get(dir) ?? 0
    if (Date.now() - last > FETCH_AT_MOST_EVERY_MS) {
      const remote = upstream.split('/')[0] ?? 'origin'
      const fetched = await git(dir, ['fetch', '--quiet', '--no-tags', remote], FETCH_TIMEOUT_MS, signal)
      if (fetched.ok) fetchedAt.set(dir, Date.now())
      else fetchFailed = fetched.why
    }
  }

  const status = await git(dir, ['status', '--porcelain', '--untracked-files=no'])
  const dirty = status.ok ? status.out.length > 0 : false
  const staleLock = status.ok && dirty && onlyLockfile(status.out)

  let ahead = 0
  let behind = 0
  let incoming: Incoming[] = []
  if (upstream) {
    const counts = await git(dir, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])
    if (counts.ok) {
      const [a, b] = counts.out.split(/\s+/).map(Number)
      ahead = a || 0
      behind = b || 0
    }
    if (behind > 0) {
      const log = await git(dir, ['log', `-n${INCOMING_MAX}`, '--format=%h%x09%s', 'HEAD..@{u}'])
      if (log.ok && log.out) {
        incoming = log.out.split('\n').map((line) => {
          const [hash, ...rest] = line.split('\t')
          return { hash: hash ?? '', subject: rest.join('\t') }
        })
      }
    }
  }

  const checkout: Checkout = {
    ...place,
    branch,
    commit: head.out,
    dirty,
    staleLock,
    upstream,
    behind,
    ahead,
    incoming,
    fetchFailed,
    blocked: null,
  }
  checkout.blocked = blockedBy(checkout)
  return checkout
}

/** Whether `git status --porcelain` lists `bun.lock` and nothing else. */
function onlyLockfile(porcelain: string): boolean {
  const lines = porcelain.split('\n').filter(Boolean)
  /* `git()` trims the output, which eats the leading space of ` M bun.lock`; only an unstaged edit counts. */
  return lines.length === 1 && lines[0] === 'M bun.lock'
}

/** Why an update would refuse, as a sentence, or null when it would go ahead. */
export function blockedBy(c: Pick<Checkout, 'branch' | 'upstream' | 'dirty' | 'ahead' | 'behind'> & { staleLock?: boolean }): string | null {
  if (!c.branch) return 'not on a branch (a detached checkout), so there is nothing to catch up with'
  if (!c.upstream) return `the branch ${c.branch} tracks no remote branch`
  if (c.dirty && !c.staleLock) return 'there are uncommitted changes; commit or stash them first'
  if (c.ahead > 0)
    return `${c.branch} has ${c.ahead} commit${c.ahead === 1 ? '' : 's'} of its own that ${c.upstream} does not — pull or push it by hand`
  if (c.behind === 0) return 'already up to date'
  return null
}

export interface Updated {
  ok: true
  checkout: Reading
  /** Files the update changed, relative to the checkout. */
  changed: string[]
  /** Whether `bun install` ran because the dependencies changed. */
  installed: boolean
  /** Why install failed, when it did. The update itself still happened. */
  installFailed: string | null
  /** `bun.lock` held only an install's rewrite and was reset before merging. */
  lockfileReset: boolean
}

export type Updating = Updated | { ok: false; why: string; status: number }

/**
 * Bring one checkout level with its upstream, fast-forward only.
 *
 * Re-read first, without fetching — the page decided from a reading that may be
 * minutes old, and this must decide from the disk as it is now. When
 * `package.json` or `bun.lock` changed and the checkout uses bun, `bun install`
 * runs, because `run.sh` only installs when `node_modules` is missing and new
 * code beside old dependencies fails in ways that look like anything but that.
 *
 * ## Cancelling
 *
 * Up to the merge, a cancel means nothing changed. The merge itself is one
 * quick local step and is not interrupted halfway. After it, a cancel stops
 * the `bun install` and says so — the code has moved, and the dependencies
 * will be installed by the next update or by hand.
 */
export async function update(place: Place, signal?: AbortSignal): Promise<Updating> {
  const before = await readCheckout(place, false)
  if ('error' in before) return { ok: false, why: before.error, status: 409 }
  if (before.blocked) return { ok: false, why: `${place.name} was not updated: ${before.blocked}.`, status: 409 }

  const from = await git(place.dir, ['rev-parse', 'HEAD'])
  if (!from.ok) return { ok: false, why: from.why, status: 500 }

  if (signal?.aborted) return { ok: false, why: `Cancelled — ${place.name} was not changed.`, status: 499 }
  /* The lock is install residue, not work: take it back so the merge can move,
     and install afterwards because node_modules may match the discarded lock. */
  const lockfileReset = before.staleLock === true
  if (lockfileReset) {
    const reset = await git(place.dir, ['checkout', '--', 'bun.lock'])
    if (!reset.ok) return { ok: false, why: `${place.name} was not updated: could not reset bun.lock: ${reset.why}`, status: 409 }
  }
  const merged = await git(place.dir, ['merge', '--ff-only', '--quiet', '@{u}'])
  if (!merged.ok) return { ok: false, why: `${place.name} was not updated: ${merged.why}`, status: 409 }

  const diff = await git(place.dir, ['diff', '--name-only', from.out, 'HEAD'])
  const changed = diff.ok && diff.out ? diff.out.split('\n') : []

  let installed = false
  let installFailed: string | null = null
  const dependencies = lockfileReset || changed.some((file) => file === 'package.json' || file === 'bun.lock')
  if (dependencies && existsSync(join(place.dir, 'bun.lock'))) {
    const child = Bun.spawn(['bun', 'install'], { cwd: place.dir, stdout: 'ignore', stderr: 'pipe', env: process.env })
    const stop = () => child.kill()
    signal?.addEventListener('abort', stop, { once: true })
    const err = await new Response(child.stderr).text()
    const code = await child.exited
    signal?.removeEventListener('abort', stop)
    if (code === 0) installed = true
    else if (signal?.aborted) installFailed = 'cancelled while installing dependencies — run `bun install` there before restarting it'
    else installFailed = err.trim().split('\n').slice(-2).join(' ') || 'bun install failed'
  }

  return { ok: true, checkout: await readCheckout(place, false), changed, installed, installFailed, lockfileReset }
}

/**
 * Whether the host's own server has to be restarted to run what was pulled.
 *
 * The page is served by Vite in dev mode and reloads itself when its files
 * change; the server is a bun process that read its code once, at start.
 */
export function hostNeedsRestart(changed: readonly string[]): boolean {
  return changed.some(
    (file) => file.startsWith('server/') || file === 'package.json' || file === 'bun.lock' || file === 'run.sh',
  )
}
