/**
 * How far each install and update has got, step by step, for the page.
 *
 * An install or an update is a handful of slow things in a row — fetch or
 * clone, check out a release, install dependencies, build the page, start it,
 * wait for it to answer — and a person looking at it is owed which one is
 * running, how long it has run, and how far it has got where the step can say.
 * "Updating" alone, for a minute, reads as nothing happening.
 *
 * ## What one job says
 *
 * The step now (`StepName`), what it is about (`detail`: the release being
 * checked out, how many are ahead in the queue), a fraction where the step
 * reports one (git's `--progress`, `gitFraction`) and null where it does not,
 * how long the step and the whole job have run, the steps already done with
 * their times, and — once it ended — done, or failed with the step it failed
 * at and why.
 *
 * ## Stalled, and Cancel
 *
 * A job that has not moved for `STALLED_AFTER_MS` — no new step, no new
 * fraction, nothing printed by what it runs — says so (`stalled`), and the page
 * offers Cancel. Cancel stops the processes THIS job started, by their pid
 * (`child`), and nothing else: never by name, never a pattern. The job's own
 * signal is aborted, so the code running it stops at its next step.
 *
 * ## Several at once
 *
 * Installs and updates take a slot (`Slots`): `SLOTS` of them run at a time,
 * the rest say `queued` with how many are ahead. Each is a different module's
 * directory; what they share is the network and the package cache, which is
 * why the bound is small and not one.
 *
 * Nothing here is kept across a restart of the host: it is what is running.
 */

export type StepName = 'queued' | 'fetching' | 'cloning' | 'checkout' | 'installing' | 'building' | 'starting' | 'waiting' | 'done' | 'failed'

export type JobKind = 'install' | 'update'

/** One job as the page reads it. */
export interface JobSaid {
  id: string
  name: string
  kind: JobKind
  step: StepName
  /** What the step is about: a release (`v1.6.0`), how many are ahead. */
  detail: string | null
  /** 0..1 where the step can say how far it has got; null where it cannot. */
  fraction: number | null
  /** Bytes received so far where git says them ("1.20 MiB" → 1258291), null where not. */
  bytes?: number | null
  /** How long the step now has run. */
  stepMs: number
  /** How long the whole job has run, or ran. */
  totalMs: number
  /** The steps finished before this one, with how long each took. */
  steps: Array<{ step: StepName; ms: number }>
  /** Nothing has moved for `STALLED_AFTER_MS`: the page says so and offers Cancel. */
  stalled: boolean
  /** Ended in failure: the step it failed at, and the plain-words reason. */
  failed?: { step: StepName; why: string }
  /** Whether Cancel would stop anything: a job running and not yet ended. */
  cancellable: boolean
}

export const STALLED_AFTER_MS = 60_000
/** How long a finished job is still said, so the page can show "done" before it goes. */
export const DONE_KEPT_MS = 8_000
/** How many installs and updates run at a time. */
export const SLOTS = 2

/** What a runner reports to the job it runs for: what the program printed, and its pid. */
export interface Watch {
  /** A piece of what the program wrote to stderr, as it arrives. */
  output?(text: string): void
  /** The program started with this pid; the returned function says it ended. */
  child?(pid: number): () => void
}

export class Cancelled extends Error {
  constructor(public readonly step: StepName) {
    super('cancelled')
  }
}

/** One running install or update. */
export class Job {
  readonly id: string
  readonly name: string
  readonly kind: JobKind
  readonly #now: () => number
  readonly #changed: () => void
  readonly #abort = new AbortController()
  readonly #children = new Set<number>()
  readonly #kill: (pid: number, signal: NodeJS.Signals) => void
  readonly startedAt: number
  #step: StepName = 'queued'
  #detail: string | null = null
  #fraction: number | null = null
  #bytes: number | null = null
  #stepAt: number
  #movedAt: number
  #steps: Array<{ step: StepName; ms: number }> = []
  #endedAt: number | null = null
  #failed: { step: StepName; why: string } | null = null

  constructor(id: string, name: string, kind: JobKind, now: () => number, changed: () => void, kill: (pid: number, signal: NodeJS.Signals) => void) {
    this.id = id
    this.name = name
    this.kind = kind
    this.#now = now
    this.#changed = changed
    this.#kill = kill
    this.startedAt = now()
    this.#stepAt = this.startedAt
    this.#movedAt = this.startedAt
  }

  /** Aborted by Cancel. */
  get signal(): AbortSignal {
    return this.#abort.signal
  }

  get step(): StepName {
    return this.#step
  }

  get ended(): boolean {
    return this.#endedAt !== null
  }

