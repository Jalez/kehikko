import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, statSync, symlinkSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'

import { readiness } from 'kehikot-module-protocol/build'


/**
 * An installed module, built once on this machine: when it is installed and
 * when it is updated, never when it starts.
 *
 * ## What "ready-built" is
 *
 * A module that has adopted the protocol's `/build` and `/run` (2.17.0) has a
 * `build` script, which compiles its page into `dist/` and stamps
 * `dist/.kehikot-built` with the commit it was built from, and a `run.sh`
 * that serves that build (`bun run serve.ts`) when the stamp is the commit
 * checked out, and Vite otherwise. So whether a module runs ready-built is
 * decided by its own `run.sh`, from the disk, at every start; all this host
 * does is make the stamp true for the release it checked out. Nothing is
 * downloaded: the copy is the module's source at its release tag, and the
 * build is made here, with this machine's own dependencies.
 *
 * ## When
 *
 *  - After an install (`installs.ts`): cloned, put on its release, `bun
 *    install --frozen-lockfile`, then built — before the registration is
 *    written, so nothing can start it meanwhile.
 *  - After an update (`update` in `updates.ts`, through the place's `build`):
 *    the Update press, a waiting release put in place while the module is
 *    stopped (`ReleaseWaits.apply`), and a restart that takes one.
 *  - Once per host start, for copies installed before this: in the background,
 *    low priority, after the open kehikko's modules are up, and only for a
 *    module that is neither running nor wanted (`backfill`). One skipped for
 *    that is built when it next stops.
 *
 * Never at a start. A start that builds is a start that fails when the
 * network is down, and one that rebuilds behind a person serves a page
 * nobody asked for.
 *
 * ## Keyed to the commit
 *
 * A copy whose stamp already names its `HEAD` is not built again. A build
 * that failed for a commit is not tried again for that commit by the
 * background pass or a stop (it is said once, in the host's log); the next
 * update, install or host start does.
 *
 * ## One at a time, and never under a running module
 *
 * Builds are queued and run one after another, the ones a person is waiting
 * for (an install, an update) before the background pass. A build empties
 * `dist/` and takes the stamp off first, which a running built server would
 * answer with a 503, so a module that is running when its build comes up is
 * not built: it is marked, and built when it next stops. While one module's
 * build is running, that module is not started (`busy`); every other module
 * starts as it would.
 *
 * ## Failure is never fatal
 *
 * No build script, a build that fails or times out, a build that finishes
 * without stamping the commit: the module runs from source, by its own
 * `run.sh`, exactly as every module did before this. The build's output goes
 * to the module's log (`logFile`), and the host says once that it runs from
 * source and why.
 *
 * ## The Bun it is built with
 *
 * The build runs on the Bun this host runs on — inside the desktop app, the
 * one compiled into its host binary (`BUN_BE_BUN=1`, with a `bun` on the
 * build's `PATH` that is that binary), so the build does not depend on what
 * the person has installed. A ready-built module is SERVED by the `bun` on the
 * person's `PATH` (its `run.sh` execs `bun run serve.ts`), and the ones that
 * hold a terminal need `Bun.spawn({ terminal })`, which is Bun 1.4.0. Both are
 * checked once (`whyNoBuilds`); when either is older, nothing is built and
 * every module runs from source.
 */

/** How long one build may take before it is stopped and the module runs from source. */
export const BUILD_TIMEOUT_MS = 3 * 60_000

/**
 * The oldest Bun a ready-built module runs on: `Bun.spawn({ terminal })`, which
 * Terminal and Claude serve their shells with. Also the oldest Bun the desktop
 * app's host may be compiled with (`dev/build-sidecar.ts`).
 */
export const READY_BUILT_BUN = '1.4.0'

/** What is built: an installed copy, named as the person knows it. */
export interface Copy {
  id: string
  name: string
  dir: string
}

