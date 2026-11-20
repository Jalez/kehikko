import type { FramedModule } from '../discover.ts'
import { ExitRestarts } from '../lifecycle.ts'
import { StoppedByPerson } from '../stopModule.ts'

/** What the container says about a module the host ran that stopped again without answering. */
export interface Failure {
  line: string
  detail: string[]
}

/**
 * What the module supervisor believes about each module, between one look and the next.
 *
 * Every map here is per module id and memory only: a host that starts again believes nothing. The
 * supervisor in `server.ts` reads and writes them; what it does with them — which module to start,
 * when, and what to say — is there and in `lifecycle.ts`. The operations below are the ones that
 * change several of them at once, so that the set of maps one event touches is written once.
 */
export class ModuleStates {
  /** When the host last ran a module's script, for as long as that is news. */
  readonly starting = new Map<string, number>()

  /** When the host stopped a module, until something starts it again. */
  readonly sleeping = new Map<string, number>()

  /**
   * The run of each module's script this host is waiting to hear the end of,
   * by when it was started. An exit is acted on only when it is still the run
   * named here — one the host stopped on purpose, or replaced, is taken out first.
   */
  readonly runs = new Map<string, number>()

  /** The exit code of each module's last run that has ended; null when a signal ended it. */
  readonly exits = new Map<string, number | null>()

  /**
   * Modules a person stopped from the Kehikko modules menu, until they press Start on one (or the app
   * starts again: nothing writes this down). Nothing here is started by the host's own rules. `stopModule.ts`.
   */
  readonly stoppedByPerson = new StoppedByPerson()

  /** A module the host ran that stopped again without answering, until something clears it. */
  readonly failures = new Map<string, Failure>()

  /** An update or a restart the host is running for a module right now. */
  readonly working = new Map<string, 'updating' | 'restarting'>()

  /** The modules an update or a restart has in hand. Nothing else starts those meanwhile, and their exits are not news. */
  readonly inHand = new Set<string>()

  /**
   * Modules somebody else was running that have just stopped answering, and
   * when. The host does not start one while it is here: `THEIRS_TO_RESTART_MS`
   * in `lifecycle.ts` has why. `theirReturn` takes it out again.
   */
  readonly theirs = new Map<string, number>()

  /**
   * Each module's manifest as last read, for the scope a container keeps it by
   * (`scopeKeeps`, "Why a container's scope may keep a module" in
   * `lifecycle.ts`). Kept while the module is not answering — a module its scope
   * keeps that went down is needed, and started again — and forgotten with its
   * registration. Memory only: a host that has not read a module keeps nothing
   * for it by scope.
   */
  readonly scopeRead = new Map<string, FramedModule>()

  /** How often a module whose process ended is started again on its own (`ExitRestarts`). */
  readonly exitRestarts: ExitRestarts

  /** Modules whose next start after an end waits until this time. */
  readonly exitHeld = new Map<string, number>()

  /** Whose process was answering for each module when it was last seen answering. */
  readonly answeredBy = new Map<string, 'ours' | 'theirs'>()

  constructor(exitRestarts: ExitRestarts = new ExitRestarts()) {
    this.exitRestarts = exitRestarts
  }

  /**
   * The host ran the module's script at `at`: its run is the one whose end is news, it is starting,
   * and whatever was believed about it before (asleep, failed) stops being believed.
   */
  ran(id: string, at: number): void {
    this.runs.set(id, at)
    this.starting.set(id, at)
    this.sleeping.delete(id)
    this.failures.delete(id)
  }

  /** It answers, however it came back: no longer starting, asleep or failed. */
  answering(id: string): void {
    this.starting.delete(id)
    this.sleeping.delete(id)
    this.failures.delete(id)
  }

  /** A person pressed Start or Restart, or an update restarts it: the count of ends begins again, and nothing waits. */
  pressed(id: string): void {
    this.exitRestarts.forget(id)
    this.exitHeld.delete(id)
  }

  /** Whether its next start after an end is still to wait, at `now` (`exitHeld`). */
  heldAfterEnd(id: string, now: number): boolean {
    return (this.exitHeld.get(id) ?? 0) > now
  }

  /**
   * Only the modules in `here` (the registry) are remembered: a module whose registration is gone is
   * not said to be asleep, failed, starting or stopped, and its scope is not kept.
   */
  forgetAllBut(here: ReadonlySet<string>): void {
    for (const id of [...this.scopeRead.keys()]) if (!here.has(id)) this.scopeRead.delete(id)
    for (const id of [...this.starting.keys()]) if (!here.has(id)) this.starting.delete(id)
    for (const id of [...this.sleeping.keys()]) if (!here.has(id)) this.sleeping.delete(id)
    for (const id of [...this.failures.keys()]) if (!here.has(id)) this.failures.delete(id)
    this.stoppedByPerson.forgetAllBut(here)
  }
}
