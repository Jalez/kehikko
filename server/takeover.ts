import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { TERM_GRACE_MS, type Runnable } from './launch.ts'

/**
 * Restarting a module this host did not start — only when the host can prove
 * the program on the module's port IS that module.
 *
 * ## Why this exists beside `Nursery`
 *
 * `start` spawns detached, so a module outlives the host that started it. The
 * desktop app now restarts the host after a host update, and the new host's
 * nursery is empty: every module the old host started is, to it, somebody
 * else's. The update modal then pressed Restart on a module that had just been
 * updated and got "this host did not start it" — about a module a host did
 * start, a minute ago, from the registration it was reading.
 *
 * ## The proof, and why it is a directory and not a port
 *
 * `Nursery`'s essay is right that "kill whatever is on 7920" is a far larger
 * claim than "stop what I started", and this does not make that claim. A port
 * names nothing; anything can be listening there. What is checked instead is
 * WHERE the listener is running from: its working directory must be the
 * registration's `dir`, or inside it — the directory the person named, holding
 * the `run.sh` this host would run, which is where every module's dev server
 * runs from. A program on that port running from anywhere else is refused with
 * a sentence, and nothing is signalled.
 *
 * The signal goes to the listener's process group, as the nursery's does —
 * a `run.sh` is a shell over a server over workers — but only once the group is
 * known not to hold more than the module: never group 0 or 1, never the host's
 * own group, and never a group whose leader is alive and running from somewhere
 * other than the module's directory (an interactive shell that never gave its
 * job a group of its own would otherwise be killed along with it).
 *
 * ## After
 *
 * The replacement is started by the ordinary `start`, so it is a `Child` of
 * this process and goes into the nursery like any other — later stops and
 * restarts are the nursery's, and none of this runs for it again.
 */

/** What the host may ask of the operating system about other processes. Injected so tests never touch one. */
export interface Processes {
  /** The pid listening on that TCP port, or `null` when nothing is. Throws when it cannot find out. */
  listenerOf(port: number): Promise<number | null>
  /** That process's working directory, or `null` when it cannot be read (gone, or not ours to read). */
  cwdOf(pid: number): Promise<string | null>
  /** That process's group, or `null` when it is gone. */
  groupOf(pid: number): Promise<number | null>
  /** Signal a whole process group. */
  signalGroup(pgid: number, signal: NodeJS.Signals): void
  /** Whether nothing is listening on that port any more. */
  portFree(port: number): Promise<boolean>
  /** This host's own process group, which is never signalled. */
  ownGroup(): Promise<number | null>
  /** Wait. A real timer in the host, a no-op in tests. */
  sleep(ms: number): Promise<void>
}

export type TakeOver =
  /** Nothing was listening by the time anyone looked: start normally. */
  | { kind: 'nothing' }
  /** The module's group was stopped and its port is free. `killed` when SIGTERM was not enough. */
  | { kind: 'stopped'; pgid: number; killed: boolean }
  /** Not proven to be the module, or not stoppable. Nothing was signalled unless said. */
  | { kind: 'refused'; why: string }

const POLL_MS = 250
/** After SIGKILL the kernel lets go of the socket almost at once; this is only a bound. */
const KILL_GRACE_MS = 2000

