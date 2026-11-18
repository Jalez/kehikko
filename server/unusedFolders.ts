import { execFile } from 'node:child_process'
import { existsSync, readdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import type { UnusedFolder } from '../src/host/unusedFolders.ts'
import type { Trashed } from '../src/host/unusedFolders.ts'

/**
 * Clearing the folders Kehikot no longer uses (after "Kehikko development" is switched off).
 *
 * ## The rules
 *
 *  - Only a folder the development switch says it freed (`freed` in the setting) is ever a candidate,
 *    and the paths of a request are matched against that list: a request names nothing of its own.
 *  - A candidate is kept, with the reason, when any registration names it, when a module is set to run
 *    from it, when it is a git checkout with changes not committed (`git status --porcelain`) or
 *    commits on no remote (`git log --branches --not --remotes`), or when git cannot be asked.
 *  - Beside a checkout, `<name>-worktrees` goes too only when every worktree in it passes the same
 *    checks; otherwise it stays, and says so.
 *  - Moved to the Trash, never deleted: Finder first (so "Put Back" works), else the Trash folder.
 *  - Every request checks again: a listing is never trusted at the press.
 *
 * Nothing here is reachable from an agent: the route is the page's alone (`PAGE_ONLY`), and there is
 * no tool for it.
 */

export interface UnusedDeps {
  /** The folders the switch freed, still there. */
  candidates(): Promise<string[]>
  /** Who still uses `dir`, by name, or null. */
  usedBy(dir: string): Promise<string | null>
  /** Run `git` in `cwd`: its output, or null when it could not be run or failed. */
  git(cwd: string, args: string[]): Promise<string | null>
  size(dir: string): Promise<number>
  trash(dir: string): Promise<{ ok: true } | { ok: false; why: string }>
}

/** Why a folder must stay, or null when it may go. */
async function refusal(dir: string, deps: UnusedDeps): Promise<string | null> {
  const user = await deps.usedBy(dir)
  if (user) return `still used by ${user}`
  if (!existsSync(join(dir, '.git'))) return null
  const status = await deps.git(dir, ['status', '--porcelain'])
  if (status === null) return 'git could not check it for changes'
  if (status.trim()) return 'has uncommitted changes'
  const unpushed = await deps.git(dir, ['log', '--branches', '--not', '--remotes', '--oneline'])
  if (unpushed === null) return 'git could not check it for unpushed commits'
  if (unpushed.trim()) return 'has commits that are not pushed'
  return null
}

function childFolders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((one) => one.isDirectory()).map((one) => join(dir, one.name))
  } catch {
    return []
  }
}

/** Every candidate and its worktrees folder, each checked now, with its size. Moves nothing. */
export async function inspect(deps: UnusedDeps): Promise<UnusedFolder[]> {
  const out: UnusedFolder[] = []
  for (const dir of await deps.candidates()) {
    const why = await refusal(dir, deps)
    out.push({ dir, bytes: await deps.size(dir), trash: why === null, why, worktrees: false })
    const beside = `${dir}-worktrees`
    if (!existsSync(beside)) continue
    let blocked: string | null = null
    for (const tree of childFolders(beside)) {
      const found = await refusal(tree, deps)
      if (found) {
        blocked = `${basename(tree)} ${found}`
        break
      }
    }
    out.push({ dir: beside, bytes: await deps.size(beside), trash: blocked === null, why: blocked, worktrees: true })
  }
  return out
}

/** Move the folders asked for to the Trash: those in the list, checked again, that still pass. */
export async function trashUnused(asked: readonly string[], deps: UnusedDeps): Promise<{ done: Trashed; freed: string[] }> {
  const now = await inspect(deps)
  const done: Trashed = { moved: [], kept: [] }
  const freed: string[] = []
  for (const dir of asked) {
    const one = now.find((entry) => entry.dir === dir)
    if (!one) {
      done.kept.push({ dir, why: 'Kehikot does not list it as unused' })
      continue
    }
    if (!one.trash) {
      done.kept.push({ dir, why: one.why ?? 'it did not pass a check' })
      continue
    }
    const moved = await deps.trash(dir)
    if (!moved.ok) done.kept.push({ dir, why: moved.why })
    else {
      done.moved.push({ dir, bytes: one.bytes })
      if (!one.worktrees) freed.push(dir)
    }
  }
  return { done, freed }
}

export function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (error, stdout) => done(error ? null : stdout))
  })
}

/** A folder's size on disk, in bytes (`du`); 0 when it cannot be read. */
export function folderSize(dir: string): Promise<number> {
  return new Promise((done) => {
    execFile('du', ['-sk', dir], { timeout: 120_000 }, (error, stdout) => {
      const kilobytes = Number(/^\s*(\d+)/.exec(stdout)?.[1])
      done(error && !Number.isFinite(kilobytes) ? 0 : (Number.isFinite(kilobytes) ? kilobytes : 0) * 1024)
    })
  })
}

/** To the macOS Trash through Finder (so "Put Back" works), else into the Trash folder; never a delete. */
export async function moveToTrash(dir: string): Promise<{ ok: true } | { ok: false; why: string }> {
  if (!statSyncOk(dir)) return { ok: false, why: 'it is not there any more' }
  if (process.platform === 'darwin') {
    await new Promise<void>((done) => {
      execFile('osascript', ['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv))', '-e', 'end run', dir], { timeout: 120_000 }, () => done())
    })
    if (!existsSync(dir)) return { ok: true }
  }
  const trash = join(homedir(), '.Trash') // kehikot-storage: allow the person's own Trash is where a folder they asked to clear goes
  if (!existsSync(trash)) return { ok: false, why: 'there is no Trash folder here to move it to' }
  let target = join(trash, basename(dir))
  for (let n = 2; existsSync(target); n += 1) target = join(trash, `${basename(dir)} ${n}`)
  try {
    renameSync(dir, target)
    return { ok: true }
  } catch (error) {
    return { ok: false, why: `it could not be moved to the Trash: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function statSyncOk(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}