/** What asking for a build came to. */
export type Built =
  /** Built now, and stamped with the commit checked out. */
  | { kind: 'built'; commit: string }
  /** Already built for the commit checked out: nothing ran. */
  | { kind: 'current'; commit: string }
  /** No `build` script: it runs from source, as every module did. */
  | { kind: 'none' }
  /** Running, or wanted by an open kehikko (the background pass): built when it next stops. */
  | { kind: 'deferred' }
  /** Not built on this machine at all: `whyNoBuilds`. */
  | { kind: 'refused'; why: string }
  /** It ran and did not finish, or finished without stamping the commit. It runs from source. */
  | { kind: 'failed'; why: string }

/** What one run of a module's `build` script came to. `lines` are the last of what it printed. */
export type Ran = { ok: true; lines: string[] } | { ok: false; why: string; lines: string[] }

/** A build that did not finish, kept for the module's details. */
export interface Failure {
  commit: string | null
  why: string
  /** The last lines the build printed. */
  lines: string[]
}

export interface BuildDeps {
  /** Run the copy's `build` script, its output to the module's log. */
  build(copy: Copy, options: { low: boolean; timeoutMs: number }): Promise<Ran>
  /** The commit the copy has checked out, in full, or null. */
  head(dir: string): Promise<string | null>
  /** Whether `dist/` is a servable build of `commit` (`index.html`, and a stamp naming it). See `builtAt`. */
  stamp(dir: string, commit: string): boolean
  /** Whether the copy's `package.json` has a `build` script. */
  hasScript(dir: string): boolean
  /** Whether the module is running now. A build never runs under it. */
  running(id: string): Promise<boolean>
  /** Why nothing may be built on this machine, or null. Asked once. */
  unable?(): Promise<string | null>
  /** Where the module's log is, for the one line that says a build failed. */
  logOf?(id: string): string
  log(line: string): void
  /** A build was queued, started or finished: pages read the state again. */
  changed?(id: string): void
  /** A build finished: whatever waited for it (a start) is decided again. */
  finished?(id: string, built: Built): void
  timeoutMs?: number
}

export interface BuildOptions {
  /** The background pass: after everything a person is waiting for, at a lower CPU priority. */
  low?: boolean
  /** Not built now when this says so (it is wanted): marked, and built when it next stops. */
  skip?(id: string): boolean
  /** Try again a commit whose build already failed. True for an install or an update; false for the background. */
  retry?: boolean
}

interface Job {
  copy: Copy
  low: boolean
  skip: ((id: string) => boolean) | undefined
  retry: boolean
  done: Promise<Built>
  resolve(built: Built): void
}

export class ModuleBuilds {
  readonly #deps: BuildDeps
  readonly #queue: Job[] = []
  readonly #jobs = new Map<string, Job>()
  readonly #failed = new Map<string, Failure>()
  readonly #deferred = new Map<string, Copy>()
  #building: string | null = null
  #pumping = false
  #unable: Promise<string | null> | null = null

  constructor(deps: BuildDeps) {
    this.#deps = deps
  }

  /**
   * Build one copy, after whatever is queued before it. Resolves when it is
   * done (or found not to need it). A copy already queued is not queued twice:
   * the second ask joins the first, and an ask a person is waiting for lifts a
   * background one to its own terms.
   */
  build(copy: Copy, options: BuildOptions = {}): Promise<Built> {
    const low = options.low === true
    const queued = this.#jobs.get(copy.id)
    if (queued) {
      if (!low) {
        queued.low = false
        queued.skip = undefined
        queued.retry = true
        queued.copy = copy
      }
      return queued.done
    }
    let resolve: (built: Built) => void = () => {}
    const done = new Promise<Built>((settle) => (resolve = settle))
    const job: Job = { copy, low, skip: options.skip, retry: options.retry ?? !low, done, resolve }
    this.#jobs.set(copy.id, job)
    this.#queue.push(job)
    this.#deps.changed?.(copy.id)
    void this.#pump()
    return done
  }

