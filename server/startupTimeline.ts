/**
 * When each step of one host start happened, from the moment the process began.
 *
 * Kept so that "it starts slowly" can be answered with numbers rather than a
 * guess: the process starting, the server listening, the registry read, the
 * first sweep, each module started and answering, the page's first paint, and
 * the work that is deliberately put off until the modules on screen are up —
 * update checks, build checks, tracker reads. Written to the host's log once,
 * when the start has settled, and answered at `GET /host/startup`.
 *
 * Times are milliseconds since the process began (`performance.now()`, whose
 * origin is the process start in Bun). A step is kept the first time it is
 * marked and never moved: a later sweep is not "the registry read".
 */

export type Mark = { step: string; at: number }

/** Steps that, once all of them are in, say the start has settled. */
export type Settled = (marks: ReadonlyMap<string, number>) => boolean

export class StartupTimeline {
  private readonly marks = new Map<string, number>()
  private logged = false

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly log: (line: string) => void = (line) => console.log(line),
  ) {}

  /** The first time `step` happened. `at`, when the caller measured it itself (a page's paint). */
  mark(step: string, at?: number): void {
    if (this.marks.has(step)) return
    this.marks.set(step, Math.max(0, Math.round(at ?? this.now())))
  }

  has(step: string): boolean {
    return this.marks.has(step)
  }

  at(step: string): number | null {
    return this.marks.get(step) ?? null
  }

  /** Every step, in the order it happened. */
  list(): Mark[] {
    return [...this.marks].map(([step, at]) => ({ step, at })).sort((a, b) => a.at - b.at)
  }

  /** The log's lines: one per step, with the gap since the one before. */
  lines(): string[] {
    let before = 0
    return this.list().map(({ step, at }) => {
      const line = `  ${String(at).padStart(6)} ms  (+${String(at - before).padStart(5)})  ${step}`
      before = at
      return line
    })
  }

  /** Written to the log once per start. `why`: what made it the moment (settled, or the time ran out). */
  write(why: string): void {
    if (this.logged) return
    this.logged = true
    this.log([`kehikko: startup timeline (${why}):`, ...this.lines()].join('\n'))
  }

  get written(): boolean {
    return this.logged
  }
}

/** The page's own steps a page may report (`POST /host/startup`), and nothing else. */
export const PAGE_STEPS = ['page script', 'page first paint', 'page modules read'] as const

/** Whether a page's report names a step it may report: one of `PAGE_STEPS`, or a module's first greeting. */
export function pageStep(step: unknown): string | null {
  if (typeof step !== 'string') return null
  if ((PAGE_STEPS as readonly string[]).includes(step)) return step
  const greeted = /^greeted ([a-z0-9][a-z0-9._-]{0,80})$/.exec(step)
  return greeted ? step : null
}
