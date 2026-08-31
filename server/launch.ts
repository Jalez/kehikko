import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { Registration } from './registrations.ts'

/**
 * Starting a module that is not running.
 *
 * ## Why this is not a contradiction
 *
 * The rest of this design is careful to say that the host does not install,
 * update or own a module. Starting one is the exception, and it is worth being
 * exact about why it is not a contradiction: a module the owner has installed
 * and registered, sitting on their disk, that they are looking at a Start
 * button for, is a program they are choosing to run. What the host must not do
 * — fetch code, update it, run something nobody named — it still does not.
 *
 * ## Why the ability lives in the registration and not the manifest
 *
 * Every other fact about a module comes from its manifest, and this one cannot,
 * for a reason that only sounds obvious once said: a manifest is served BY A
 * RUNNING MODULE. The moment you need to start something is precisely the
 * moment there is no manifest to read. The registration file — a file the
 * person wrote, on their disk, which the host reads directly — is the only
 * thing available when a module is down.
 *
 * ## The rules, and what each one closes
 *
 *  - **A registration names a directory, and one script inside it.** Not a
 *    command line. A string handed to a shell would make a registration file a
 *    place to write shell, which is a much larger thing to have on a machine
 *    than a script sitting in a directory somebody can read.
 *  - **The script is resolved and checked to stay inside that directory.** A
 *    `run.sh` reached through `../../` is refused rather than followed.
 *  - **It must exist and be executable**, and the refusal says which of the two
 *    failed, because "no such file" and "not executable" send a person to
 *    different fixes.
 *  - **Nothing starts on its own.** This is called from a press. There is no
 *    autostart, no retry loop, and no starting of a module because it appeared
 *    on a kehikko — a host that silently ran programs when a canvas loaded
 *    would be a host that runs programs.
 *  - **Started is not running.** What is reported is whether the module's
 *    manifest came back, not whether a process was created. Those are different
 *    facts and the second one is nearly useless: a script that starts and exits
 *    immediately has "started" and there is nothing there.
 */

/** The standard name, so somebody moving between modules meets one thing. */
export const RUN_SCRIPT = 'run.sh'

/** What the host would run, once it is known to be runnable. */
export interface Runnable {
  dir: string
  /** Absolute, and known to sit inside `dir`. */
  script: string
  /** What the module will be told to listen on, read from its registered url. */
  port: number | null
  /** Where to ask whether it came up. The registered origin, unchanged. */
  url: string
  /** The line shown to a person before they press Start. */
  command: string
}

export type Startable = { ok: true; run: Runnable } | { ok: false; why: string }

/**
 * Can this module be started, and with what?
 *
 * Every no is a sentence naming what to fix. A module registered without a
 * directory is the commonest case and is NOT a fault: it is a module somebody
 * starts themselves, and the container should say so rather than offering a button
 * that cannot work.
 */
export function startable(registration: Registration | null): Startable {
  if (!registration) return { ok: false, why: 'There is no registration for that module.' }
  if (!registration.dir) {
    return {
      ok: false,
      why: `${registration.id} is registered without a directory, so this host has no way to start it. Add "dir" to ${registration.file} to offer a Start button, or start it yourself.`,
    }
  }

  const dir = registration.dir
  if (!isAbsolute(dir)) {
    return { ok: false, why: `"${dir}" is not an absolute path. A relative one would be relative to wherever this host happened to be started from.` }
  }

  /* Resolved, then checked to be inside. `resolve` collapses `..` before this
     compares, so a directory that climbs out is caught here rather than
     followed. The trailing separator matters: without it `/a/bc` would count as
     inside `/a/b`. */
  const root = resolve(dir)
  const script = resolve(join(root, RUN_SCRIPT))
  if (script !== join(root, RUN_SCRIPT) || !script.startsWith(root + sep)) {
    return { ok: false, why: `The script for ${registration.id} does not sit inside ${root}.` }
  }

  try {
    if (!statSync(root).isDirectory()) return { ok: false, why: `"${root}" is not a directory.` }
  } catch {
    return { ok: false, why: `"${root}" is not there. The registration names a directory that does not exist.` }
  }

  try {
    statSync(script)
  } catch {
    return { ok: false, why: `${root} has no ${RUN_SCRIPT}. Every module is expected to ship one; this is the whole of what the host knows about starting it.` }
  }

  try {
    accessSync(script, constants.X_OK)
  } catch {
    return { ok: false, why: `${script} is not executable. \`chmod +x ${script}\` and try again.` }
  }

  return {
    ok: true,
    run: {
      dir: root,
      script,
      port: portOf(registration.url),
      url: registration.url,
      command: commandFor(script, portOf(registration.url)),
    },
  }
}

