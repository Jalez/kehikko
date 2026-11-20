import { WELL_KNOWN } from 'kehikot-module-protocol'
import { releaseVersion } from '../../src/host/moduleReleases.ts'
import { answersAs as answersAsStarted, takesAnyPort } from '../anyPort.ts'
import { keptSentence, stopAnyway, type AnywayWorld } from '../anyway.ts'
import type { developmentDesk } from '../development.ts'
import { look, type Presence } from '../discover.ts'
import { answered, gone, type Nursery, type Runnable, type Startable } from '../launch.ts'
import { exitedLine, INSTALLING_FOR_MS } from '../lifecycle.ts'
import type { ManifestCache } from '../manifests.ts'
import type { bundleDesk, Swapped } from '../moduleBundles.ts'
import type { ModuleBuilds } from '../moduleBuilds.ts'
import { installing, logFile, tail } from '../moduleLog.ts'
import { answersAs, judge, movedLine, newPort, repoint as repointRegistration } from '../portTaken.ts'
import { readRegistrations, registryDir, type Registration } from '../registrations.ts'
import type { ReleaseWaits } from '../releaseWait.ts'
import type { RestartEnv } from '../restartHold.ts'
import { STARTED_OUTSIDE } from '../restartModule.ts'
import { InFlight, joinsStart } from '../startOnce.ts'
import { proveListener, systemProcesses, takeOver } from '../takeover.ts'
import type { Place } from '../updates.ts'
import type { Processes } from './processes.ts'
import type { ModuleStates } from './state.ts'

/** How long an update waits for the module it restarted: it may be installing, and pre-bundling after. */
export const ANSWERS_WITHIN_UPDATE_MS = 120_000

/** From this long a wait on, a module that is still installing is waited for. See `bringUpOnce`. */
const PATIENT_FROM_MS = 60_000

/** `kept`: refused because the registration says `keep`, which only a person's two presses get past. */
export type Halted =
  | { ok: true; was: 'running' | 'not-running'; moved?: Moved }
  | { ok: false; why: string; kept?: boolean }

/** A module started on another port because another program held its own: where it goes, and what to say. */
export type Moved = { runnable: Runnable; line: string }

export type Came =
  | { ok: true; answered: boolean; detail: string[]; presence: Presence | null; waited: number; installing: boolean }
  | { ok: false; why: string; detail?: string[] }

export type Restarted =
  | { ok: true; answered: boolean; detail: string[]; presence: Presence | null; moved?: Moved }
  | { ok: false; why: string; detail?: string[]; refused?: boolean; kept?: boolean }

/** What an update's outcome is when the module did not come back (`ModuleOutcome` in `server.ts`). */
export type Failed = { ran: 'failed'; why: string; detail: string[] }

/** What the restarts read of a sweep: the presences. */
export interface Viewed {
  readonly presences: readonly Presence[]
}

/**
 * Everything the restarts read or ask of the rest of the host. Read on each use, never copied at
 * construction: the host hands over some of these before it has made them (a getter).
 */
