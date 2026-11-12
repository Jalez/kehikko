import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

import { areaOfMessage, errorText, formatArgs, formatLine, redact, type LogLevel } from '../src/host/logLine.ts'
import { hostLogFile } from './machineDirs.ts'

/**
 * The host's own log, `host.log` beside the modules' logs (`hostLogFile`).
 *
 * The modules this host starts had their output kept (`moduleLog.ts`); the host
 * itself printed to a stdout the desktop shell inherits and nobody reads, so a
 * problem seen in the app could not be traced afterwards. Now everything this
 * process says on its `console`, every uncaught error and rejection, and one
 * line at every start (versions, pid, port) go to this file too, one line each
 * in the shape `src/host/logLine.ts` spells.
 *
 * ## Bounded
 *
 * `LogFile` rotates at `MAX_BYTES`: `host.log` becomes `host.log.1`, that one
 * `host.log.2`, and the oldest goes — `KEEP` files in all. Writing is a
 * synchronous append, so a crash's last line is on disk before the process
 * ends, and a write that fails (a full disk) is dropped, never thrown.
 */

export const MAX_BYTES = 5 * 1024 * 1024
export const KEEP = 3

/** One log file with its rotation. */
export class LogFile {
  readonly file: string
  readonly maxBytes: number
  readonly keep: number
  #size: number | null = null

  constructor(file: string, options: { maxBytes?: number; keep?: number } = {}) {
    this.file = file
    this.maxBytes = options.maxBytes ?? MAX_BYTES
    this.keep = Math.max(1, options.keep ?? KEEP)
  }

  /** Append one line (a newline is added). Never throws. */
  write(line: string): void {
    try {
      const bytes = Buffer.byteLength(line) + 1
      if (this.#size === null) {
        mkdirSync(dirname(this.file), { recursive: true })
        this.#size = existsSync(this.file) ? statSync(this.file).size : 0
      }
      if (this.#size > 0 && this.#size + bytes > this.maxBytes) this.rotate()
      appendFileSync(this.file, `${line}\n`)
      this.#size += bytes
    } catch {
      /* A log that cannot be written is not a reason to fail what was being logged. */
    }
  }

  /** `file` → `file.1` → … → `file.<keep-1>`; the oldest is removed. */
  rotate(): void {
    try {
      const last = `${this.file}.${this.keep - 1}`
      if (this.keep === 1) rmSync(this.file, { force: true })
      else {
        rmSync(last, { force: true })
        for (let n = this.keep - 2; n >= 1; n--) if (existsSync(`${this.file}.${n}`)) renameSync(`${this.file}.${n}`, `${this.file}.${n + 1}`)
        if (existsSync(this.file)) renameSync(this.file, `${this.file}.1`)
      }
    } catch {
      /* Next write tries again. */
    }
    this.#size = 0
  }

  /** The files, oldest first, that exist. */
  files(): string[] {
    const out: string[] = []
    for (let n = this.keep - 1; n >= 1; n--) if (existsSync(`${this.file}.${n}`)) out.push(`${this.file}.${n}`)
    if (existsSync(this.file)) out.push(this.file)
    return out
  }
}

/** The files of a log, oldest first: `file.<n>` … `file.1`, `file`. */
export function logFiles(file: string, keep: number = KEEP): string[] {
  return new LogFile(file, { keep }).files()
}

/** The last `bytes` of a file, from a line start. Empty when it cannot be read. */
export function readEnd(file: string, bytes: number): string {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return ''
  }
  try {
    const size = statSync(file).size
    const length = Math.min(size, bytes)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    const text = buffer.toString('utf8')
    if (length === size) return text
    const line = text.indexOf('\n')
    return line === -1 ? '' : text.slice(line + 1)
  } catch {
    return ''
  } finally {
    closeSync(fd)
  }
}

/** The last `lines` lines of a rotated log, older files read when the newest has too few. Bounded by `maxBytes`. */
export function lastLines(file: string, lines: number, maxBytes = 2 * 1024 * 1024): string[] {
  const out: string[] = []
  let budget = maxBytes
  for (const one of logFiles(file).reverse()) {
    if (out.length >= lines || budget <= 0) break
    const text = readEnd(one, budget)
    budget -= Buffer.byteLength(text)
    const got = text.split('\n').filter((line) => line.length > 0)
    out.unshift(...got.slice(Math.max(0, got.length - (lines - out.length))))
  }
  return out.slice(-lines)
}

type Writer = (...args: unknown[]) => void

/** The host's log: the file, and what writes to it. */
export class HostLog {
  readonly log: LogFile
  readonly now: () => Date
  #restore: (() => void) | null = null

  constructor(file: string = hostLogFile(), options: { maxBytes?: number; keep?: number; now?: () => Date } = {}) {
    this.log = new LogFile(file, options)
    this.now = options.now ?? (() => new Date())
  }

  write(level: LogLevel, area: string, message: string): void {
    this.log.write(formatLine({ at: this.now(), level, area, message }))
  }

  /** A line the host printed, with the area its words name (`kehikko: <area>: …`). */
  said(level: LogLevel, args: readonly unknown[]): void {
    /* Scrubbed before the area is read, so `password: …` is never taken for an area. */
    const { area, message } = areaOfMessage(redact(formatArgs(args)))
    this.write(level, area, message)
  }

  /** The start line: which host, which protocol, which process, which port. */
  started(facts: { app?: string | null; host: string; protocol: string; pid: number; port: number; bundled: boolean; runtime?: string }): void {
    this.write(
      'info',
      'start',
      `--- Kehikot host started: app ${facts.app || 'unknown'}, host ${facts.host}, protocol ${facts.protocol}, pid ${facts.pid}, port ${facts.port}, ${facts.bundled ? 'bundled' : 'from a checkout'}${facts.runtime ? `, ${facts.runtime}` : ''} ---`,
    )
  }

  /**
   * Every `console` call goes to the file as well as where it went. Returns
   * what puts the console back (tests).
   */
  captureConsole(target: Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'> = console): () => void {
    const levels: Array<[keyof typeof target, LogLevel]> = [
      ['log', 'info'],
      ['info', 'info'],
      ['debug', 'debug'],
      ['warn', 'warn'],
      ['error', 'error'],
    ]
    const before = new Map<string, Writer>()
    for (const [name, level] of levels) {
      const original = target[name].bind(target) as Writer
      before.set(name, target[name] as Writer)
      ;(target as Record<string, Writer>)[name] = (...args: unknown[]) => {
        original(...args)
        this.said(level, args)
      }
    }
    const restore = () => {
      for (const [name, fn] of before) (target as Record<string, Writer>)[name] = fn
    }
    this.#restore = restore
    return restore
  }

  /**
   * An uncaught error or rejection is written, then the process ends as it
   * would have without a handler: the error on stderr and exit code 1. A
   * listener alone would keep a broken process running.
   */
  captureCrashes(on: (event: 'uncaughtException' | 'unhandledRejection', handler: (error: unknown) => void) => void = (event, handler) => process.on(event, handler), end: (error: unknown) => void = defaultEnd): void {
    on('uncaughtException', (error) => {
      this.write('error', 'uncaught', errorText(error, 16))
      end(error)
    })
    on('unhandledRejection', (error) => {
      this.write('error', 'unhandled rejection', errorText(error, 16))
      end(error)
    })
  }

  release(): void {
    this.#restore?.()
    this.#restore = null
  }
}

function defaultEnd(error: unknown): void {
  try {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? String(error)) : String(error)}\n`)
  } finally {
    process.exit(1)
  }
}
