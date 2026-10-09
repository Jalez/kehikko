import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { logsDir } from './machineDirs.ts'

/**
 * What the modules this host starts print, kept.
 *
 * A module's `run.sh` used to be spawned with its output discarded, so a start
 * that failed could only say "run it yourself and see what it says". The output
 * now goes to one file per module under `logsDir()`, appended by the child
 * itself (a file, not a pipe — nothing here has to drain it), and three things
 * read it: a failed start quotes its last lines, a start that is installing
 * dependencies is told apart from one that is hanging, and a person can open it.
 *
 * ## Bounded
 *
 * `trim` keeps the last `KEEP_BYTES` once a file passes `MAX_BYTES`. It runs
 * before every start and on the host's thirty-second tick for the modules it
 * holds. The child appends (`O_APPEND`), so cutting the front of the file while
 * it runs loses nothing but what was cut.
 *
 * ## One run is found by its header
 *
 * Every start writes a `RUN_MARK` line first. Everything after the last one is
 * that run's output, which is what `tail` and `installing` read.
 */

export const MAX_BYTES = 512 * 1024
export const KEEP_BYTES = 128 * 1024

const RUN_MARK = '--- kehikko started this at '

/** The file one module's output goes to. The id is a registration id, kept to a safe file name. */
export function logFile(id: string, dir: string = logsDir()): string {
  return join(dir, 'modules', `${id.replace(/[^A-Za-z0-9._@-]/g, '_')}.log`)
}

/** Make the file ready for a start: its directory, its bound, and this run's header. */
export function openRun(file: string, now: Date = new Date()): void {
  mkdirSync(dirname(file), { recursive: true })
  trim(file)
  appendFileSync(file, `${RUN_MARK}${now.toISOString()} ---\n`)
}

/** Cut the file down to its last `keep` bytes, from a line start, once it is past `max`. */
export function trim(file: string, max: number = MAX_BYTES, keep: number = KEEP_BYTES): boolean {
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return false
  }
  if (size <= max) return false
  const kept = readEnd(file, keep)
  const line = kept.indexOf('\n')
  writeFileSync(file, line === -1 ? kept : kept.slice(line + 1))
  return true
}

/** The last `bytes` of the file, or all of it when it is shorter. Empty when it cannot be read. */
function readEnd(file: string, bytes: number): string {
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
    return buffer.toString('utf8')
  } catch {
    return ''
  } finally {
    closeSync(fd)
  }
}

/** Colour codes and carriage returns, which a dev server prints and a sentence must not carry. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '')
}

/** What the last run printed: every non-empty line after the last header. */
export function lastRun(file: string): string[] {
  const end = plain(readEnd(file, 32 * 1024))
  const at = end.lastIndexOf(RUN_MARK)
  const run = at === -1 ? end : end.slice(end.indexOf('\n', at) + 1)
  return run
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
}

/**
 * The lines of the last run worth quoting, each cut to a readable width.
 *
 * From the first line that says what went wrong, when one does — an error is
 * followed by a stack that pushes it out of any "last few lines" — and
 * otherwise the last `lines`.
 */
export function tail(file: string, lines = 8): string[] {
  const run = lastRun(file)
  const from = run.findIndex((line) => /\berror\b|\bfailed\b|cannot find|not found|EADDRINUSE|ENOENT/i.test(line))
  const said = from === -1 || run.length - from <= lines ? run.slice(-lines) : run.slice(from, from + lines)
  return said.map((line) => (line.length > 240 ? `${line.slice(0, 240)}…` : line))
}

/**
 * Whether the last run said it is installing its dependencies.
 *
 * Every module's `run.sh` prints `installing…` before it runs `bun install`.
 * That line is the whole signal: the caller already knows the process is alive
 * and not answering, and this says why. It stays true until the module answers
 * or exits, so the seconds after the install — Vite rebuilding its pre-bundle —
 * read as installing too. A `run.sh` that printed a line when the install ended
 * would let this stop exactly there.
 */
export function installing(file: string): boolean {
  return lastRun(file).some((line) => /^installing(…|\.\.\.)/.test(line.trim()))
}
