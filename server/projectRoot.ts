import { mkdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * A project's folder, and the one rule about it: this host never creates it.
 *
 * ## Why this exists
 *
 * A project is a folder the person picked, and folders get renamed, moved and
 * deleted. Every write this host makes under a project went through a
 * `mkdirSync(dirname(file), { recursive: true })`, which is the right call for
 * `.kehikot/kehikko/` inside a folder that is there — and, when the folder is
 * gone, quietly rebuilds the path the person just moved away from: an empty
 * `<old name>/.kehikot/kehikko/kehikot.json` beside the folder they renamed,
 * remade at every start.
 *
 * So every write under a project root asks here first. Inside a root that
 * exists, `.kehikot/…` folders are made as before. A root that is gone is not
 * made, the write is skipped, and the log says so once per root per start —
 * not once per write, which on a host syncing every load would be a flood.
 *
 * No imports from the rest of the server, so anything may use it without a cycle.
 */

/** The sentence a person is told, here and on the page. */
export const MISSING_SAID = "Kehikot can't find this folder any more. It was moved, renamed or deleted."

/** Whether a project's folder is there now, as a directory. Read every time, never cached. */
export function projectRootExists(root: string | null | undefined): boolean {
  if (typeof root !== 'string' || !root) return false
  try {
    return statSync(resolve(root)).isDirectory()
  } catch {
    return false
  }
}

const said = new Set<string>()
let log: (line: string) => void = (line) => console.warn(line)

/** Where the one line per missing root goes. Tests pass a collector; the server leaves the default. */
export function setMissingLog(next: (line: string) => void): void {
  log = next
}

/** Forget which roots were already reported, so the next start (or test) says them again. */
export function resetMissingSaid(): void {
  said.clear()
}

/** Say once per root per start that a write under it was skipped. */
export function sayMissing(root: string): void {
  if (said.has(root)) return
  said.add(root)
  log(`kehikko: ${root} is not there any more (moved, renamed or deleted); nothing is written under it.`)
}

/**
 * Make `dir` — a folder under `root` — when `root` exists; never make `root`.
 *
 * Returns whether the write may go ahead. A missing root is reported once and
 * answers false, and the caller skips its write.
 */
export function makeUnderRoot(root: string, dir: string): boolean {
  if (!projectRootExists(root)) {
    sayMissing(root)
    return false
  }
  mkdirSync(dir, { recursive: true })
  return true
}
