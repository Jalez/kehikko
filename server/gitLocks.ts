import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { join, sep } from 'node:path'

import { installsDir } from './machineDirs.ts'

/**
 * A git that crashed leaves `.git/index.lock` (or `HEAD.lock`, a ref's lock)
 * behind, and every later git in that repository refuses until it is removed.
 * An installed copy is the host's own — nobody edits it — so the host clears
 * such a lock itself, but only when nothing could still be holding it:
 *
 * - the repository is inside the installed-copies folder (never a person's checkout);
 * - the lock is older than `STALE_LOCK_MS`;
 * - no git process has the repository as its working directory or `-C` path.
 */
export const STALE_LOCK_MS = 2 * 60 * 1000

export interface LockDeps {
  now?: () => number
  /** Whether a git process is using this repository. */
  busy?: (dir: string) => boolean
  log?: (line: string) => void
  env?: Record<string, string | undefined>
}

/** Whether a running git has `dir` as its cwd or names it on its command line. */
export function gitRunningIn(dir: string): boolean {
  const ps = Bun.spawnSync(['ps', '-axo', 'command='], { stdout: 'pipe', stderr: 'ignore' })
  if (ps.exitCode === 0) {
    for (const line of ps.stdout.toString().split('\n')) {
      const program = line.trim().split(/\s+/)[0] ?? ''
      if ((program === 'git' || program.endsWith('/git')) && line.includes(dir)) return true
    }
  }
  const lsof = Bun.spawnSync(['lsof', '-a', '-c', 'git', '-d', 'cwd', '-Fn'], { stdout: 'pipe', stderr: 'ignore' })
  if (lsof.exitCode === 0 || lsof.stdout.length > 0) {
    for (const line of lsof.stdout.toString().split('\n')) if (line === `n${dir}`) return true
  }
  return false
}

/** Every `*.lock` file under a repository's `.git`, down through `refs`. */
function locksIn(gitDir: string): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number) => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(dir, name)
      if (name.endsWith('.lock')) found.push(path)
      else if (depth < 6 && (dir === gitDir ? name === 'refs' : true)) {
        try {
          if (lstatSync(path).isDirectory()) walk(path, depth + 1)
        } catch {}
      }
    }
  }
  walk(gitDir, 0)
  return found
}

function inside(dir: string, parent: string): boolean {
  try {
    const real = realpathSync(dir)
    const base = realpathSync(parent)
    return real === base || real.startsWith(base + sep)
  } catch {
    return false
  }
}

/** Whether `dir` is a copy the host installed itself, below the installed-copies folder. */
export function isInstalledCopy(dir: string, env: Record<string, string | undefined> = process.env): boolean {
  const base = installsDir(env)
  return inside(dir, base) && realpathSync(dir) !== realpathSync(base)
}

export type Leftover = { path: string; removed: boolean; why?: 'outside' | 'fresh' | 'busy' }

/** Remove the leftover locks of an installed copy when it is safe to; say what became of each. */
export function clearStaleLocks(dir: string, deps: LockDeps = {}): Leftover[] {
  const gitDir = join(dir, '.git')
  if (!existsSync(gitDir)) return []
  const locks = locksIn(gitDir)
  if (!locks.length) return []
  const env = deps.env ?? process.env
  const now = (deps.now ?? Date.now)()
  const log = deps.log ?? ((line: string) => console.warn(line))
  const results: Leftover[] = []
  const owned = isInstalledCopy(dir, env)
  let busy: boolean | null = null
  for (const path of locks) {
    if (!owned) {
      results.push({ path, removed: false, why: 'outside' })
      continue
    }
    let age: number
    try {
      age = now - lstatSync(path).mtimeMs
    } catch {
      continue
    }
    if (age < STALE_LOCK_MS) {
      results.push({ path, removed: false, why: 'fresh' })
      continue
    }
    busy ??= (deps.busy ?? gitRunningIn)(dir)
    if (busy) {
      results.push({ path, removed: false, why: 'busy' })
      continue
    }
    try {
      rmSync(path, { force: true })
      log(`[updates] removed a leftover git lock, ${Math.round(age / 60000)} minutes old, with no git running: ${path}`)
      results.push({ path, removed: true })
    } catch {
      results.push({ path, removed: false, why: 'busy' })
    }
  }
  return results
}

/** The lock file git names in a "File exists" refusal, or null when the failure is not a lock. */
export function lockNamedIn(stderr: string): string | null {
  return /Unable to create '([^']+\.lock)': File exists/.exec(stderr)?.[1] ?? null
}

/** A complete sentence for a lock that could not be cleared, with no part of git's text cut off. */
export function lockSaid(path: string, dir: string, env: Record<string, string | undefined> = process.env): string {
  return isInstalledCopy(dir, env)
    ? `A leftover git lock file was left in its installed copy (${path}). Kehikot removes it by itself when nothing is using it, and will try again at the next check.`
    : `A leftover git lock file was left in this folder. If nothing is using it, remove the leftover lock file by hand: ${path}.`
}