  /** Move to a step. The same step again only changes its detail. Throws `Cancelled` once Cancel was pressed. */
  to(step: StepName, detail: string | null = null): void {
    if (this.#abort.signal.aborted) throw new Cancelled(this.#step)
    if (this.#endedAt !== null) return
    const now = this.#now()
    if (step !== this.#step) {
      this.#steps.push({ step: this.#step, ms: now - this.#stepAt })
      this.#step = step
      this.#stepAt = now
      this.#fraction = null
      this.#bytes = null
    }
    this.#detail = detail
    this.#movedAt = now
    this.#changed()
  }

  /** As `to`, but never throws: for a step said after the point where Cancel no longer stops the job. */
  say(step: StepName, detail: string | null = null): void {
    if (this.#abort.signal.aborted) {
      if (this.#endedAt === null && step !== this.#step) {
        const now = this.#now()
        this.#steps.push({ step: this.#step, ms: now - this.#stepAt })
        this.#step = step
        this.#stepAt = now
        this.#detail = detail
        this.#fraction = null
        this.#bytes = null
        this.#movedAt = now
        this.#changed()
      }
      return
    }
    this.to(step, detail)
  }

  /** How far the step has got, 0..1. Only a change counts as moving. */
  fraction(fraction: number): void {
    const clamped = Math.max(0, Math.min(1, fraction))
    if (this.#fraction !== null && Math.abs(clamped - this.#fraction) < 0.005) return
    this.#fraction = clamped
    this.#movedAt = this.#now()
  }

  /** Something the step runs printed: it is alive. */
  touched(): void {
    this.#movedAt = this.#now()
  }

  /** A runner's `Watch` for this job: output keeps it alive, and git's progress is its fraction. */
  watch(fractions: ((text: string) => number | null) | null = null): Watch {
    return {
      output: (text) => {
        this.touched()
        const fraction = fractions?.(text)
        if (fraction !== null && fraction !== undefined) this.fraction(fraction)
        const bytes = fractions ? gitBytes(text) : null
        if (bytes !== null) this.#bytes = bytes
      },
      child: (pid) => this.hold(pid),
    }
  }

  /** A process this job started: stopped by Cancel. The returned function says it ended. */
  hold(pid: number): () => void {
    this.#children.add(pid)
    /* Cancel pressed before the program had started: it goes at once. */
    if (this.#abort.signal.aborted) this.#stop(pid)
    return () => this.#children.delete(pid)
  }

  /** The pids this job holds now. */
  get children(): readonly number[] {
    return [...this.#children]
  }

  /** Stop this job's processes, and only these, and abort its signal. False when it had already ended. */
  cancel(): boolean {
    if (this.#endedAt !== null) return false
    this.#abort.abort()
    for (const pid of this.#children) this.#stop(pid)
    return true
  }

  #stop(pid: number): void {
    try {
      this.#kill(pid, 'SIGTERM')
    } catch {
      /* Already gone. */
    }
    const later = setTimeout(() => {
      if (!this.#children.has(pid)) return
      try {
        this.#kill(pid, 'SIGKILL')
      } catch {
        /* Gone by now. */
      }
    }, 3_000)
    ;(later as { unref?: () => void }).unref?.()
  }

  done(): void {
    if (this.#endedAt !== null) return
    const now = this.#now()
    this.#steps.push({ step: this.#step, ms: now - this.#stepAt })
    this.#step = 'done'
    this.#stepAt = now
    this.#detail = null
    this.#fraction = null
    this.#endedAt = now
    this.#changed()
  }

  /** Ended in failure at the step it was on (or `at`, a step already passed), with the reason in plain words. */
  fail(why: string, at?: StepName): void {
    if (this.#endedAt !== null) return
    this.#failed = { step: at ?? this.#step, why }
    const now = this.#now()
    this.#steps.push({ step: this.#step, ms: now - this.#stepAt })
    this.#step = 'failed'
    this.#stepAt = now
    this.#endedAt = now
    this.#changed()
  }

  said(): JobSaid {
    const now = this.#now()
    const ended = this.#endedAt
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      step: this.#step,
      detail: this.#detail,
      fraction: this.#fraction,
      bytes: this.#bytes,
      stepMs: (ended ?? now) - this.#stepAt,
      totalMs: (ended ?? now) - this.startedAt,
      steps: [...this.#steps],
      stalled: ended === null && this.#step !== 'queued' && now - this.#movedAt >= STALLED_AFTER_MS,
      ...(this.#failed ? { failed: this.#failed } : {}),
      cancellable: ended === null,
    }
  }

  endedAt(): number | null {
    return this.#endedAt
  }
}

export interface StepsDeps {
  now?: () => number
  /** A job began or ended: pages read `/host/steps` again. */
  changed?: () => void
  /** How a pid is signalled; `process.kill` when not given. Tests pass their own. */
  kill?: (pid: number, signal: NodeJS.Signals) => void
}

/** Every install and update running now, and the ones just ended. */
export class JobSteps {
  readonly #jobs = new Map<string, Job>()
  readonly #now: () => number
  readonly #changed: () => void
  readonly #kill: (pid: number, signal: NodeJS.Signals) => void
  readonly slots: Slots

  constructor(deps: StepsDeps = {}) {
    this.#now = deps.now ?? Date.now
    this.#changed = deps.changed ?? (() => {})
    this.#kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal))
    this.slots = new Slots(SLOTS)
  }

  /** A new job for this module, in place of any earlier one that has ended. A running one is returned as it is. */
  begin(id: string, name: string, kind: JobKind): Job {
    const running = this.#jobs.get(id)
    if (running && !running.ended) return running
    let last: StepName | null = null
    const job = new Job(id, name, kind, this.#now, () => {
      /* Pages are told of a beginning and an end, and of a step changing; a fraction is read when they next look. */
      if (job.step !== last) {
        last = job.step
        this.#changed()
      }
    }, this.#kill)
    this.#jobs.set(id, job)
    this.#changed()
    return job
  }

  get(id: string): Job | null {
    return this.#jobs.get(id) ?? null
  }

  /** Cancel this module's job: its processes only. False when there is none running. */
  cancel(id: string): boolean {
    return this.#jobs.get(id)?.cancel() ?? false
  }

  /** Forget a job that ended (a failure the person has read, a module removed). */
  forget(id: string): void {
    const job = this.#jobs.get(id)
    if (job?.ended) this.#jobs.delete(id)
  }

  /** What the page reads: every job running, failed, or done within `DONE_KEPT_MS`. */
  said(): Record<string, JobSaid> {
    const now = this.#now()
    const out: Record<string, JobSaid> = {}
    for (const [id, job] of this.#jobs) {
      const ended = job.endedAt()
      if (ended !== null && job.step === 'done' && now - ended > DONE_KEPT_MS) {
        this.#jobs.delete(id)
        continue
      }
      out[id] = job.said()
    }
    return out
  }

  /** Whether any job is running: the page keeps reading while one is. */
  active(): boolean {
    return [...this.#jobs.values()].some((job) => !job.ended)
  }
}

/**
 * At most `size` jobs at a time; the others wait in the order they asked,
 * each saying `queued` and how many are ahead of it.
 */
export class Slots {
  readonly #size: number
  #running = 0
  readonly #waiting: Array<{ job: Job; go: () => void; gone: () => void }> = []

  constructor(size: number) {
    this.#size = size
  }

  /** Wait for a slot; the returned function gives it back. Throws `Cancelled` when the job is cancelled while waiting. */
  async take(job: Job): Promise<() => void> {
    if (this.#running < this.#size && this.#waiting.length === 0) {
      this.#running++
      return this.#release()
    }
    await new Promise<void>((go, gone) => {
      const entry = { job, go, gone: () => gone(new Cancelled('queued')) }
      this.#waiting.push(entry)
      this.#tell()
      job.signal.addEventListener(
        'abort',
        () => {
          const at = this.#waiting.indexOf(entry)
          if (at >= 0) {
            this.#waiting.splice(at, 1)
            this.#tell()
            entry.gone()
          }
        },
        { once: true },
      )
    })
    return this.#release()
  }

  #release(): () => void {
    let given = false
    return () => {
      if (given) return
      given = true
      const next = this.#waiting.shift()
      if (next) {
        this.#tell()
        next.go()
      } else this.#running--
    }
  }

  /** Each waiting job says how many are ahead of it: the ones running, and the ones waiting before it. */
  #tell(): void {
    this.#waiting.forEach((entry, at) => {
      try {
        entry.job.to('queued', `${this.#running + at} ahead`)
      } catch {
        /* Cancelled: taken out by its abort listener. */
      }
    })
  }
}

/**
 * How far a `git clone --progress` or `git fetch --progress` has got, from
 * what it wrote to stderr (the last progress line in `text`), or null when
 * `text` has none.
 *
 * Git counts, then compresses on the server, then receives objects, then
 * resolves deltas. Receiving is most of the wait, so it is most of the bar:
 * counting and compressing up to 10%, receiving to 85%, resolving to 100%.
 */
export function gitFraction(text: string): number | null {
  const lines = text.split(/[\r\n]/).filter((line) => /\d+%/.test(line))
  const line = lines[lines.length - 1]
  if (!line) return null
  const percent = Number(/(\d{1,3})%/.exec(line)?.[1] ?? NaN)
  if (!Number.isFinite(percent)) return null
  const p = Math.min(100, percent) / 100
  if (/Receiving objects/i.test(line)) return 0.1 + 0.75 * p
  if (/Resolving deltas/i.test(line)) return 0.85 + 0.15 * p
  if (/Compressing objects/i.test(line)) return 0.05 + 0.05 * p
  if (/Counting objects|Enumerating objects/i.test(line)) return 0.05 * p
  if (/Updating files|Checking out files/i.test(line)) return 0.95 + 0.05 * p
  return null
}

const UNITS: Record<string, number> = { bytes: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 }

/** The bytes git has received so far, from the last "Receiving objects … 1.20 MiB | 2.00 MiB/s" line in `text`; null when it says none. */
export function gitBytes(text: string): number | null {
  const lines = text.split(/[\r\n]/).filter((line) => /Receiving objects/i.test(line) && /\d+(?:\.\d+)? (?:bytes|[KMG]iB)\b/.test(line))
  const line = lines[lines.length - 1]
  if (!line) return null
  const found = /(\d+(?:\.\d+)?) (bytes|[KMG]iB)\b/.exec(line.replace(/\|.*$/, ''))
  if (!found) return null
  const size = Math.round(Number(found[1]) * (UNITS[found[2]!.toLowerCase()] ?? 1))
  return Number.isFinite(size) ? size : null
}
