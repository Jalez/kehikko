import { watch, type FSWatcher } from 'node:fs'

/**
 * A registration that changed on disk, heard when it changes.
 *
 * ## The case this is for
 *
 * A module whose port is taken when it starts moves itself (`claim` in the
 * protocol's `serve`) and rewrites its own registration with the new address.
 * The host only re-read the registry on a sweep, and the watch that asks
 * modules whether they are still there asked at the address of the LAST sweep.
 * When some other program answered at the old address, the watch heard an
 * answer, saw nothing change and swept nothing: the container stayed pointed
 * at the old port, saying "Something is answering … not JSON", until the person
 * reloaded — with the module already running on its new port.
 *
 * So the registry directory is watched. An event is only a reason to look:
 * the registrations are read again, and a sweep (and the pages' re-read)
 * follows only when an id was added or removed or now names another address —
 * `moved` decides. The host writing a registration itself (a move, an install)
 * therefore costs one disk read, and a sweep only when the address did change.
 */

/** The address each registration names, by id. */
export type Addresses = ReadonlyMap<string, string>

/** Whether what is on disk now differs from what the last sweep read: an id added or gone, or an address changed. Pure. */
export function moved(known: Addresses, now: Addresses): boolean {
  if (known.size !== now.size) return true
  for (const [id, url] of now) if (known.get(id) !== url) return true
  return false
}

/** How long a burst of events (a write, then a rename into place) is gathered into one look. */
export const SETTLE_MS = 150

/**
 * Watch `dir` and call `look` once a burst of changes settles. Returns a close.
 * A directory that cannot be watched (it does not exist yet, the platform has
 * no watcher) is not an error: the sweeps on focus and on the timer still run.
 */
export function watchRegistry(dir: string, look: () => void, settleMs: number = SETTLE_MS): () => void {
  let watcher: FSWatcher
  try {
    watcher = watch(dir, { persistent: false })
  } catch {
    return () => {}
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  watcher.on('change', () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      look()
    }, settleMs)
  })
  watcher.on('error', () => {})
  return () => {
    if (timer) clearTimeout(timer)
    watcher.close()
  }
}
