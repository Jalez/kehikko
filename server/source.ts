import { realpathSync } from 'node:fs'

import { type Processes, within } from './takeover.ts'
import { readCheckout, releaseAt } from './updates.ts'
import type { Source } from '../src/host/source.ts'

export type { Source }

/**
 * Which folder, and which branch, a module is running from — for the header.
 *
 * The app runs a module from its installed copy, which is checked out at its
 * newest release, or follows `main` while it has none (see "Modules run from
 * their releases" in CLAUDE.md). A module that runs from anywhere else
 * — a checkout somebody started by hand, a worktree, a branch, a copy behind
 * its branch or with uncommitted changes — is still framed, and works, and
 * nothing said so. This is what says so: the container's header shows the
 * branch beside the version, and marks it when it is not the plain case.
 *
 * ## The folder that is RUNNING, not the one that is registered
 *
 * They can differ: a process started before its registration was moved keeps
 * running from the old folder. So for a module that answers, the folder is the
 * working directory of the process listening on its port (`lsof`, the same
 * reading `takeover.ts` relies on), and the registered folder only when that
 * cannot be read or nothing is listening.
 *
 * ## Cheap enough for a sweep
 *
 * A sweep runs every few seconds; this reads `lsof` and a handful of git
 * commands per module. So each module's answer is kept for `KEEP_MS`, and
 * nothing here fetches: "behind" is against the remote-tracking branch as last
 * fetched, which the host fetches whenever it brings an installed module level
 * before starting it.
 */
/** How long one module's reading is kept. */
export const KEEP_MS = 30_000

const kept = new Map<string, { at: number; key: string; source: Source | null }>()

export async function sourceOf(
  id: string,
  url: string,
  registeredDir: string | undefined,
  answering: boolean,
  processes: Pick<Processes, 'listenerOf' | 'cwdOf'>,
  now = Date.now(),
): Promise<Source | null> {
  const key = `${url}\u0000${registeredDir ?? ''}\u0000${answering}`
  const was = kept.get(id)
  if (was && was.key === key && now - was.at < KEEP_MS) return was.source
  const source = await read(url, registeredDir, answering, processes)
  kept.set(id, { at: now, key, source })
  return source
}

async function read(
  url: string,
  registeredDir: string | undefined,
  answering: boolean,
  processes: Pick<Processes, 'listenerOf' | 'cwdOf'>,
): Promise<Source | null> {
  let running: string | null = null
  if (answering) {
    try {
      const port = Number(new URL(url).port)
      const pid = port ? await processes.listenerOf(port) : null
      running = pid ? await processes.cwdOf(pid) : null
    } catch {
      running = null
    }
  }
  const registered = registeredDir ? real(registeredDir) : null
  const inRegistered = running === null || (registered !== null && within(real(running), registered))
  const dir = inRegistered ? registeredDir : running
  if (!dir) return null
  const reading = await readCheckout({ id: '', name: '', dir }, false)
  if ('error' in reading) return null
  return {
    dir,
    registered: inRegistered && registeredDir !== undefined,
    branch: reading.branch,
    upstream: reading.upstream,
    behind: reading.behind,
    ahead: reading.ahead,
    dirty: reading.dirty,
    release: reading.branch === null ? await releaseAt(dir) : null,
  }
}

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