export interface RestartDeps<V extends Viewed = Viewed> {
  states: ModuleStates
  /** The only place a module's script is run and stopped on purpose. */
  processes: Pick<Processes, 'run' | 'halt'>
  nursery: Nursery
  /** The registry as last read, by id. */
  registered: ReadonlyMap<string, Registration>
  manifests: Pick<ManifestCache, 'forget'>
  /** Kehikko development: a module set to keep running moves at its next start (`bringUpSettled`). */
  development: Pick<ReturnType<typeof developmentDesk>, 'owes' | 'beforeStart'>
  /** A release a check found while the module ran goes in while it is down (`restart`). */
  releases: Pick<ReleaseWaits, 'waiting' | 'apply'>
  /** A build put off while the module ran (`restart`). */
  builds: Pick<ModuleBuilds, 'owes' | 'stopped'>
  /** The versions swapped in: settled or rolled back (`moduleBundles.ts`). */
  bundles: Pick<ReturnType<typeof bundleDesk>, 'settle' | 'rollback'>
  /** Why the module's next process started, for the module (`restartHold.ts`). */
  restartEnv: Pick<RestartEnv, 'note'>
  wakes: { registryChanged(): void }
  /** What `anyway.ts` may know about, and do to, running programs. */
  anyway: AnywayWorld
  /** Whether module addresses are on (`addressesOn`): a module that takes any port is only handed one then. */
  addresses(): boolean
  startable(registration: Registration | null): Startable
  /** An installed module's place; null for anything else. */
  installedPlace(id: string): Place | null
  /** A module's name as a person reads it in a sentence. */
  spokenName(id: string): string
  /** A module's name as it calls itself, else as the official list does; null when neither knows it. */
  knownName(id: string): string | null
  /** The first port the official list gives a module, if it lists it. */
  firstPort(id: string): number | null
  /** Said in every project's Inbox, by the host: a new version did not start, and the one before runs again. */
  tellRolledBack(sentence: string): void
  /** A sweep that began at or after `at` (`sweepAfter.ts`). */
  sweepSince(at: number): Promise<V>
  /** A sweep as the page receives it, with the host's own lifecycle words on it (`Supervisor.told`). */
  told(view: V): V
}

/**
 * A person's press of Start or Restart, an update's restart, and the start a module set to keep
 * running moves at: stopping a module so it can be started again, if this host may, starting it,
 * and waiting for it to answer.
 *
 * The ordinary rule's start is the supervisor's (`Supervisor.begin`); a press goes through
 * `startOnce`, once per module at a time, and a press while the host's own start is coming up waits
 * for that one. A version swapped in while its module was not running is settled at its first start
 * that answers and rolled back at one that does not (`unsettled`).
 */
export class Restarts<V extends Viewed = Viewed> {
  readonly #deps: RestartDeps<V>

  /** The presses on Start in flight, one per module (`startOnce.ts`). */
  readonly pressedStarts = new InFlight<Restarted>()

  /** Modules whose move is being made now, so the start inside it does not move them again (`bringUpSettled`). */
  readonly settling = new Set<string>()

  /**
   * Versions swapped in while their module was not running (`level`, or an
   * update of a module nothing had open): settled at their first start that
   * answers, rolled back at one that does not. By id.
   */
  readonly unsettled = new Map<string, Swapped & { from: string | null }>()

  constructor(deps: RestartDeps<V>) {
    this.#deps = deps
  }

