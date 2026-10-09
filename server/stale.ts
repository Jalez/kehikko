import type { Build } from 'kehikot-module-protocol'

import { restartDecision, serverGraph } from './restart.ts'
import { changedBetween, headOf } from './updates.ts'

/**
 * Whether a module is running older code than its checkout holds.
 *
 * ## What answers
 *
 * The module's own build identity, when it states one: the commit its server
 * process started on (`build.commit`, in its manifest and its `/healthz`).
 * `behindCheckout` compares that with the checkout's `HEAD` and, where they
 * differ, asks the same rule an update asks (`restartDecision` in
 * `restart.ts`) whether what changed between them is loaded by the server. A
 * commit that only moved the page is not stale: Vite serves the page as it is
 * on disk. The answer is `judged` here and is what `staleness` returns.
 *
 * ## The fallback, for a module that does not say
 *
 * Only what this host did. An update that needed a restart and could not give
 * it one — the registration says `keep`, the process is somebody else's, the
 * start failed — is recorded with its sentence (`leftBehind`), and forgotten
 * when the module is next started or found not running. It is lost with the
 * host process, and it is a "may": the host cannot see which code a process
 * holds. A module that states a build is never judged by it.
 *
 * ## The seam
 *
 * `staleness` is the one question — "is this module's server behind its
 * checkout?" — and everything that asks goes through it. The page's side of
 * the same identity (is this PAGE older than its server) is `isStale` in
 * `src/host/standing.ts`.
 */
export class Staleness {
  #behind = new Map<string, string>()
  /** What the build identity said: the sentence, or null for "it runs its checkout". Absent: it did not say. */
  #judged = new Map<string, string | null>()

  /** An update changed what this module's server runs, and it was not restarted: why. */
  leftBehind(id: string, why: string): void {
    this.#behind.set(id, why)
  }

  /** It was started, or is not running at all: whatever runs next runs the checkout. */
  fresh(id: string): void {
    this.#behind.delete(id)
    this.#judged.delete(id)
  }

  /**
   * What the module's build identity says against its checkout: the sentence
   * when it is behind, null when it is not, undefined when nothing could be
   * compared — which leaves the fallback record standing.
   */
  judged(id: string, verdict: string | null | undefined): void {
    if (verdict === undefined) this.#judged.delete(id)
    else this.#judged.set(id, verdict)
  }

  /** Why this module is running old code, or null when nothing says it is. */
  staleness(id: string): string | null {
    if (this.#judged.has(id)) return this.#judged.get(id) ?? null
    return this.#behind.get(id) ?? null
  }

  /**
   * Every module that MAY be behind its checkout, with why the host could not
   * restart it: the fallback record, for modules whose build does not settle it.
   */
  all(): Record<string, string> {
    return Object.fromEntries([...this.#behind].filter(([id]) => !this.#judged.has(id)))
  }

  /** Every module whose build identity says it IS behind its checkout, with the sentence. */
  older(): Record<string, string> {
    const said: Record<string, string> = {}
    for (const [id, why] of this.#judged) if (why !== null) said[id] = why
    return said
  }

  forgetAllBut(ids: Iterable<string>): void {
    const keep = new Set(ids)
    for (const id of [...this.#behind.keys()]) if (!keep.has(id)) this.#behind.delete(id)
    for (const id of [...this.#judged.keys()]) if (!keep.has(id)) this.#judged.delete(id)
  }
}

/** What `behindCheckout` reads off a checkout. Injected so the rule is tested without a repository. */
export interface CheckoutReader {
  /** The commit the checkout is on, in full. */
  head(dir: string): Promise<string | null>
  /** The files that differ between two commits, or null when either is unknown there. */
  changed(dir: string, from: string, to: string): Promise<string[] | null>
  /** The files the module's server loads. See `serverGraph`. */
  graph(dir: string): ReadonlySet<string>
}

const FROM_GIT: CheckoutReader = { head: headOf, changed: changedBetween, graph: serverGraph }

/**
 * Whether a server that started on `build.commit` is behind the checkout in
 * `dir`: the sentence when it is, null when it runs what the checkout holds,
 * and undefined when that cannot be told — no build, no commit in it (not a
 * git checkout when it started), a checkout whose `HEAD` cannot be read, or a
 * commit the checkout does not have. Undefined is never shown as stale.
 *
 * Uncommitted edits are not looked at: the identity is a commit, and a dev
 * server over a working tree somebody is editing is theirs to restart.
 */
export async function behindCheckout(
  name: string,
  build: Build | null | undefined,
  dir: string | null | undefined,
  read: CheckoutReader = FROM_GIT,
): Promise<string | null | undefined> {
  if (!build?.commit || !dir) return undefined
  const head = await read.head(dir)
  if (!head) return undefined
  /* A build may state a short commit; a prefix of HEAD is HEAD. */
  if (head.startsWith(build.commit) || build.commit.startsWith(head)) return null
  const changed = await read.changed(dir, build.commit, head)
  if (changed === null) return undefined
  const decision = restartDecision(changed, read.graph(dir))
  if (!decision.restart) return null
  return (
    `${name} is running older code than its checkout: its server started on ${build.commit.slice(0, 7)}, `
    + `and the checkout is now at ${head.slice(0, 7)}, with changes its server loads (${decision.because.join(', ')}). `
    + 'Restart it to run them.'
  )
}
