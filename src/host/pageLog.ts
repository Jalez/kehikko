import { areaIn, errorText, formatArgs, oneLine, redact, type LogLevel } from './logLine.ts'

/**
 * What this page tells the host's log (`page.log`, `server/pageLog.ts`).
 *
 * Its console warnings and errors, its uncaught errors and rejections, and a
 * few DECISIONS — the lines nobody could see before, when a page framed its
 * modules on their ports instead of the stable `/m/<id>/` addresses and
 * nothing said why:
 *
 *  - `addresses`: the stable-address check, its result, how long it took and
 *    its timeout (`addressCheck.ts`);
 *  - `frames`: the address each module's frame was given and why, and a frame
 *    followed to a module's new address (`ModuleFrame.tsx`);
 *  - `quiet`: a module reported silent, and the one reload before it;
 *  - `switch`: the project and kehikko this page shows, by id;
 *  - `press`: a module's start, stop or restart pressed, and what came of it.
 *
 * Never a body, a document's text, a message or a header — ids, origins and
 * paths only, and `redact` over every line before it leaves.
 *
 * ## Batched
 *
 * Lines wait in `buffer` and go together: every `FLUSH_MS`, at `BATCH_LINES`,
 * and on `pagehide` (with `keepalive`, so they outlive the page). The buffer
 * holds at most `BUFFER_MAX`; past that the oldest go and are counted. A post
 * that fails is not retried and logs nothing: a log about the log would loop.
 */

export const FLUSH_MS = 3_000
export const BATCH_LINES = 50
export const BUFFER_MAX = 500
/** The longest message sent; the host cuts again at its own bound. */
export const MESSAGE_MAX = 1_000

export interface PageLine {
  at: number
  level: LogLevel
  area: string
  message: string
}

type Post = (lines: PageLine[], keepalive: boolean) => void

const postToHost: Post = (lines, keepalive) => {
  /* Only a page has a host to tell; outside one (a test) the lines are dropped. */
  if (typeof window === 'undefined' || typeof fetch === 'undefined') return
  void fetch('/host/log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lines }),
    keepalive,
  }).catch(() => null)
}

let buffer: PageLine[] = []
let dropped = 0
let timer: ReturnType<typeof setTimeout> | null = null
let post: Post = postToHost
let now: () => number = () => Date.now()

/** One line for the host's page log. */
export function pageLog(level: LogLevel, area: string, message: string): void {
  const line: PageLine = { at: now(), level, area: areaIn(area, 'page'), message: oneLine(redact(message), MESSAGE_MAX) }
  if (!line.message) return
  buffer.push(line)
  if (buffer.length > BUFFER_MAX) {
    dropped += buffer.length - BUFFER_MAX
    buffer = buffer.slice(-BUFFER_MAX)
  }
  if (buffer.length >= BATCH_LINES) flushPageLog()
  else if (!timer && typeof setTimeout !== 'undefined') {
    timer = setTimeout(() => flushPageLog(), FLUSH_MS)
    /* Outside a page (a test), a waiting batch never keeps the process alive. */
    ;(timer as { unref?: () => void }).unref?.()
  }
}

/** A decision this page made, for the page log. */
export function decide(area: string, message: string): void {
  pageLog('info', area, message)
}

/** Send what waits. `keepalive` when the page is going. */
export function flushPageLog(keepalive = false): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (dropped > 0) {
    buffer.unshift({ at: now(), level: 'warn', area: 'log', message: `${dropped} page log lines were dropped before they could be sent.` })
    dropped = 0
  }
  while (buffer.length > 0) {
    const batch = buffer.slice(0, BATCH_LINES)
    buffer = buffer.slice(BATCH_LINES)
    post(batch, keepalive)
  }
}

type Target = {
  console: Pick<Console, 'warn' | 'error'>
  addEventListener(type: string, listener: (event: never) => void): void
}

let captured = false

/**
 * Send this page's console warnings and errors, uncaught errors and
 * rejections, and flush on `pagehide`. Once per page.
 */
export function capturePage(target: Target | undefined = typeof window === 'undefined' ? undefined : (window as unknown as Target)): void {
  if (!target || captured) return
  captured = true
  let inside = false
  for (const [name, level] of [['warn', 'warn'], ['error', 'error']] as const) {
    const original = target.console[name].bind(target.console)
    target.console[name] = (...args: unknown[]) => {
      original(...args)
      /* A console call made while logging one is not logged again. */
      if (inside) return
      inside = true
      try {
        pageLog(level, 'console', formatArgs(args))
      } finally {
        inside = false
      }
    }
  }
  target.addEventListener('error', ((event: ErrorEvent) => {
    const where = event.filename ? ` (${event.filename.split(/[?#]/)[0]}:${event.lineno}:${event.colno})` : ''
    pageLog('error', 'uncaught', event.error ? `${errorText(event.error)}${where}` : `${event.message}${where}`)
  }) as never)
  target.addEventListener('unhandledrejection', ((event: PromiseRejectionEvent) => {
    pageLog('error', 'unhandled rejection', errorText(event.reason))
  }) as never)
  target.addEventListener('pagehide', (() => flushPageLog(true)) as never)
}

/** For tests: where lines go and what time it is, and a clean start. */
export function resetPageLog(options: { post?: Post; now?: () => number } = {}): void {
  if (timer) clearTimeout(timer)
  timer = null
  buffer = []
  dropped = 0
  captured = false
  post = options.post ?? postToHost
  now = options.now ?? (() => Date.now())
}

/** For tests: what waits to be sent. */
export function pendingPageLog(): readonly PageLine[] {
  return buffer
}