/** The line a person is shown before they press Start. */
function commandFor(script: string, port: number | null): string {
  return port === null ? script : `PORT=${port} ${script}`
}

function portOf(origin: string): number | null {
  try {
    const port = new URL(origin).port
    return port ? Number(port) : null
  } catch {
    return null
  }
}

export interface Started {
  ok: boolean
  /** What was run, so the page can show it whether or not it worked. */
  command: string
  why?: string
  /**
   * The process this host created, when it created one.
   *
   * A handle and not a number, and that distinction is the whole of the safety
   * — see the essay on `Nursery` below. A pid is a name that gets reused; this
   * is the child itself, which knows whether it has exited because the runtime
   * told it so.
   */
  child?: Child
}

/**
 * A process this host started, as the only thing that may later be signalled.
 *
 * `alive()` is not "does a process with this number exist". It is "has MY child
 * exited", answered from the `exit` event the runtime delivers for a child this
 * process spawned — so a pid that has died and been reused answers false, which
 * is the answer that matters.
 */
export interface Child {
  readonly pid: number
  alive(): boolean
}

/**
 * How long to keep asking whether it came up.
 *
 * A started module is not a running one, and the gap between them is a second
 * or two of a dev server booting. Reporting after one look would call every
 * successful start a failure — which is exactly what the first version of this
 * did: the spawn worked, the module was answering a moment later, and the
 * answer said `silent` because the sweep ran before Vite had bound its port.
 *
 * Six seconds is long enough for the modules here and short enough that a
 * person pressing a button is not left wondering. What it is NOT is a promise:
 * when it runs out, the honest answer is that the thing was run and has not
 * answered yet, which is different from saying it failed.
 */
const ANSWERS_WITHIN_MS = 6000
const ASK_EVERY_MS = 300

/**
 * Wait for the module to answer its own well-known path.
 *
 * Polling rather than watching the process, because what a person wants to know
 * is whether the module is THERE, and a live process proves nothing — a script
 * that starts and exits has run, and a script still compiling has not finished
 * being useful. The manifest answering is the fact worth reporting.
 */
export async function answered(origin: string, wellKnown: string): Promise<boolean> {
  const until = Date.now() + ANSWERS_WITHIN_MS
  while (Date.now() < until) {
    try {
      const response = await fetch(new URL(wellKnown, origin), {
        signal: AbortSignal.timeout(ASK_EVERY_MS * 2),
      })
      if (response.ok) return true
    } catch {
      /* Not up yet. Nothing here distinguishes "refused" from "still binding",
         and it does not need to: both mean ask again. */
    }
    await new Promise((wake) => setTimeout(wake, ASK_EVERY_MS))
  }
  return false
}

/**
 * Run it, and do not pretend to know more than that.
 *
 * `detached` and unref'd, because the module outlives the request that started
 * it and should outlive this host too — a person restarting the canvas has not
 * asked for their modules to be killed. Output goes to `ignore` rather than to
 * a pipe: a pipe nobody drains fills, and a filled pipe blocks the child, so a
 * module would freeze after its first few hundred lines of logging. Whoever
 * wants the logs runs the script themselves.
 *
 * The script is spawned directly rather than through a shell — no `sh -c`, no
 * string interpolation — so nothing in a registration can become shell.
 *
 * ## The child gets the host's whole environment, and that is load-bearing
 *
 * `{ ...process.env }`, with `PORT` added and nothing removed. It reads like a
 * default and it is a decision, because of one variable in particular.
 *
 * Every module in this workspace decides who may frame it from
 * `ROADMAP_ORIGIN`, falling back to `http://127.0.0.1:4181` — the browser. A
 * Tauri window's origin is `tauri://localhost`, which that fallback does not
 * include, so a module started under the desktop shell without the variable
 * serves a `frame-ancestors` header that refuses the very window framing it.
 * The container draws blank and the reason is one line in a console nobody has
 * open.
 *
 * The desktop shell sets `ROADMAP_ORIGIN` on the host process it launches. So
 * inheriting the environment is the whole of what has to happen: a module the
 * host starts is framed correctly by whatever started the host, and nothing
 * here names the variable, reads it, or has an opinion about it. A person
 * running `./run.sh` in a terminal passes nothing and their modules take the
 * browser default, which is what they want.
 *
 * Nothing is filtered out either, and that is deliberate rather than lazy: the
 * host does not know which of a person's variables a module of theirs needs,
 * and a script started by hand in a terminal would have had all of them. A
 * module started by the host should be the same program in the same
 * environment, or "start it yourself and see" stops being useful advice.
 */