  /** The background pass: every copy given, low priority, nothing that is wanted or running, no failed commit again. */
  backfill(copies: readonly Copy[], skip?: (id: string) => boolean): Promise<Built[]> {
    return Promise.all(copies.filter((copy) => this.#deps.hasScript(copy.dir)).map((copy) => this.build(copy, { low: true, retry: false, ...(skip ? { skip } : {}) })))
  }

  /**
   * A module stopped. When its build was put off because it was running, it is
   * built now; null when nothing was owed.
   */
  stopped(copy: Copy): Promise<Built> | null {
    if (!this.#deferred.has(copy.id)) return null
    return this.build(copy, { retry: false })
  }

  /** Whether a build was put off until this module stops. */
  owes(id: string): boolean {
    return this.#deferred.has(id)
  }

  /** This module's build is running right now: it is not started meanwhile. */
  busy(id: string): boolean {
    return this.#building === id
  }

  /** Queued or running: "Preparing Terminal…". Null when neither. */
  state(id: string): 'queued' | 'building' | null {
    if (this.#building === id) return 'building'
    return this.#jobs.has(id) ? 'queued' : null
  }

  /** The last build of this module that did not finish, until one does. */
  failure(id: string): Failure | null {
    return this.#failed.get(id) ?? null
  }

  /**
   * Every module being prepared or whose build did not finish, for the Updates
   * menu. Preparing is the one building now and the ones a person is waiting
   * for; the background pass's queue is not news until its turn comes.
   */
  said(): Record<string, { state: 'preparing' } | { state: 'failed'; why: string }> {
    const out: Record<string, { state: 'preparing' } | { state: 'failed'; why: string }> = {}
    for (const [id, failure] of this.#failed) out[id] = { state: 'failed', why: failure.why }
    for (const [id, job] of this.#jobs) if (!job.low || this.#building === id) out[id] = { state: 'preparing' }
    return out
  }

  /** A module that is no longer registered stops being remembered. */
  forgetAllBut(ids: Iterable<string>): void {
    const keep = new Set(ids)
    for (const id of [...this.#failed.keys()]) if (!keep.has(id) && !this.#jobs.has(id)) this.#failed.delete(id)
    for (const id of [...this.#deferred.keys()]) if (!keep.has(id)) this.#deferred.delete(id)
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return
    this.#pumping = true
    try {
      for (;;) {
        /* What a person is waiting for first, then the background, each in the order asked. */
        const next = this.#queue.find((job) => !job.low) ?? this.#queue[0]
        if (!next) return
        this.#queue.splice(this.#queue.indexOf(next), 1)
        let built: Built
        try {
          built = await this.#run(next)
        } catch (error) {
          built = { kind: 'failed', why: String(error) }
        }
        this.#jobs.delete(next.copy.id)
        next.resolve(built)
        this.#deps.changed?.(next.copy.id)
        this.#deps.finished?.(next.copy.id, built)
      }
    } finally {
      this.#pumping = false
    }
  }

  async #run(job: Job): Promise<Built> {
    const { copy } = job
    if (!this.#deps.hasScript(copy.dir)) {
      this.#failed.delete(copy.id)
      this.#deferred.delete(copy.id)
      return { kind: 'none' }
    }
    this.#unable ??= this.#deps.unable?.() ?? Promise.resolve(null)
    const unable = await this.#unable
    if (unable) return { kind: 'refused', why: unable }
    const commit = await this.#deps.head(copy.dir)
    if (!commit) return this.#fail(copy, null, `the commit ${copy.dir} has checked out could not be read`, [])
    if (this.#deps.stamp(copy.dir, commit)) {
      this.#failed.delete(copy.id)
      this.#deferred.delete(copy.id)
      return { kind: 'current', commit }
    }
    const failedBefore = this.#failed.get(copy.id)
    if (!job.retry && failedBefore?.commit === commit) return { kind: 'failed', why: failedBefore.why }
    if (job.skip?.(copy.id) || (await this.#deps.running(copy.id))) {
      this.#deferred.set(copy.id, copy)
      return { kind: 'deferred' }
    }
    this.#deferred.delete(copy.id)
    this.#building = copy.id
    this.#deps.changed?.(copy.id)
    let ran: Ran
    try {
      ran = await this.#deps.build(copy, { low: job.low, timeoutMs: this.#deps.timeoutMs ?? BUILD_TIMEOUT_MS })
    } finally {
      this.#building = null
    }
    const now = await this.#deps.head(copy.dir)
    if (ran.ok && now === commit && this.#deps.stamp(copy.dir, commit)) {
      this.#failed.delete(copy.id)
      this.#deps.log(`kehikko: built ${copy.name} at ${commit.slice(0, 7)} — it runs ready-built`)
      return { kind: 'built', commit }
    }
    const why = !ran.ok
      ? ran.why
      : now !== commit
        ? 'the copy moved to another commit while it was being built'
        : 'it finished without stamping the commit, so nothing vouches for the build'
    return this.#fail(copy, commit, why, ran.lines)
  }

  #fail(copy: Copy, commit: string | null, why: string, lines: string[]): Built {
    const before = this.#failed.get(copy.id)
    this.#failed.set(copy.id, { commit, why, lines })
    /* Said once per commit: a module that cannot be built is not news at every stop. */
    if (!before || before.commit !== commit) {
      const where = this.#deps.logOf ? ` — its output is in ${this.#deps.logOf(copy.id)}` : ''
      this.#deps.log(`kehikko: ${copy.name} runs from source; its build didn't finish: ${why}${where}`)
    }
    return { kind: 'failed', why }
  }
}

/**
 * Whether `dir` is `root` or inside it, both read through their links. What
 * makes a registered module an installed copy (`installsDir`), and so the only
 * kind that is ever built here: a checkout somebody registered from their own
 * folder keeps its Vite.
 */
export function isUnder(dir: string, root: string): boolean {
  const real = (path: string) => {
    try {
      return realpathSync(path)
    } catch {
      return path
    }
  }
  const inside = real(dir)
  const under = real(root)
  return inside === under || inside.startsWith(`${under}/`)
}

/** Whether a checkout's `package.json` names a `build` script. Read as data; nothing is run. */
export function hasBuildScript(dir: string): boolean {
  try {
    const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> } | null
    return typeof json?.scripts?.build === 'string' && json.scripts.build.trim().length > 0
  } catch {
    return false
  }
}

/** Whether `dist/` is a build of `commit` that the module's `run.sh` would serve: the protocol's own rule (`readiness`). */
export function builtAt(dir: string, commit: string): boolean {
  return readiness(dir, join(dir, 'dist'), commit).ok
}

/** Whether Bun `version` is older than `least`. Anything that does not read as a version is older. */
export function olderBun(version: string, least: string = READY_BUILT_BUN): boolean {
  /* Here rather than `versions.ts`, which imports `updates.ts`, which imports this. */
  const parts = (text: string) => /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(text.trim())
  const have = parts(version)
  const need = parts(least)
  if (!have || !need) return true
  for (let i = 1; i <= 3; i++) {
    const d = Number(have[i]) - Number(need[i])
    if (d !== 0) return d < 0
  }
  /* A pre-release of the version needed is older than it. */
  return have[4] !== undefined && need[4] === undefined
}

/**
 * Why nothing can be built on this machine, or null. Two Buns: the one the
 * build runs on (this process's), and the one the built module is served by
 * (`bun` on the `PATH` a module's `run.sh` is given).
 */
export async function whyNoBuilds(onPath: () => Promise<string | null>, own: string = Bun.version): Promise<string | null> {
  if (olderBun(own)) return `this Kehikot runs on Bun ${own}, and a ready-built module needs Bun ${READY_BUILT_BUN} or later, so modules run from source`
  const theirs = await onPath()
  /* No bun at all: no module starts, built or not, and the start says so. */
  if (theirs === null) return null
  if (olderBun(theirs)) {
    return `the bun on this computer is ${theirs}, and a ready-built module needs Bun ${READY_BUILT_BUN} or later to run, so modules run from source until it is updated`
  }
  return null
}

/**
 * The command and environment a build runs with: this process's own Bun.
 *
 * A host run from a checkout is `bun` already. Inside the desktop app it is a
 * compiled binary, which is Bun when `BUN_BE_BUN=1` is set; a `bun` that is
 * that binary goes first on the build's `PATH`, so a script that says `bun
 * run build.ts` runs on it too, and not on whatever the person has.
 */
const shims = new Map<string, string>()
export function buildBun(execPath: string = process.execPath, path: string = process.env.PATH ?? ''): { bun: string; env: Record<string, string> } {
  if (/^bun(\.exe)?$/.test(basename(execPath))) {
    return { bun: execPath, env: { PATH: [dirname(execPath), path].filter(Boolean).join(delimiter) } }
  }
  let shim = shims.get(execPath)
  if (!shim) {
    /* A temporary folder holding one link, made once per process. */
    shim = mkdtempSync(join(tmpdir(), 'kehikot-bun-'))
    symlinkSync(execPath, join(shim, 'bun'))
    shims.set(execPath, shim)
  }
  return { bun: execPath, env: { BUN_BE_BUN: '1', PATH: [shim, path].filter(Boolean).join(delimiter) } }
}

const BUILD_MARK = '--- kehikko built this at '
const NICE = '/usr/bin/nice'
const KEEP_LINES = 40

/**
 * Run `bun run build` in a copy, its output appended to `log`. Its own process
 * group, so a timeout stops the script and whatever it started. Low priority
 * (`nice`) for the background pass.
 */
export function runBuild(copy: Copy, options: { low: boolean; timeoutMs: number; log: string | null }): Promise<Ran> {
  return new Promise((settle) => {
    const { bun, env } = buildBun()
    const argv = [...(options.low && existsSync(NICE) ? [NICE, '-n', '10'] : []), bun, 'run', 'build']
    let fd: number | null = null
    let from = 0
    if (options.log) {
      try {
        fd = openSync(options.log, 'a')
        from = statSync(options.log).size
        writeSync(fd, `${BUILD_MARK}${new Date().toISOString()} (${copy.dir}) ---\n`)
      } catch {
        fd = null
      }
    }
    const at = Date.now()
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd: copy.dir,
        env: { ...process.env, ...env, NO_COLOR: '1', FORCE_COLOR: '0' },
        detached: true,
        stdio: fd === null ? 'ignore' : ['ignore', fd, fd],
        shell: false,
      })
    } catch (error) {
      if (fd !== null) closeSync(fd)
      settle({ ok: false, why: `bun run build could not be started: ${(error as Error).message}`, lines: [] })
      return
    }
    let timedOut = false
    const stop = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
      } catch {
        /* Already gone. */
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop('SIGTERM')
      setTimeout(() => stop('SIGKILL'), 5_000).unref?.()
    }, options.timeoutMs)
    const finish = (code: number | null, error?: Error) => {
      clearTimeout(timer)
      const seconds = Math.round((Date.now() - at) / 100) / 10
      if (fd !== null) {
        try {
          writeSync(fd, `--- the build ${code === 0 && !timedOut ? 'finished' : 'did not finish'} after ${seconds}s ---\n`)
        } catch {
          /* The log is not the build. */
        }
        closeSync(fd)
      }
      const lines = options.log ? linesSince(options.log, from) : []
      if (error) settle({ ok: false, why: `bun run build could not be started: ${error.message}`, lines })
      else if (timedOut) settle({ ok: false, why: `bun run build took longer than ${Math.round(options.timeoutMs / 1000)}s and was stopped`, lines })
      else if (code !== 0) settle({ ok: false, why: `bun run build exited with code ${code ?? 'none (it was stopped)'}`, lines })
      else settle({ ok: true, lines })
    }
    child.once('error', (error) => finish(null, error))
    child.once('exit', (code) => finish(code))
  })
}

/** The non-empty lines written to `file` from byte `from` on, the last `KEEP_LINES` of them, without colour codes. */
function linesSince(file: string, from: number): string[] {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return []
  }
  try {
    const size = statSync(file).size
    const start = Math.max(from, size - 32 * 1024)
    const buffer = Buffer.alloc(Math.max(0, size - start))
    readSync(fd, buffer, 0, buffer.length, start)
    return buffer
      .toString('utf8')
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .slice(-KEEP_LINES)
      .map((line) => (line.length > 240 ? `${line.slice(0, 240)}…` : line))
  } catch {
    return []
  } finally {
    closeSync(fd)
  }
}
