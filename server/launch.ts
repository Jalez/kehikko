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
    child.unref()
    return { ok: true, command: run.command }
  } catch (error) {
    return { ok: false, command: run.command, why: (error as Error).message }
  }
}
