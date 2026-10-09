import type { ModuleCondition } from 'kehikot-module-protocol'

/**
 * What a container shows, decided in one place.
 *
 * Two things know something about a module: the host's server, which asked its
 * address (`Presence`), and the conversation with its framed page (`Found`).
 * The container body and the frames layer both have to act on the same answer —
 * a page drawn while the cover is also up, or neither, is the white rectangle
 * this exists to prevent — so both call `showing` and neither decides alone.
 *
 * Three answers:
 *
 *  - `page`: the module's page is ready and is what the container shows.
 *  - `cover`: it is not ready YET, and that ends on its own. One calm panel for
 *    every such moment (`ModuleCover`), with a sentence saying which.
 *  - `notice`: it is not ready and nothing is on its way. `ConditionPanel`, with
 *    the sentence and, for a module that is not running, the button.
 */

/** Every not-ready moment that ends on its own. */
export type Waiting = 'starting' | 'installing' | 'updating' | 'restarting' | 'loading'

export type Showing =
  | { kind: 'page' }
  | { kind: 'cover'; state: Waiting }
  | { kind: 'notice'; condition: ModuleCondition; asleep: boolean; line: string }

/** What the host's server said about the module. */
export interface Said {
  condition: ModuleCondition
  lifecycle?: 'starting' | 'installing' | 'updating' | 'restarting' | 'asleep'
  line: string
}

/** What the conversation with the framed page found, or undefined while it has not answered. */
export interface Found {
  condition: ModuleCondition
  line: string | null
}

/**
 * `asked` is whether the server has been asked what is running SINCE it was
 * told which kehikko this page has open. It starts a module because a kehikko
 * that has it is open, so before that an answer of "not running" may only mean
 * "not asked for yet" — and drawing it was a notice with a Start button, for a
 * tenth of a second, on every load of a kehikko whose module was not running.
 * Until then such a module is covered as loading, and the next answer says
 * `starting`, or says the notice was right.
 */
export function showing(said: Said, found: Found | undefined, asked = true): Showing {
  /* The host is doing something to the program that ends on its own. This
     wins over a page that is still answering: it is about to be replaced. */
  if (said.lifecycle && said.lifecycle !== 'asleep') return { kind: 'cover', state: said.lifecycle }
  if (!asked && said.condition === 'silent') return { kind: 'cover', state: 'loading' }
  /* Nothing serves the module, so there is no page whatever a conversation
     last heard. Believing the conversation here left a container green over a
     page whose server had gone. */
  if (said.condition !== 'ready') {
    return { kind: 'notice', condition: said.condition, asleep: said.lifecycle === 'asleep', line: said.line }
  }
  if (!found) return { kind: 'cover', state: 'loading' }
  if (found.condition === 'ready') return { kind: 'page' }
  return { kind: 'notice', condition: found.condition, asleep: false, line: found.line ?? said.line }
}

/**
 * Which modules are now served by a process the host started since the page
 * last saw them ready.
 *
 * A restart can be over in half a second, with no answer in between that said
 * the module was not running — so the frame is never unmounted, and what is
 * still in it is the document the OLD server sent. Showing that again when the
 * cover comes off is the stale page for a moment and then an uncovered reload.
 * Each id `seen` returns gets a new document instead (`Framing.generation`),
 * which is covered as loading until it answers.
 *
 * `run` is when the host started the process that is there (`Presence.run`),
 * absent for one it did not start. Only a module that is ready with nothing in
 * hand is looked at, so the new document is asked of a server that answers.
 * A run that goes away — the host itself restarted and holds nothing — is not
 * a restart of the module, and reloads nothing.
 */
export class Runs {
  #settled = new Map<string, number | undefined>()

  seen(presences: readonly { id: string; condition: ModuleCondition; lifecycle?: Said['lifecycle']; run?: number }[]): string[] {
    const again: string[] = []
    for (const one of presences) {
      if (one.condition !== 'ready' || one.lifecycle) continue
      if (one.run !== undefined && this.#settled.has(one.id) && this.#settled.get(one.id) !== one.run) again.push(one.id)
      this.#settled.set(one.id, one.run)
    }
    return again
  }
}

/** The sentence under the mark, one per state, in plain words. */
export const COVER_WORDS: Record<Waiting, string> = {
  starting: 'Starting…',
  installing: 'Installing what it needs — the first time takes a minute',
  updating: 'Updating — restarting on the new code…',
  restarting: 'Restarting…',
  loading: 'Loading…',
}

/**
 * Whether a build identity says this page, or the server behind it, is older
 * than the module's checkout.
 *
 * THE SEAM, page side (the server's is `Staleness` in `server/stale.ts`).
 * Nothing can answer yet: a page does not say what it was built from. When the
 * protocol carries that, compare it with what the registry says the checkout
 * holds and return true here; `showing` then covers a stale page as
 * `restarting` while the host replaces it. Until then this is always false and
 * nothing calls it a fact.
 */
export function isStale(_module: { id: string; version?: string }): boolean {
  return false
}

/**
 * How long a page that reloads in place has to answer before the cover goes
 * back up.
 *
 * A Vite full reload of a running module is answered in well under this (the
 * `ready` follows the frame's `load` by a few milliseconds, because a module's
 * script has run by the time `load` fires), so it shows no cover at all. A
 * reload onto a server that is slow or still coming back passes it, and the
 * cover says "Loading…" instead of an empty frame.
 */
export const RELOAD_GRACE_MS = 250

/**
 * When the cover is armed, and when it is let go.
 *
 * `drop` forgets what the conversation had found for a module, which is what
 * puts the cover up (`showing` with nothing found). Told three things by the
 * frame and the conversation:
 *
 *  - `mounted`: a new document is being loaded from nothing — the first load,
 *    or the module came back after its server went away. Armed at once.
 *  - `loaded`: the frame's `load` fired; the host has greeted. Armed after the
 *    grace, unless `answered` comes first.
 *  - `answered`: the page said `ready`. Whatever was pending is let go.
 *  - `unmounted`: the frame went away. Forgotten at once, with nothing pending.
 *
 * The timer is injected so the arming is tested without waiting.
 */
export class Covers {
  #pending = new Map<string, unknown>()

  constructor(
    private readonly drop: (id: string) => void,
    private readonly grace: number = RELOAD_GRACE_MS,
    private readonly after: (ms: number, run: () => void) => unknown = (ms, run) => setTimeout(run, ms),
    private readonly cancel: (timer: unknown) => void = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  ) {}

  mounted(id: string): void {
    this.#let(id)
    this.drop(id)
  }

  loaded(id: string): void {
    this.#let(id)
    this.#pending.set(
      id,
      this.after(this.grace, () => {
        this.#pending.delete(id)
        this.drop(id)
      }),
    )
  }

  answered(id: string): void {
    this.#let(id)
  }

  /**
   * The frame is gone, and what its page had said goes with it. Otherwise the
   * module coming back is drawn for one render as the page it used to be —
   * over a document that has not loaded — before `mounted` covers it.
   */
  unmounted(id: string): void {
    this.#let(id)
    this.drop(id)
  }

  #let(id: string): void {
    if (!this.#pending.has(id)) return
    this.cancel(this.#pending.get(id))
    this.#pending.delete(id)
  }
}
