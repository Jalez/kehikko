import { randomUUID } from 'node:crypto'
import { canonicalModuleId, WELL_KNOWN } from 'kehikot-module-protocol'

import type { Runnable, Startable, Stopped } from './launch.ts'
import type { Registration } from './registrations.ts'
import { proveListener, stopProven, type Processes } from './takeover.ts'

/**
 * Restarting a module whose registration says to keep it, because a person
 * said so twice.
 *
 * ## Why this exists
 *
 * `keep: true` means the host never stops that module by itself: not when it
 * is idle, not when the app quits, not for an update. That left one case with
 * no way out. The module's code is updated, its server is still the old
 * process, and the row said "stop it where you started it" — about a module
 * the host itself had started. The only way on was to find the process and
 * kill it in a terminal.
 *
 * `keep` goes on meaning all of that. What is added is one deliberate act a
 * person can take from the row: "Restart anyway", pressed twice.
 *
 * ## Two presses, and the server holds the first
 *
 * The first press ARMS: the host works out exactly which process it would
 * stop, says so, and says what goes with it. Nothing is signalled. The second
 * press, within `ARMED_FOR_MS`, carries the token the first was given, and the
 * host stops that process and starts the module again. A second press with no
 * live first one behind it is refused, and so is one where the process found
 * is no longer the process that was named.
 *
 * ## Which process, and how the host knows
 *
 *  - **One this host started** is the nursery's `Child` — the handle, not a
 *    number (see `Nursery` in `launch.ts`). It is stopped the way every other
 *    module is: SIGTERM to its group, and SIGKILL after `TERM_GRACE_MS` if the
 *    child is still there.
 *  - **One it did not start** (a previous host's, or one run by hand) has to
 *    be shown to be the module, twice over. The program listening on the
 *    registered port must answer the module's well-known manifest with the
 *    registered id, with the same pid listening before and after it answered;
 *    and it must pass `proveListener` in `takeover.ts` — running from the
 *    registered directory, in a process group that holds nothing else. If any
 *    of that cannot be shown, the answer is a sentence and nothing is
 *    signalled.
 *
 * ## What the host says will be lost, and what it does not claim
 *
 * That whatever the module is running will end, and — because the module that
 * says `keep` is nearly always a terminal — that this means its shells. It
 * does not count them: the children of a module's process are its own tooling
 * (a shell script, a runtime, a bundler's workers) as much as anybody's work,
 * and nothing cheap tells one from the other. So no number is given, and it
 * never says nothing is running.
 *
 * ## Who can do this
 *
 * A person at the page. There is no tool for it on the host's MCP door
 * (`mcp.ts`), and this route answers only a request that a browser sent from
 * this host's own page: JSON, with an `Origin` that is one of the page's. A
 * module's frame and any other site are other origins. This host holds no
 * credential anywhere, so that is a check of where a request came from and not
 * of who made it — the same footing as every other press in the page.
 *
 * That check is not made in this file. Every request passes `refusal` in
 * `guard.ts` before a route is chosen, and this route is one of its
 * `PAGE_ONLY`: by the time `route` below is called, the request is the page's.
 */

/** How long a first press stands. Long enough to read the sentence it produced. */
export const ARMED_FOR_MS = 20_000

/** What a restart refused for `keep` says, before anything is pressed. */
export function keptSentence(id: string, url: string): string {
  return (
    `${id} is running at ${url}, and its registration says to keep it, so this host has not stopped it — `
    + 'that flag exists so nothing reaps a program holding live work.'
  )
}

/** What this file needs to know about, and do to, running programs. */
export interface AnywayWorld {
  /** The pid of the live process THIS host started for the module, or null. */
  ours(id: string): number | null
  /** Stop the process this host started for it: `Nursery.stop`. */
  stopOurs(id: string): Stopped
  os: Processes
  /** The id the program at that origin states in its well-known manifest, or null when none was read. */
  answersAs(url: string): Promise<string | null>
}

/** The one process a forced restart would stop. */
export type Target = { whose: 'ours'; pid: number } | { whose: 'inherited'; pid: number; pgid: number }

export type Aimed = { ok: true; target: Target } | { ok: false; why: string }

