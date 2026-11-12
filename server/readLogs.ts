import { redact, timeOf } from '../src/host/logLine.ts'
import { lastLines } from './hostLog.ts'
import { hostLogFile, logsDir, pageLogFile } from './machineDirs.ts'
import { logFile } from './moduleLog.ts'

/**
 * Reading Kehikot's logs back: `read_logs` at the host's door, and "Copy recent
 * diagnostics" in Settings (`GET /host/diagnostics`).
 *
 * Read-only by construction: nothing here opens a file for writing, and which
 * file is read is one of three kinds — the host's, the page's, or one module's
 * by its id kept to a safe file name (`logFile`) — never a path from the caller.
 * Bounded: at most `LINES_MAX` lines, read from at most the last 2 MB. Every
 * line is scrubbed again as it is read (`redact`): a module's own output is
 * whatever it printed.
 */

export const LINES_MAX = 400
export const LINES_DEFAULT = 100
const GREP_MAX = 200
/** A module's run header (`moduleLog.ts`): the time its lines after it belong to. */
const RUN_MARK = /--- kehikko started this at (\S+) ---/

export type Which = 'host' | 'page' | 'module'

export interface ReadAsked {
  which?: unknown
  module?: unknown
  since?: unknown
  grep?: unknown
  lines?: unknown
}

export type ReadAnswer = { ok: true; file: string; lines: string[]; text: string } | { ok: false; why: string }

/** `since` as a time: an ISO time, or a span back from now — `30s`, `15m`, `2h`, `1d`. */
export function sinceIn(value: unknown, now: number = Date.now()): number | null | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > 40) return null
  const span = /^(\d{1,6})\s*(s|m|h|d)$/.exec(value.trim())
  if (span) return now - Number(span[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[span[2] as 's' | 'm' | 'h' | 'd']
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : at
}

/** Which file one ask names, or why it names none. */
export function fileFor(asked: ReadAsked, dir: string = logsDir()): { ok: true; file: string; which: Which } | { ok: false; why: string } {
  const which = asked.which ?? 'host'
  if (which === 'host') return { ok: true, file: hostLogFile({ ...process.env, KEHIKOT_LOGS_DIR: dir }), which }
  if (which === 'page') return { ok: true, file: pageLogFile({ ...process.env, KEHIKOT_LOGS_DIR: dir }), which }
  if (which === 'module') {
    if (typeof asked.module !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/.test(asked.module)) {
      return { ok: false, why: 'which: "module" needs module: a module id as read_canvas prints it, e.g. "kehikot.<name>".' }
    }
    return { ok: true, file: logFile(asked.module, dir), which }
  }
  return { ok: false, why: 'which is "host" (the host’s own log), "page" (the canvas page’s) or "module" (one module’s output, with module).' }
}

/** Read one log, filtered and bounded. */
export function readLogs(asked: ReadAsked, options: { dir?: string; now?: number } = {}): ReadAnswer {
  const found = fileFor(asked, options.dir)
  if (!found.ok) return found
  const lines = asked.lines === undefined ? LINES_DEFAULT : asked.lines
  if (typeof lines !== 'number' || !Number.isInteger(lines) || lines < 1 || lines > LINES_MAX) {
    return { ok: false, why: `lines is a whole number from 1 to ${LINES_MAX}.` }
  }
  const since = sinceIn(asked.since, options.now)
  if (since === null) return { ok: false, why: 'since is an ISO time (2026-11-13T09:00:00Z) or a span back from now: 30s, 15m, 2h, 1d.' }
  if (asked.grep !== undefined && (typeof asked.grep !== 'string' || asked.grep.length > GREP_MAX)) {
    return { ok: false, why: `grep is plain text of at most ${GREP_MAX} characters, matched without regard to case.` }
  }
  const needle = typeof asked.grep === 'string' && asked.grep ? asked.grep.toLowerCase() : null

  /* Read wide enough to filter, then keep the last `lines` of what passes. */
  const read = lastLines(found.file, needle || since !== undefined ? 20_000 : lines)
  let at: number | null = null
  const kept: string[] = []
  for (const line of read) {
    const stamped = timeOf(line)
    const mark = RUN_MARK.exec(line)
    if (stamped !== null) at = stamped
    else if (mark) {
      const parsed = Date.parse(mark[1]!)
      if (!Number.isNaN(parsed)) at = parsed
    }
    if (since !== undefined && (at === null || at < since)) continue
    if (needle && !line.toLowerCase().includes(needle)) continue
    kept.push(redact(line))
  }
  const out = kept.slice(-lines)
  return { ok: true, file: found.file, lines: out, text: out.join('\n') }
}

/** The text of `read_logs`: where it read, how many lines, then the lines. */
export function readLogsText(answer: ReadAnswer): { text: string; failed: boolean } {
  if (!answer.ok) return { text: answer.why, failed: true }
  if (answer.lines.length === 0) return { text: `Nothing in ${answer.file} matches.`, failed: false }
  return { text: `${answer.lines.length} line${answer.lines.length === 1 ? '' : 's'} of ${answer.file}:\n${answer.text}`, failed: false }
}

/** "Copy recent diagnostics": the versions, then the last lines of the host's log and of the page's. */
export function diagnostics(facts: Record<string, string | number | boolean | null | undefined>, options: { dir?: string; lines?: number } = {}): string {
  const lines = options.lines ?? 200
  const host = readLogs({ which: 'host', lines }, options)
  const page = readLogs({ which: 'page', lines }, options)
  const about = Object.entries(facts)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${value}`)
  const part = (title: string, answer: ReadAnswer) =>
    answer.ok ? [`## ${title} (${answer.file}, last ${answer.lines.length} lines)`, ...(answer.lines.length ? answer.lines : ['(empty)'])] : [`## ${title}`, answer.why]
  return redact([`# Kehikot diagnostics, ${new Date().toISOString()}`, ...about, '', ...part('Host', host), '', ...part('Page', page)].join('\n'))
}
