/**
 * One line of Kehikot's own logs — the host's (`host.log`, `server/hostLog.ts`)
 * and the page's (`page.log`, `server/pageLog.ts`) — spelled once, here, for
 * both sides: the page shapes and scrubs what it sends, the server shapes and
 * scrubs again what it writes, and `read_logs` scrubs what it reads.
 *
 * ## The shape
 *
 *     2026-11-13T09:41:02.118Z WARN  [addresses] stable addresses not used after 2504 ms …
 *
 * ISO time, level padded to five, the area in brackets, the message. One line
 * each: a newline in a message becomes ` ⏎ `, colour codes and other control
 * characters go, and a line is cut at `LINE_MAX`.
 *
 * ## What is never written
 *
 * Tokens, passwords, cookies, header values, request bodies and what a module
 * holds (a document's text, a message). The callers log ids, origins and
 * paths, never a body; `redact` is the second fence, for whatever a message
 * carries anyway — a token in a URL's query, an `Authorization:` someone
 * printed, a secret in a URL's user part.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

/** The longest line written, message included. */
export const LINE_MAX = 2_000

/** What stands where a secret was. */
export const REDACTED = '[redacted]'

/** Names whose value is a secret, wherever they are followed by `=`, `:` or `": "`. */
const SECRET_NAMES =
  '(?:[a-z_-]*token|[a-z_-]*secret|[a-z_-]*password|passwd|pwd|pass|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|proxy-authorization|cookie|set-cookie|session(?:id)?|sid|auth|credentials?|x-api-key)'

const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  /* `Bearer abc…`, `Basic abc…`, `token abc…` — a scheme and its credential. */
  [/\b(Bearer|Basic|Digest|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  /* `name=value`, `name: value`, `"name": "value"` for a name that holds a secret. */
  [new RegExp(`\\b(${SECRET_NAMES})(\\s*[=:]\\s*"?|"\\s*:\\s*")([^\\s&"',;)}\\]]+)`, 'gi'), `$1$2${REDACTED}`],
  /* The user part of a URL: `https://user:secret@host`. */
  [/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${REDACTED}@`],
  /* A JSON web token. */
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, REDACTED],
  /* Access tokens by their well-known prefixes. */
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, REDACTED],
  /* A private key block. */
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
]

/** The text with every secret-shaped part replaced by `REDACTED`. */
export function redact(text: string): string {
  let out = text
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** One line: newlines shown as ` ⏎ `, colour codes and control characters gone, cut at `max`. */
export function oneLine(text: string, max: number = LINE_MAX): string {
  const flat = text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r?\n/g, ' ⏎ ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/\t/g, ' ')
    .trimEnd()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** An area as written: lower-case words, at most 40 characters. `fallback` when nothing is left. */
export function areaIn(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const clean = value.toLowerCase().replace(/[^a-z0-9 ._:/-]+/g, '').trim().slice(0, 40)
  return clean || fallback
}

export function levelIn(value: unknown): LogLevel | null {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value) ? (value as LogLevel) : null
}

export interface LogEntry {
  at: Date
  level: LogLevel
  area: string
  message: string
}

/** The line written for one entry, scrubbed and flattened, without its newline. */
export function formatLine(entry: LogEntry): string {
  const head = `${entry.at.toISOString()} ${entry.level.toUpperCase().padEnd(5)} [${areaIn(entry.area, 'host')}] `
  return oneLine(head + redact(entry.message))
}

/** The time a written line starts with, or null when it starts with none. */
export function timeOf(line: string): number | null {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\b/.exec(line)
  if (!match) return null
  const at = Date.parse(match[1]!)
  return Number.isNaN(at) ? null : at
}

/**
 * The area a host's own line names, and the rest: `kehikko: module addresses: …`
 * is area `module addresses`. A line that names none is the host's.
 */
export function areaOfMessage(message: string, fallback = 'host'): { area: string; message: string } {
  const said = /^\s*(?:kehikko|kehikot)\s*:\s*/i.exec(message)
  const rest = said ? message.slice(said[0].length) : message
  const named = /^([a-z][a-z0-9 ._-]{0,30}):\s+(\S[\s\S]*)$/.exec(rest)
  if (named && !/^(https?|file|tauri)$/.test(named[1]!)) return { area: named[1]!.trim(), message: named[2]! }
  return { area: fallback, message: rest }
}

/** What `console.log(a, b, …)` would print, as one string: an error by its stack, anything else as JSON when it can be. */
export function formatArgs(args: readonly unknown[]): string {
  return args
    .map((one) => {
      if (typeof one === 'string') return one
      if (one instanceof Error) return errorText(one)
      if (one === undefined) return 'undefined'
      if (typeof one === 'function') return `[function ${one.name || 'anonymous'}]`
      try {
        const json = JSON.stringify(one)
        if (json === undefined) return String(one)
        return json.length > 500 ? `${json.slice(0, 499)}…` : json
      } catch {
        return String(one)
      }
    })
    .join(' ')
}

/** An error as a line: its stack's first frames, or its name and message. */
export function errorText(error: unknown, frames = 8): string {
  if (error instanceof Error) {
    const stack = typeof error.stack === 'string' ? error.stack.split('\n') : []
    const head = `${error.name}: ${error.message}`
    const at = stack.filter((line) => /^\s+at\s/.test(line)).slice(0, frames).map((line) => line.trim())
    return at.length ? `${head} ${at.join(' ')}` : head
  }
  return typeof error === 'string' ? error : formatArgs([error])
}

/** An address as a log may name it: its origin and path, never its query or fragment (where a pass or token would be). */
export function addressOnly(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url.split(/[?#]/)[0] ?? ''
  }
}