/** Every refusal here ends the same way, because the same thing is true of all of them. */
function unshown(id: string, detail: string): Aimed {
  return {
    ok: false,
    why: `${id} was not restarted: ${detail} This host only stops a program it can show is ${id}, and nothing was stopped.`,
  }
}

/**
 * Find the process a forced restart would stop, or say why it cannot be
 * named. Signals nothing.
 */
export async function aim(id: string, run: Runnable, world: AnywayWorld): Promise<Aimed> {
  const mine = world.ours(id)
  if (mine !== null) return { ok: true, target: { whose: 'ours', pid: mine } }

  if (run.port === null) return unshown(id, 'its registration names no port, so there is nothing to find it by.')
  let before: number | null
  try {
    before = await world.os.listenerOf(run.port)
  } catch {
    return unshown(id, `this host could not ask which program is listening on port ${run.port}.`)
  }
  if (before === null) return unshown(id, `nothing is listening on port ${run.port} any more.`)

  const said = await world.answersAs(run.url)
  if (said === null) {
    return unshown(id, `the program on port ${run.port} did not answer ${WELL_KNOWN} with a manifest.`)
  }
  if (canonicalModuleId(said) !== id) {
    return unshown(id, `the program on port ${run.port} answers as ${said}, not as ${id}.`)
  }

  const proof = await proveListener(run, world.os)
  if (proof.kind === 'nothing') return unshown(id, `nothing is listening on port ${run.port} any more.`)
  if (proof.kind === 'unproven') return unshown(id, proof.detail)
  /* The manifest was answered by whatever listened while it was asked. The
     same pid on both sides of the answer is what ties the two together. */
  if (proof.pid !== before) {
    return unshown(id, `the program listening on port ${run.port} changed while this host was asking what it is.`)
  }
  return { ok: true, target: { whose: 'inherited', pid: proof.pid, pgid: proof.pgid } }
}

/** What the first press is answered with: what will be stopped, and what goes with it. */
export function armedSentence(id: string, run: Runnable, target: Target): string {
  const which =
    target.whose === 'ours'
      ? `This host started it (process ${target.pid}) and will stop that and start it again.`
      : `This host did not start it: the program on port ${run.port} (process ${target.pid}) answers as ${id} from ${run.dir}, and that is what will be stopped and started again.`
  return (
    `Restarting ${id} ends whatever it is running. It is holding work this host cannot see — `
    + `in a terminal, the open shells and everything running in them. ${which} Press again to do it.`
  )
}

export type StoppedAnyway = { ok: true; target: Target; killed: boolean } | { ok: false; why: string }

/**
 * Stop the process the first press named — and only if it is still that one.
 *
 * `armed` is the pid the first press was told. The process is found again
 * from nothing, so what is signalled is proven at the moment it is signalled,
 * and a module that was restarted by something else between the two presses
 * is left alone.
 *
 * For a process this host started, the stop is the nursery's: it returns once
 * SIGTERM is sent and sends SIGKILL itself after the grace. The caller waits
 * for the port.
 */
export async function stopAnyway(id: string, run: Runnable, armed: number, world: AnywayWorld): Promise<StoppedAnyway> {
  const aimed = await aim(id, run, world)
  if (!aimed.ok) return aimed
  const target = aimed.target
  if (target.pid !== armed) {
    return {
      ok: false,
      why:
        `${id} was not restarted: the first press named process ${armed}, and what is running as ${id} now is process ${target.pid}. `
        + 'Something else restarted it in between, and nothing was stopped.',
    }
  }
  if (target.whose === 'ours') {
    /* `already-gone` is the child having ended between the look and the stop:
       nothing is left to stop, and the start that follows is what was asked for. */
    world.stopOurs(id)
    return { ok: true, target, killed: false }
  }
  if (run.port === null) return unshown(id, 'its registration names no port, so there is nothing to find it by.') as StoppedAnyway
  const stopped = await stopProven(run.port, target.pgid, world.os)
  if (stopped.kind === 'unproven') return unshown(id, stopped.detail) as StoppedAnyway
  return { ok: true, target, killed: stopped.killed }
}

/**
 * The first presses this host is holding, one per module.
 *
 * A token is good once, for one module, until `ARMED_FOR_MS` has passed, and a
 * new first press replaces the old one. In memory only: a host that restarts
 * has forgotten every arm, which is the safe way to forget.
 */
