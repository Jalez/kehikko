import type { Presence } from './registry.ts'

/**
 * "Restart module", a row the host draws in every container's Container menu
 * (`FrameRows` in `canvas/HeaderMenus.tsx`, the `restart` entry of
 * `FRAME_ENTRIES`), and so in the one "⋯" when the header is narrow.
 *
 * It is the host's, for every module, whatever the module declared: the module
 * never hears of it, and a press is the host's (`/host/restart-module`,
 * `server/restartModule.ts`). It is never hidden. A module this host did not
 * start keeps the row, disabled, with the reason (`restartable`). What the page
 * holds is the one word a press is waiting on, per module, and nothing else:
 * whether the module is running is the host's to say, as it always was
 * (`lifecycle: 'restarting'` covers the container the same way an update's
 * restart does), and the frame gets a new document once the new process
 * answers (`Runs` in `host/standing.ts`).
 */

export const RESTART_LABEL = 'Restart module'

/** Said on the row of a module this host did not start. Also the server's sentence. */
export const STARTED_OUTSIDE = 'Started outside Kehikot: restart it where it runs'

/** Said on the row of a container that shows a pinned version: a restart would restart the module's own copy. */
export const PINNED_VERSION = 'This container shows a pinned version: Restart module restarts only the module’s own copy'

/** What the page knows of a restart it asked for. Absent: none in hand and none failed. */
export type RestartState = { kind: 'restarting' } | { kind: 'failed'; why: string; detail: string[] }

/** Whether the row can be pressed, and the reason when it cannot. */
export type Restartable = { ok: true } | { ok: false; why: string }

/**
 * Whether this host may restart the module, from what the sweep said of it.
 *
 * `run` is set only while this host holds the module's process (`Nursery`), so
 * that is the one that can be stopped. A module that is not answering at all
 * and has a directory is started by a restart. Anything else answering at its
 * address was started outside Kehikot, and is not this host's to stop. The
 * server judges again at the press (`server/restartModule.ts`).
 */
export function restartable(presence: Pick<Presence, 'run' | 'dir' | 'reached'>): Restartable {
  if (presence.run !== undefined) return { ok: true }
  if (presence.dir === undefined) return { ok: false, why: STARTED_OUTSIDE }
  if (presence.reached) return { ok: false, why: STARTED_OUTSIDE }
  return { ok: true }
}

/** What the server answers a restart with, read as one thing. */
export type RestartAnswer = { ok: true } | { ok: false; why: string; detail: string[]; busy?: true }

export async function askRestart(id: string): Promise<RestartAnswer> {
  const response = await fetch('/host/restart-module', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ module: id }),
  })
  const body = (await response.json().catch(() => null)) as { ok?: boolean; why?: string; detail?: unknown; busy?: boolean } | null
  if (body?.ok) return { ok: true }
  return {
    ok: false,
    why: body?.why ?? 'it could not be restarted, and Kehikot did not say why',
    detail: Array.isArray(body?.detail) ? body.detail.filter((line): line is string => typeof line === 'string') : [],
    ...(body?.busy ? { busy: true as const } : {}),
  }
}
