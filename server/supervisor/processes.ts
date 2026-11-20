import { takesAnyPort as takesAnyPortIn } from '../anyPort.ts'
import { leaving, start as startProcess, type Held, type Nursery, type Runnable, type Started, type Stopped } from '../launch.ts'
import { logFile as logFileOf, openRun as openRunAt } from '../moduleLog.ts'
import { portToHand } from '../modulePorts.ts'
import type { ModuleStates } from './state.ts'

/**
 * The module processes this host runs: starting one, stopping one on purpose, hearing one end, and
 * taking them all with it when the app stops the host.
 *
 * The only place a module's script is run and the only writer of the nursery's children. What the
 * host DECIDES when a process ends — failed, started again, after what wait — is the supervisor's
 * (`onEnded`); this hands it only the ends that are news: the run the host is still waiting on, not
 * one it stopped on purpose or replaced.
 */
export interface ProcessDeps {
  states: ModuleStates
  nursery: Nursery
  /** Whether module addresses are on (`addressesOn`): a module that takes any port is only handed one then. */
  addresses(): boolean
  /** The ports every registration names, which a port handed to a module never is. */
  namedPorts(): ReadonlySet<number>
  startup: { mark(step: string): void }
  /** What a module served was that process's: forgotten when it starts, stops or ends. */
  manifests: { forget(id: string): void }
  /** A process started now runs the checkout as it is now (`stale.ts`). */
  staleness: { fresh(id: string): void }
  /** A run the host was waiting on has ended: the supervisor decides what that means. */
  onEnded(id: string, at: number, code: number | null): void
  /** The host's log. */
  log?: (line: string) => void
  /* Seams, for tests: the spawn, the clock, the module's log file and whether a module takes any port. */
  start?: typeof startProcess
  now?: () => number
  logFile?: (id: string) => string
  openRun?: (file: string) => void
  takesAnyPort?: (dir: string | undefined) => boolean
  /** How the processes are stopped on the way out: `leaving` (SIGTERM, then SIGKILL after a wait). */
  leaving?: (held: readonly Held[]) => Promise<void>
}

export class Processes {
  readonly #deps: ProcessDeps
  readonly #start: typeof startProcess
  readonly #now: () => number
  readonly #log: (line: string) => void
  readonly #logFile: (id: string) => string
  readonly #openRun: (file: string) => void
  readonly #takesAnyPort: (dir: string | undefined) => boolean

  constructor(deps: ProcessDeps) {
    this.#deps = deps
    this.#start = deps.start ?? startProcess
    this.#now = deps.now ?? Date.now
    this.#log = deps.log ?? ((line) => console.log(line))
    this.#logFile = deps.logFile ?? ((id) => logFileOf(id))
    this.#openRun = deps.openRun ?? ((file) => openRunAt(file))
    this.#takesAnyPort = deps.takesAnyPort ?? ((dir) => takesAnyPortIn(dir))
  }

  /**
   * Run one module's script. The only place this host does.
   *
   * Its output goes to the module's log, the child goes into the nursery, and
   * the host is told when it ends — see `ended`. Whatever was believed about the
   * module before (asleep, failed, behind its checkout) stops being believed: a
   * process started now runs the checkout as it is now.
   */
  run(id: string, runnable: Runnable): Started {
    const { states, nursery, manifests, staleness, startup } = this.#deps
    const log = this.#logFile(id)
    let logged = true
    try {
      this.#openRun(log)
    } catch {
      /* A log that cannot be written is not a reason to refuse to start. */
      logged = false
    }
    const at = this.#now()
    /* Run now — by a press, an update, or the ordinary rule — so no longer waited for. */
    states.theirs.delete(id)
    /* Any free port (protocol 2.65.0) for a module that reads `PORT=0` so, while nothing names its
       port: it registers where it went (`anyPort.ts`). Any other keeps its port and the drift rules.
       The port handed is one of the protocol's band, never 0, which the system fills from the range
       other programs' servers are given theirs from (`modulePorts.ts`). */
    const anyPort = this.#deps.addresses() && runnable.port !== null && this.#takesAnyPort(runnable.dir)
    if (anyPort) {
      const port = portToHand(this.#deps.namedPorts()) ?? 0
      runnable = { ...runnable, port, command: `PORT=${port} ${runnable.script}` }
    }
    const ran = this.#start(logged ? { ...runnable, log } : runnable, (code) => {
      states.exits.set(id, code)
      this.#ended(id, at, code)
    })
    if (!ran.ok || !ran.child) return ran
    /* Whoever started it — the open kehikko, an update, a press: the timeline's start of it. */
    startup.mark(`started ${id}`)
    nursery.keep(id, { child: ran.child, at, url: runnable.url, ...(ran.token ? { token: ran.token } : {}) })
    if (anyPort) ran.anyPort = true
    manifests.forget(id)
    states.ran(id, at)
    staleness.fresh(id)
    return ran
  }

  /** Stop a module this host holds, on purpose: its exit is not news. */
  halt(id: string): Stopped {
    this.#deps.states.runs.delete(id)
    this.#deps.manifests.forget(id)
    return this.#deps.nursery.stop(id)
  }

  /**
   * A process this host started has ended: news only when it is still the run the host is waiting
   * on. What it served was that process's. The supervisor decides the rest (`onEnded`).
   */
  #ended(id: string, at: number, code: number | null): void {
    const { states, manifests } = this.#deps
    if (states.runs.get(id) !== at) return
    states.runs.delete(id)
    /* What it served was that process's. */
    manifests.forget(id)
    this.#deps.onEnded(id, at, code)
  }

  /**
   * The app is stopping this host: stop the modules it started, except the ones `keeps` names, and
   * wait until they have gone (`leaving`). Their exits are this host's doing, not news to act on.
   */
  leave(signal: NodeJS.Signals, keeps: (id: string) => boolean): Promise<void> {
    const { states, nursery } = this.#deps
    const stopping = nursery.ids.filter((id) => !keeps(id))
    /* Their exits are this host's doing, not news to act on. */
    for (const id of stopping) states.runs.delete(id)
    this.#log(
      `kehikko: ${signal} — the app is stopping this host`
        + (stopping.length ? `; stopping the modules it started: ${stopping.join(', ')}` : '; it holds no modules to stop'),
    )
    return (this.#deps.leaving ?? leaving)(stopping.map((id) => nursery.release(id)).filter((held): held is Held => held !== null))
  }
}
