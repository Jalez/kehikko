/**
 * One read of each of the host's page endpoints, shared by everything on the page that needs it.
 *
 * Several parts of the page ask the host the same thing at load: the version (`/host/health`) for
 * the strip, Settings' About and What's new; the settings for the one-time question and the
 * introduction; the introduction's state for itself and the Help menu — and React's StrictMode asks
 * every one of them twice in development. Monitor's record showed each endpoint asked several times
 * per page load with the same answer. Here a read that is out is joined, and an answer is kept until
 * something says it changed:
 *
 * - `hostRead(key, load)` answers what is kept, joins the read that is out, or makes one.
 * - `{ fresh: true }` makes a new one — for a person's act (opening Settings, the Help menu).
 * - `{ keep: false }` only joins what is out and keeps nothing: for answers that change under the
 *   page and are re-read on news (the Inbox).
 * - `keepRead(key, value)` is a write's answer replacing what was kept.
 * - `forgetRead(key)` is news that it changed (the host's stream reopened: it may have restarted).
 *
 * A caller's `signal` stops its own wait, never the shared request: another part of the page may
 * be waiting for the same answer. A failed read is not kept.
 */

interface Entry {
  has: boolean
  value: unknown
  out: Promise<unknown> | null
  generation: number
}

const entries = new Map<string, Entry>()

const entryOf = (key: string): Entry => {
  let entry = entries.get(key)
  if (!entry) {
    entry = { has: false, value: undefined, out: null, generation: 0 }
    entries.set(key, entry)
  }
  return entry
}

function waitFor<T>(read: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return read
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', stop, { once: true })
    read.then(
      (value) => {
        signal.removeEventListener('abort', stop)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop)
        reject(error)
      },
    )
  })
}

export function hostRead<T>(
  key: string,
  load: () => Promise<T>,
  { fresh = false, keep = true, signal }: { fresh?: boolean; keep?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const entry = entryOf(key)
  if (!fresh && keep && entry.has) return waitFor(Promise.resolve(entry.value as T), signal)
  if (entry.out && !fresh) return waitFor(entry.out as Promise<T>, signal)
  const generation = ++entry.generation
  const out = load().then(
    (value) => {
      if (entry.generation === generation) {
        entry.out = null
        if (keep) {
          entry.has = true
          entry.value = value
        }
      }
      return value
    },
    (error: unknown) => {
      if (entry.generation === generation) entry.out = null
      throw error
    },
  )
  entry.out = out
  return waitFor(out, signal)
}

/** A write's answer: what the next read is answered with. */
export function keepRead<T>(key: string, value: T): void {
  const entry = entryOf(key)
  entry.generation++
  entry.out = null
  entry.has = true
  entry.value = value
}

/** It may have changed: the next read asks. */
export function forgetRead(key: string): void {
  const entry = entries.get(key)
  if (!entry) return
  entry.generation++
  entry.out = null
  entry.has = false
  entry.value = undefined
}

/** For tests: nothing kept, nothing out. */
export function forgetEveryRead(): void {
  entries.clear()
}