export function start(run: Runnable): Started {
  try {
    const child = spawn(run.script, [], {
      cwd: run.dir,
      env: { ...process.env, ...(run.port === null ? {} : { PORT: String(run.port) }) },
      detached: true,
      stdio: 'ignore',
      shell: false,
    })
    /* Its death, noticed. `unref` below stops the child holding this process
       open; it does not stop `exit` arriving, because reaping a child is
       something the runtime does for every child it has whether or not anybody
       is waiting. This listener is the whole of how the host knows that the
       process it started is the process still wearing that pid. */
    let gone = child.pid === undefined
    child.on('exit', () => {
      gone = true
    })
    child.on('error', () => {
      gone = true
    })
    child.unref()

    if (child.pid === undefined) return { ok: true, command: run.command }
    const pid = child.pid
    return {
      ok: true,
      command: run.command,
      child: { pid, alive: () => !gone && child.exitCode === null && child.signalCode === null },
    }
  } catch (error) {
    return { ok: false, command: run.command, why: (error as Error).message }
  }
}

/**
 * What this host started, and the only thing it is allowed to stop.
 *
 * ## Why an object holding pids rather than a rule about ports
 *
 * The obvious implementation of "stop the module on 7920" is to find whatever
 * is listening there and kill it. That is not a smaller version of this; it is
 * a different and much larger claim. Every module on this machine right now was
 * started by hand in somebody's terminal — a foreground job, in a tab, with a
 * log they are reading. A host that could look up a port and kill its owner
 * could kill any of those, and the only thing between it and doing so would be
 * a policy in another file being right every single time.
 *
 * So the ability does not exist. `stop` takes a module id, looks it up in a map
 * written in exactly one place — `keep`, called immediately after this process
 * spawned the child — and refuses anything it does not find. There is no path
 * from a port, a url, a registration or a request to a signal. A module this
 * host did not start cannot be stopped by it, not because a check says no but
 * because there is nothing for the pid to be looked up in.
 *
 * ## A pid is a name that gets reused, so a pid is not what is held
 *
 * This is the failure that would be worst and quietest, and it is not
 * hypothetical: while this was being written another agent restarted eleven of
 * the thirteen modules on this machine, one at a time. Every pid the host had
 * for those is now a number belonging to nothing — and on a busy machine, a
 * number that something else will eventually be given. A host that checked
 * "does a process with this number exist" and then signalled would one day kill
 * a stranger, and the stranger would be whatever happened to inherit the
 * number: somebody's build, somebody's editor, somebody's shell.
 *
 * So what is held is a `Child` and not a number. `alive()` answers from the
 * `exit` event the runtime delivers for a child THIS PROCESS spawned, which is
 * a fact about identity and not about a number being in use. A module whose
 * process died — killed, crashed, restarted by hand — answers false from that
 * moment, and its entry is dropped the next time anything asks. The pid is used
 * once, to aim a signal, and only after `alive()` has said the process behind
 * it is still ours.
 *
 * ## Why the whole group
 *
 * `start` spawns detached, which on a POSIX system makes the child a process
 * GROUP leader. A `run.sh` is a shell that runs a dev server that spawns
 * workers, so signalling the shell alone would leave the server up and the port
 * held — the memory this whole exercise is about would not come back. The
 * signal therefore goes to `-pid`, the group; and since `alive()` has just said
 * our child is the process wearing that pid, the group named by it is ours.
 *
 * ## Why SIGTERM, then SIGKILL, and not one or the other
 *
 * SIGTERM first, because a dev server given the chance closes its sockets and
 * flushes; killed outright it can leave a port that its own restart then fails
 * to bind. SIGKILL after a pause, because a module that ignores SIGTERM would
 * otherwise be "stopped" in this map and still resident — the one outcome that
 * would make every memory number in this work a lie.
 */