/** Whether `path` is `root` or sits inside it, compared after symlinks are resolved. */
export function within(path: string, root: string): boolean {
  /* Real paths, so /var and /private/var (macOS) compare equal. A path that
     no longer exists is resolved through its nearest existing ancestor. */
  const real = (p: string): string => {
    const full = resolve(p)
    try {
      return realpathSync(full)
    } catch {
      const parent = dirname(full)
      return parent === full ? full : join(real(parent), basename(full))
    }
  }
  const a = real(path)
  const b = real(root)
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

/**
 * Stop the program on `run`'s port if, and only if, it runs from `run.dir`.
 *
 * `id` is only for the sentences.
 */
export async function takeOver(id: string, run: Runnable, os: Processes): Promise<TakeOver> {
  const refuse = (detail: string): TakeOver => ({
    kind: 'refused',
    why:
      `${id} is already running at ${run.url} and this host did not start it, so it cannot restart it — `
      + `${detail} Stop it where you started it and press this again — or reload this page, which is `
      + 'enough when the module is fine and this container is holding a stale copy of its page.',
  })

  if (run.port === null) return refuse('its registration names no port, so there is nothing to find it by.')

  let pid: number | null
  try {
    pid = await os.listenerOf(run.port)
  } catch {
    return refuse(`this host could not ask which program is listening on port ${run.port}.`)
  }
  if (pid === null) return { kind: 'nothing' }

  const cwd = await os.cwdOf(pid)
  if (cwd === null || !within(cwd, run.dir)) {
    return refuse(`the program listening on port ${run.port} is not running from ${run.dir}.`)
  }

  const pgid = await os.groupOf(pid)
  const own = await os.ownGroup()
  if (pgid === null || pgid <= 1 || own === null || pgid === own) {
    return refuse(`the program on port ${run.port} shares a process group this host will not signal.`)
  }
  /* The leader of the group is what decides how much the group holds. Gone is
     fine — `run.sh` may have exec'd or exited and left its server — but alive
     and running from elsewhere means the group is more than the module. */
  if (pgid !== pid) {
    const leader = await os.cwdOf(pgid)
    if (leader !== null && !within(leader, run.dir)) {
      return refuse(`the program on port ${run.port} shares a process group with something not running from ${run.dir}.`)
    }
  }

  try {
    os.signalGroup(pgid, 'SIGTERM')
  } catch {
    /* Gone between the look and the signal. The port will say. */
  }
  if (await freed(run.port, TERM_GRACE_MS, os)) return { kind: 'stopped', pgid, killed: false }

  /* Asked again before the second signal, for the nursery's reason: in five
     seconds the group may have gone and its number been handed on. Only a
     listener still in the same group gets SIGKILL. */
  let still: number | null
  try {
    still = await os.listenerOf(run.port)
  } catch {
    still = null
  }
  if (still === null) return { kind: 'stopped', pgid, killed: false }
  if ((await os.groupOf(still)) !== pgid) {
    return refuse(`something else took port ${run.port} while the old one was stopping.`)
  }
  try {
    os.signalGroup(pgid, 'SIGKILL')
  } catch {
    /* Gone, which is what was wanted. */
  }
  await freed(run.port, KILL_GRACE_MS, os)
  return { kind: 'stopped', pgid, killed: true }
}

async function freed(port: number, ms: number, os: Processes): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += POLL_MS) {
    if (await os.portFree(port)) return true
    await os.sleep(POLL_MS)
  }
  return os.portFree(port)
}

/* ---------- the real thing: lsof and ps, args arrays, no shell ---------- */

const ASK_TIMEOUT_MS = 3000

/** Run a program and return its stdout, or `null` when it exited non-zero with nothing to say. Throws when it could not run. */
function ask(file: string, args: string[]): Promise<string | null> {
  return new Promise((done, fail) => {
    execFile(file, args, { timeout: ASK_TIMEOUT_MS, shell: false }, (error, stdout) => {
      if (!error) return done(stdout)
      const code = (error as NodeJS.ErrnoException).code
      if (typeof code === 'string') return fail(error) // ENOENT, EACCES: could not ask at all
      if (error.killed) return fail(error) // timed out
      done(stdout.trim() === '' ? null : stdout)
    })
  })
}

/** `lsof` lives in /usr/sbin on macOS, which a GUI-launched host's PATH may lack. */
async function lsof(args: string[]): Promise<string | null> {
  try {
    return await ask('lsof', args)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return ask('/usr/sbin/lsof', args)
  }
}

const firstNumber = (out: string | null): number | null => {
  const line = out?.split('\n').map((l) => l.trim()).find((l) => /^\d+$/.test(l))
  return line ? Number(line) : null
}

export const systemProcesses: Processes = {
  async listenerOf(port) {
    return firstNumber(await lsof(['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']))
  },
  async cwdOf(pid) {
    try {
      const out = await lsof(['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
      const line = out?.split('\n').find((l) => l.startsWith('n'))
      return line ? line.slice(1) : null
    } catch {
      return null
    }
  },
  async groupOf(pid) {
    try {
      return firstNumber(await ask('ps', ['-o', 'pgid=', '-p', String(pid)]))
    } catch {
      return null
    }
  },
  signalGroup(pgid, signal) {
    /* The last line of defence, repeated here so no caller can get it wrong. */
    if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`refusing to signal process group ${pgid}`)
    process.kill(-pgid, signal)
  },
  async portFree(port) {
    try {
      return (await systemProcesses.listenerOf(port)) === null
    } catch {
      return false
    }
  },
  async ownGroup() {
    try {
      return firstNumber(await ask('ps', ['-o', 'pgid=', '-p', String(process.pid)]))
    } catch {
      return null
    }
  },
  sleep: (ms) => new Promise((wake) => setTimeout(wake, ms)),
}
