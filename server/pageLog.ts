import { areaIn, formatLine, levelIn } from '../src/host/logLine.ts'
import { LogFile } from './hostLog.ts'
import { pageLogFile } from './machineDirs.ts'

/**
 * The page's log, `page.log` (`pageLogFile`): what the canvas page tells this
 * host at `POST /host/log` — its console warnings and errors, its uncaught
 * errors and rejections, and the decisions it made (`src/host/pageLog.ts`).
 *
 * The route is the page's alone (`PAGE_ONLY` in `guard.ts`, and `fromThePage`
 * at the route). What arrives is bounded before it is looked at: a body of at
 * most `BODY_MAX` bytes, `BATCH_MAX` lines a request, `MESSAGE_MAX` characters
 * a line, and `PER_MINUTE` lines a minute across every request. What is over
 * the minute's budget is dropped and counted, and the count is one line when
 * the next minute starts. Every line is scrubbed again as it is written
 * (`formatLine`), whatever the page did.
 */

export const BODY_MAX = 64 * 1024
export const BATCH_MAX = 100
export const MESSAGE_MAX = 1_000
export const PER_MINUTE = 300
const MINUTE = 60_000
/** A page's clock is the same machine's; a time further off than this is not believed. */
const SKEW_MAX = 24 * 60 * 60 * 1000

export type Taken = { ok: true; taken: number; dropped: number } | { ok: false; status: 400 | 413; why: string }

export class PageLog {
  readonly log: LogFile
  readonly now: () => number
  #window = 0
  #used = 0
  #dropped = 0

  constructor(file: string = pageLogFile(), options: { maxBytes?: number; keep?: number; now?: () => number } = {}) {
    this.log = new LogFile(file, options)
    this.now = options.now ?? Date.now
  }

  /** Take what one request said, as text (its body). Writes what it may; says what it did. */
  take(body: string): Taken {
    if (body.length > BODY_MAX) return { ok: false, status: 413, why: `At most ${BODY_MAX} bytes a request.` }
    let said: unknown
    try {
      said = JSON.parse(body)
    } catch {
      return { ok: false, status: 400, why: 'The body is not JSON.' }
    }
    const lines = (said as { lines?: unknown } | null)?.lines
    if (!Array.isArray(lines)) return { ok: false, status: 400, why: 'Say { lines: [{ level, area, message, at }] }.' }
    if (lines.length > BATCH_MAX) return { ok: false, status: 413, why: `At most ${BATCH_MAX} lines a request.` }

    const now = this.now()
    if (now - this.#window >= MINUTE) {
      if (this.#dropped > 0) this.#write(now, 'warn', 'log', `${this.#dropped} lines from the page were dropped: more than ${PER_MINUTE} a minute.`)
      this.#window = now
      this.#used = 0
      this.#dropped = 0
    }

    let taken = 0
    let dropped = 0
    for (const one of lines) {
      const line = one as { level?: unknown; area?: unknown; message?: unknown; at?: unknown } | null
      const level = levelIn(line?.level)
      if (!level || typeof line?.message !== 'string' || !line.message) continue
      if (this.#used >= PER_MINUTE) {
        dropped++
        continue
      }
      this.#used++
      const at = typeof line.at === 'number' && Number.isFinite(line.at) && Math.abs(line.at - now) < SKEW_MAX ? line.at : now
      const message = line.message.length > MESSAGE_MAX ? `${line.message.slice(0, MESSAGE_MAX - 1)}…` : line.message
      this.#write(at, level, areaIn(line.area, 'page'), message)
      taken++
    }
    this.#dropped += dropped
    return { ok: true, taken, dropped }
  }

  #write(at: number, level: Parameters<typeof formatLine>[0]['level'], area: string, message: string): void {
    this.log.write(formatLine({ at: new Date(at), level, area, message }))
  }
}