  /**
   * Wait, up to `within`, for a module started on any port to answer where its registration says
   * now, as the process started with `token`. The registration is read from disk on each ask: the
   * module rewrites it once it has bound.
   */
  async #answeredAnywhere(id: string, token: string, within: number): Promise<boolean> {
    const until = Date.now() + within
    for (;;) {
      const registration = (await readRegistrations()).registrations.find((one) => one.id === id)
      if (registration && (await answersAsStarted(registration.url, id, token))) return true
      if (Date.now() >= until) return false
      await new Promise((wake) => setTimeout(wake, Math.min(300, Math.max(0, until - Date.now()))))
    }
  }

  /**
   * `bringUp`, after the move a module set to keep running was owed (`development.beforeStart`): the
   * module is not running — a restart stopped it, or it had ended — and is about to be started, so this
   * is its next restart. Its release (or folder) is put in place, its registration pointed there, and it
   * is started from there; when it does not answer, the registration goes back and the old one starts.
   */
  async bringUpSettled(id: string, runnable: Runnable, within: number, onInstalling?: () => void, onStarted?: () => void): Promise<Came> {
    const { development, nursery } = this.#deps
    const settling = this.settling
    /* The registration as it is on disk now: `registered` is the last sweep's, and a start asked a moment after
       a registration was edited (`keep` added by hand, or by a press) would otherwise judge the one before it
       and owe no move. A press reads the disk for the same reason (`/host/start`). */
    const was = (await readRegistrations()).registrations.find((r) => r.id === id) ?? this.#deps.registered.get(id) ?? null
    if (settling.has(id) || !development.owes(id, was)) return this.#bringUp(id, runnable, within, onInstalling, onStarted)
    settling.add(id)
    try {
      const moved = await development.beforeStart(id)
      if (!moved) return this.#bringUp(id, runnable, within, onInstalling, onStarted)
      const now = (await readRegistrations()).registrations.find((r) => r.id === id) ?? null
      const can = this.#deps.startable(now)
      const came = can.ok ? await this.#bringUp(id, can.run, within, onInstalling, onStarted) : ({ ok: false, why: can.why } as const)
      if (came.ok && came.answered) {
        await moved.finish(true)
        return came
      }
      /* It did not answer from there: what was started stops, and the registration and the old one are back. */
      if (nursery.holds(id)) this.#deps.processes.halt(id)
      if (can.ok) await gone(can.run.url, WELL_KNOWN)
      await moved.finish(false, came.ok ? `it did not answer. What it printed is in ${logFile(id)}.` : came.why)
      return this.#bringUp(id, runnable, within, onInstalling, onStarted)
    } finally {
      settling.delete(id)
    }
  }

  /**
   * Run a module somewhere else when the program on its port is not it — see
   * `portTaken.ts`. Nothing is stopped: a free port is claimed the way the
   * module would claim one itself, written into its registration, and the
   * start that follows uses it.
   */
  async #moveOff(id: string, registration: Registration, runnable: Runnable): Promise<{ ok: true; moved: Moved } | { ok: false; why: string }> {
    if (runnable.port === null || !registration.file) return { ok: false, why: `${id} has no port set, so it can't be moved.` }
    const first = this.#deps.firstPort(id)
    const to = await newPort({ id, taken: runnable.port, first, registry: registryDir() })
    if (!to.ok) return to
    const written = repointRegistration(registration.file, to.url)
    if (!written.ok) return written
    const line = movedLine(this.#deps.knownName(id) ?? id, runnable.port, to.port)
    console.log(`kehikko: ${line} (${id}: ${runnable.url} -> ${to.url}; the program on ${runnable.port} was left running)`)
    return {
      ok: true,
      moved: { runnable: { ...runnable, port: to.port, url: to.url, command: `PORT=${to.port} ${runnable.script}` }, line },
    }
  }

  /**
   * Stop a module so that it can be started again, if this host may.
   *
   * Stopping is only ever something this host may do to a program it started,
   * and `keep` is how somebody says not even then — see the essay in
   * `lifecycle.ts`. The one widening: a module the nursery does not hold may
   * still be stopped when the program on its port is proven to be running from
   * the registered directory — the modules a previous host started and this one
   * inherited. The proof and its limits are in `takeover.ts`.
   *
   * `anyway` is a person having pressed "Restart anyway" twice on a module that
   * is kept, with the pid the first press named. Nothing else passes it — see
   * `anyway.ts`, which is also where that process is proven and stopped.
   */
  async haltForRestart(
    id: string,
    registration: Registration | null,
    runnable: Runnable,
    anyway?: { pid: number },
    heldOnly = false,
  ): Promise<Halted> {
    const { nursery } = this.#deps
    const halt = (one: string) => this.#deps.processes.halt(one)
    const standing = registration ? await look(registration) : null
    if (!standing?.reached) {
      /* Nothing answers, but a process this host started may still be there —
         compiling, or hung. It goes first, or two copies race for the port. */
      if (nursery.holds(id)) halt(id)
      return { ok: true, was: 'not-running' }
    }
    /* "Restart module" (`heldOnly`): something answers, and it is not the child this host holds.
       Nothing is proven, taken over or moved off — that program is left exactly as it is. */
    if (heldOnly && !nursery.holds(id)) return { ok: false, why: STARTED_OUTSIDE }
    /* Something answers there. When it is not the module — no manifest, or
       another module's, from somewhere other than the module's directory —
       the module is run on another port instead, and the program there is left
       alone. Before `keep`, because nothing of the module's is stopped; except
       a kept module whose own process this host still holds, which is not
       stopped to do it. See `portTaken.ts`. */
    if (registration && !(registration.keep === true && nursery.holds(id))) {
      const occupied = judge(id, await proveListener(runnable, systemProcesses), await answersAs(runnable.url))
      if (occupied.kind === 'foreign') {
        const moved = await this.#moveOff(id, registration, runnable)
        if (!moved.ok) return { ok: false, why: moved.why }
        /* A copy this host started that never got the port goes too, or it and the new one are two. */
        if (nursery.holds(id)) halt(id)
        return { ok: true, was: 'not-running', moved: moved.moved }
      }
    }
    if (registration?.keep === true) {
      if (!anyway) return { ok: false, kept: true, why: keptSentence(id, runnable.url) }
      const stopped = await stopAnyway(id, runnable, anyway.pid, this.#deps.anyway)
      if (!stopped.ok) return { ok: false, kept: true, why: stopped.why }
      console.log(
        `kehikko: stopped ${id} (process ${stopped.target.pid}${stopped.killed ? ', killed' : ''}) to restart it — `
        + `its registration says to keep it, and a person pressed Restart anyway twice`
        + (stopped.target.whose === 'ours' ? '' : `; this host had not started it, and it answered as ${id} from ${runnable.dir}`),
      )
      await gone(runnable.url, WELL_KNOWN)
      return { ok: true, was: 'running' }
    }
    const stopped = halt(id)
    /* Its child ended between the look and the stop, and something else answers there now. */
    if (heldOnly && stopped !== 'stopped') return { ok: false, why: STARTED_OUTSIDE }
    if (stopped === 'not-ours') {
      const taken = await takeOver(id, runnable, systemProcesses)
      if (taken.kind === 'refused') return { ok: false, why: taken.why }
      if (taken.kind === 'stopped') {
        console.log(
          `kehikko: stopped ${id} (process group ${taken.pgid}${taken.killed ? ', killed' : ''}) `
          + `to restart it — it was running from ${runnable.dir}`,
        )
      }
    }
    /* Its own port has to come free before the replacement asks for it, or the
       new process finds the old one still listening, decides a copy of itself is
       already running, and exits. */
    await gone(runnable.url, WELL_KNOWN)
    return { ok: true, was: 'running' }
  }

  /** The swapped-in version answers: keep one previous, and remove a git checkout it replaced (`moduleBundles.ts`). */
  settleSwap(id: string): void {
    this.unsettled.delete(id)
    this.#deps.bundles.settle(id)
  }

  /**
   * The version an update swapped in did not answer: stop what was started, put
   * the previous version back at the same folder, start it, and say so. Nothing
   * of the person's is lost: only the program folder moves.
   */
  async rollBack(id: string, registration: Registration | null, runnable: Runnable, swapped: Swapped & { from: string | null }, failed: Failed): Promise<Failed> {
    this.unsettled.delete(id)
    await this.haltForRestart(id, registration, runnable)
    if (!this.#deps.bundles.rollback(id)) return failed
    const name = this.#deps.spokenName(id)
    const back = swapped.from ? releaseVersion(swapped.from) : 'the version before'
    const to = swapped.to ? releaseVersion(swapped.to) : 'the new version'
    console.log(`kehikko: ${id} ${to} did not answer after the update; rolled back to ${back}`)
    const came = await this.bringUpOnce(id, runnable, ANSWERS_WITHIN_UPDATE_MS)
    const why = `${name} ${to} did not answer after the update, so it was put back on ${back}${came.ok && came.answered ? ', which runs again' : ''}. What it printed is in ${logFile(id)}.`
    this.#deps.tellRolledBack(why)
    return { ran: 'failed', why, detail: failed.detail }
  }

  async #bringUp(id: string, runnable: Runnable, within: number, onInstalling?: () => void, onStarted?: () => void): Promise<Came> {
    const came = await this.bringUpOnce(id, runnable, within, onInstalling, onStarted)
    const swapped = this.unsettled.get(id)
    if (!swapped) return came
    if (came.ok && came.answered) {
      this.settleSwap(id)
      return came
    }
    /* Its first start after a swap did not answer: the version before goes back, and is started instead. */
    this.unsettled.delete(id)
    this.#deps.processes.halt(id)
    await gone(runnable.url, WELL_KNOWN)
    if (!this.#deps.bundles.rollback(id)) return came
    const back = swapped.from ? releaseVersion(swapped.from) : 'the version before'
    const to = swapped.to ? releaseVersion(swapped.to) : 'the new version'
    console.log(`kehikko: ${id} ${to} did not answer at its first start; rolled back to ${back}`)
    this.#deps.tellRolledBack(`${this.#deps.spokenName(id)} ${to} did not start, so it was put back on ${back}. What it printed is in ${logFile(id)}.`)
    return this.bringUpOnce(id, runnable, within, onInstalling, onStarted)
  }

  /**
   * Run a module's script and wait for it to answer, for at most `within`.
   *
   * Started is not running, so the module is given time to come up and is then
   * asked. The wait ends early when the process ends: a script that has exited
   * will not answer, and the reason is in what it printed.
   */
  async bringUpOnce(id: string, runnable: Runnable, within: number, onInstalling?: () => void, onStarted?: () => void): Promise<Came> {
    const { exits, starting, runs, failures } = this.#deps.states
    const spokenName = (one: string) => this.#deps.spokenName(one)
    exits.delete(id)
    const ran = this.#deps.processes.run(id, runnable)
    if (!ran.ok) return { ok: false, why: ran.why ?? 'it could not be started' }
    onStarted?.()
    const alive = () => !ran.child || ran.child.alive()
    const paths = [WELL_KNOWN]
    const began = Date.now()
    const until = began + within
    const log = logFile(id)
    let up = false
    let said = false
    /*
     * Asked a second and a half at a time, so an exit ends the wait soon after
     * it happens.
     *
     * A wait of `PATIENT_FROM_MS` or more is one somebody is watching a row for,
     * and it does not end while the module is still installing: a first
     * `bun install` on a slow connection outlasts two minutes, and "failed" over
     * a process that is doing exactly what it should sent people looking for a
     * fault. It ends when the module answers, when its process ends — a real
     * failure, said with what it printed — or at `INSTALLING_FOR_MS`, past which
     * a process still silent is hung (the same bound the container's own
     * "installing" has).
     */
    const patient = within >= PATIENT_FROM_MS
    for (;;) {
      if (up || !alive()) break
      const now = Date.now()
      const busy = patient && now - began < INSTALLING_FOR_MS && installing(log)
      if (busy && !said) {
        said = true
        onInstalling?.()
      }
      if (now >= until && !busy) break
      const budget = busy ? 1500 : Math.max(1, Math.min(1500, until - now))
      up = ran.anyPort && ran.token ? await this.#answeredAnywhere(id, ran.token, budget) : await answered(runnable.url, paths, budget)
    }
    let answeredAt = Date.now()
    /* The process ended and something else may answer there: the module was
       already running, and the copy just started stepped aside. */
    if (!up && !alive()) {
      up = ran.anyPort && ran.token ? await this.#answeredAnywhere(id, ran.token, 600) : await answered(runnable.url, paths, 600)
      answeredAt = Date.now()
    }
    if (!up && !alive()) {
      const detail = tail(log)
      starting.delete(id)
      runs.delete(id)
      failures.set(id, { line: exitedLine(spokenName(id), runnable.url, exits.get(id) ?? null, log), detail })
      return { ok: false, why: `${spokenName(id)} was started and stopped again without answering. All of what it printed is in ${log}.`, detail }
    }
    /* Read after it answered, not from a sweep that began before (`sweepAfter.ts`), and not from
       the refusal a read just before it answered kept for `UNANSWERED_MS` (`manifests.ts`): either
       one says "silent, starting" about a module that is up, and nothing tells the page otherwise
       until the watch looks. */
    if (up) this.#deps.manifests.forget(id)
    const view = this.#deps.told(await this.#deps.sweepSince(answeredAt))
    return {
      ok: true,
      answered: up,
      detail: up ? [] : tail(log),
      presence: view.presences.find((p) => p.id === id) ?? null,
      waited: Date.now() - began,
      installing: !up && installing(log),
    }
  }

  /**
   * Stop a module if it is running, start it, and say what came of it.
   *
   * One path for the Start button on a container, the retry in the Updates
   * panel, and the restart an update does by itself — so what "restart" means,
   * and every reason it is refused, is written once.
   */
  async restart(
    id: string,
    registration: Registration | null,
    runnable: Runnable,
    within: number,
    anyway?: { pid: number },
    heldOnly = false,
  ): Promise<Restarted> {
    const { states, releases, builds, wakes } = this.#deps
    const { inHand, working } = states
    /* A press, an update or a retry: the count of ends begins again, and nothing waits. */
    states.pressed(id)
    const mine = !inHand.has(id)
    inHand.add(id)
    try {
      const halted = await this.haltForRestart(id, registration, runnable, anyway, heldOnly)
      if (!halted.ok) return { ...halted, refused: true }
      /* Said only of a module that was running: one that was not is starting. */
      if (halted.was === 'running') {
        working.set(id, 'restarting')
        this.#deps.restartEnv.note(id, 'module-restart')
      }
      wakes.registryChanged()
      /* A release a check found while it ran goes in now, while it is down
         (and is built as it goes in); else a build put off while it ran. */
      const waiting = releases.waiting(id) === null ? null : this.#deps.installedPlace(id)
      if (waiting) await releases.apply(waiting)
      else if (builds.owes(id)) {
        const place = this.#deps.installedPlace(id)
        if (place) await builds.stopped({ id, name: place.name, dir: place.dir })
      }
      const target = halted.moved?.runnable ?? runnable
      const came = await this.bringUpSettled(id, target, within)
      if (!halted.moved) return came
      return came.ok ? { ...came, moved: halted.moved } : { ...came, why: `${halted.moved.line} ${came.why}` }
    } finally {
      working.delete(id)
      if (mine) inHand.delete(id)
      wakes.registryChanged()
    }
  }

  /**
   * Start on a person's press, once per module at a time: a press while one is in
   * flight has its answer, and a press while the host's own start is still coming
   * up waits for that one instead of stopping it. See `startOnce.ts`.
   */
  startOnce(id: string, registration: Registration | null, runnable: Runnable, within: number): Promise<Restarted> {
    const { nursery, states } = this.#deps
    return this.pressedStarts.run(id, async () => {
      if (joinsStart({ held: nursery.holds(id), starting: states.starting.has(id), inHand: states.inHand.has(id) })) {
        console.log(`kehikko: ${id} is already starting — the press waits for that start instead of starting it again`)
        const joined = await this.#joinStart(id, runnable, within)
        if (joined) return joined
      }
      return this.restart(id, registration, runnable, within)
    })
  }

  /** Wait for a start already coming up, as `bringUpOnce` waits; null when its process ended first. */
  async #joinStart(id: string, runnable: Runnable, within: number): Promise<Restarted | null> {
    const { nursery } = this.#deps
    const token = nursery.tokenOf(id)
    const anyPort = this.#deps.addresses() && runnable.port !== null && takesAnyPort(runnable.dir)
    const until = Date.now() + within
    let up = false
    while (!up && nursery.holds(id) && Date.now() < until) {
      const budget = Math.max(1, Math.min(1500, until - Date.now()))
      up = anyPort && token ? await this.#answeredAnywhere(id, token, budget) : await answered(runnable.url, [WELL_KNOWN], budget)
    }
    if (!up && !nursery.holds(id)) return null
    if (up) this.#deps.manifests.forget(id)
    const view = this.#deps.told(await this.#deps.sweepSince(Date.now()))
    return { ok: true, answered: up, detail: up ? [] : tail(logFile(id)), presence: view.presences.find((p) => p.id === id) ?? null }
  }
}