export interface Held {
  /** The child itself, which knows whether it is still the process it was. */
  child: Child
  /** When the host spawned it, which is where idleness is measured from. */
  at: number
  /** The origin it was started to answer on, so a log line can name it. */
  url: string
}

/** How long a module gets to leave on its own before it is killed outright. */
export const TERM_GRACE_MS = 5000

export type Stopped = 'stopped' | 'not-ours' | 'already-gone'

export class Nursery {
  #held = new Map<string, Held>()
  readonly #signal: (pid: number, signal: NodeJS.Signals | 0) => void
  readonly #after: (ms: number, run: () => void) => void

  /**
   * The signal and the timer are injected so that the whole of this — including
   * the refusal to stop somebody else's process — can be tested without a
   * single process being created. Nothing else about it is configurable.
   */
  constructor(
    signal: (pid: number, sig: NodeJS.Signals | 0) => void = (pid, sig) => {
      process.kill(pid, sig)
    },
    after: (ms: number, run: () => void) => void = (ms, run) => {
      setTimeout(run, ms).unref()
    },
  ) {
    this.#signal = signal
    this.#after = after
  }

  /** Written in one place, immediately after a spawn this process performed. */
  keep(id: string, held: Held): void {
    this.#held.set(id, held)
  }

  /** When the host started it, or `null` if the host did not. */
  startedAt(id: string): number | null {
    return this.#alive(id)?.at ?? null
  }

  /** Whether this host holds a live process for that module. */
  holds(id: string): boolean {
    return this.#alive(id) !== null
  }

  /** Every module this host currently holds a live process for. */
  get ids(): string[] {
    return [...this.#held.keys()].filter((id) => this.#alive(id) !== null)
  }

  /**
   * Stop it, if it is ours.
   *
   * `already-gone` and `not-ours` are separate answers on purpose. The first
   * means the host started it and something else has since ended it — the
   * ordinary case while somebody restarts a module by hand — and the entry is
   * dropped, so the host stops believing it owns whatever next takes that port.
   * The second means the host never started it, and must never touch it.
   */
  stop(id: string): Stopped {
    const held = this.#held.get(id)
    if (!held) return 'not-ours'
    /* Not "is that number in use". Our child, still running. A process that
       died and whose number was handed to somebody else answers false here, and
       that is the entire reason a `Child` is held rather than a `pid`. */
    if (!held.child.alive()) {
      this.#held.delete(id)
      return 'already-gone'
    }
    this.#held.delete(id)
    try {
      this.#signal(-held.child.pid, 'SIGTERM')
    } catch {
      return 'already-gone'
    }
    this.#after(TERM_GRACE_MS, () => {
      /* Asked again, of the same handle, for the same reason: between the two
         signals the child may have exited and its number been reused, and the
         second signal must not follow the number. */
      if (!held.child.alive()) return
      try {
        this.#signal(-held.child.pid, 'SIGKILL')
      } catch {
        /* Gone between the check and the signal, which is the wanted outcome. */
      }
    })
    return 'stopped'
  }

  /** Forget one — its registration is gone, so nothing here refers to it. */
  forget(id: string): void {
    this.#held.delete(id)
  }

  /**
   * The entry, if the process behind it is still there; otherwise nothing, and
   * the stale entry is dropped as it is found.
   *
   * This is what makes a module restarted by hand behave correctly, and it
   * happens constantly: while this was being written, eleven of the thirteen
   * modules here were stopped and started again by somebody else. The host's
   * child died, somebody started the module afresh in a terminal, the port
   * answers again — and from the moment the child exited the host holds nothing
   * for it and will not stop it. A module vanishing and coming back leaves
   * ownership with whoever last actually started it, which is the only honest
   * answer available and, conveniently, the safe one.
   */
  #alive(id: string): Held | null {
    const held = this.#held.get(id)
    if (!held) return null
    if (held.child.alive()) return held
    this.#held.delete(id)
    return null
  }
}