export class Arms {
  #armed = new Map<string, { token: string; pid: number; until: number }>()
  readonly #now: () => number
  readonly #token: () => string

  constructor(now: () => number = Date.now, token: () => string = randomUUID) {
    this.#now = now
    this.#token = token
  }

  arm(id: string, pid: number): string {
    const token = this.#token()
    this.#armed.set(id, { token, pid, until: this.#now() + ARMED_FOR_MS })
    return token
  }

  /** The pid the first press named, if `token` is that press and it still stands. Spent either way. */
  take(id: string, token: string): number | null {
    const held = this.#armed.get(id)
    this.#armed.delete(id)
    if (!held || held.token !== token || this.#now() > held.until) return null
    return held.pid
  }
}

/** What came of the restart, as `restart` in `server.ts` answers it. */
export type Came =
  | { ok: true; answered: boolean; detail: string[]; presence: unknown }
  | { ok: false; why: string; detail?: string[] }

export interface AnywayDeps {
  /** The registration as it is on disk at the press. */
  registration(id: string): Promise<Registration | null>
  startable(registration: Registration | null): Startable
  /** An update or a restart of it is already in hand. */
  busy(id: string): boolean
  /** Whether anything answers at its address now. */
  reached(registration: Registration): Promise<boolean>
  world: AnywayWorld
  arms: Arms
  /** Stop the process the first press named and start the module again. Called only by a second press. */
  restart(id: string, registration: Registration, run: Runnable, armed: number): Promise<Came>
  /** Before the wait for it to come back, which outlasts an idle connection. */
  patient?(request: Request): void
}

/** `POST /host/restart-anyway`: `{ module, press: 'arm' }`, then `{ module, press: 'confirm', token }`. */
export function anywayDesk(deps: AnywayDeps) {
  async function route(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname !== '/host/restart-anyway' || request.method !== 'POST') return null
    const body = (await request.json().catch(() => null)) as { module?: unknown; press?: unknown; token?: unknown } | null
    const press = body?.press
    if (
      !body
      || typeof body.module !== 'string'
      || body.module.length === 0
      || body.module.length > 64
      || (press !== 'arm' && press !== 'confirm')
      || (press === 'confirm' && (typeof body.token !== 'string' || body.token.length > 64))
    ) {
      return reply({ ok: false, why: 'A restart names one module and one of arm or confirm, and a confirm carries what the arm was given.' }, 400)
    }
    const id = canonicalModuleId(body.module)

    const registration = await deps.registration(id)
    const can = deps.startable(registration)
    if (!registration || !can.ok) return reply({ ok: false, why: can.ok ? 'There is no registration for that module.' : can.why }, 409)
    if (registration.keep !== true) {
      return reply(
        { ok: false, why: `${id}’s registration does not say to keep it, so there is nothing to override here. Restarting it the ordinary way stops it and starts it again.` },
        409,
      )
    }
    if (deps.busy(id)) return reply({ ok: false, kept: true, why: `${id} is already being restarted or updated. Nothing more was done.` }, 409)

    if (press === 'arm') {
      if (!(await deps.reached(registration))) {
        return reply({ ok: false, kept: false, why: `${id} is not running now, so there is nothing to stop. Try again starts it.` }, 409)
      }
      const aimed = await aim(id, can.run, deps.world)
      if (!aimed.ok) return reply({ ok: false, kept: true, why: aimed.why }, 409)
      const token = deps.arms.arm(id, aimed.target.pid)
      return reply({ ok: true, armed: { token, sentence: armedSentence(id, can.run, aimed.target), forMs: ARMED_FOR_MS } })
    }

    const armed = deps.arms.take(id, body.token as string)
    if (armed === null) {
      return reply(
        {
          ok: false,
          kept: true,
          why: `${id} was not restarted: this press has no first press behind it — one stands for ${ARMED_FOR_MS / 1000} seconds, once. Nothing was stopped. Press Restart anyway to begin again.`,
        },
        409,
      )
    }
    deps.patient?.(request)
    const done = await deps.restart(id, registration, can.run, armed)
    if (!done.ok) return reply({ ok: false, kept: true, why: done.why, detail: done.detail ?? [] }, 409)
    return reply({ ok: true, command: can.run.command, ...(done.answered ? {} : { detail: done.detail }), presence: done.presence })
  }

  return { route }
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
