import type { HeaderItem } from 'kehikot-module-protocol'

/**
 * "Restart module", the host's own row at the foot of every module's Run menu.
 *
 * The module did not declare it and never hears of it: the container adds it
 * to what the module declared before the menus are drawn (`withRestart`), and a
 * press on it is the host's (`/host/restart-module`, `server/restartModule.ts`)
 * — it is never relayed to the module's page. What it holds is the one word a
 * press is waiting on, per module, and nothing else: whether the module is
 * running is the host's to say, as it always was (`lifecycle: 'restarting'`
 * covers the container the same way an update's restart does).
 */

/** The row's id. A module's own ids are its own; this one is not a module's to take. */
export const RESTART_ITEM = 'kehikot.host.restart-module'

export const RESTART_LABEL = 'Restart module'

/** Said on the row of a module this host did not start. Also the server's sentence. */
export const NOT_STARTED_BY_US = "Kehikot didn't start this module, so it can't restart it."

/** What the page knows of a restart it asked for. Absent: none in hand and none failed. */
export type RestartState = { kind: 'restarting' } | { kind: 'failed'; why: string; detail: string[] }

type RunItem = Extract<HeaderItem, { kind: 'run' }>

/** The row, as a `run` item the Run menu draws like any other. */
export function restartItem(state: RestartState | undefined, canRestart: boolean): RunItem {
  return {
    kind: 'run',
    id: RESTART_ITEM,
    label: RESTART_LABEL,
    icon: 'rotate-ccw',
    group: 'Kehikot',
    state: state?.kind === 'restarting' ? 'busy' : state?.kind === 'failed' ? 'failed' : 'idle',
    result: state?.kind === 'failed' ? 'did not come back' : null,
    disabled: canRestart ? null : NOT_STARTED_BY_US,
    confirm: false,
    agents: false,
  } as RunItem
}

/** What a module declared, and the row after it. The module's own items are never touched. */
export function withRestart(items: readonly HeaderItem[], state: RestartState | undefined, canRestart: boolean): HeaderItem[] {
  return [...items.filter((item) => item.id !== RESTART_ITEM), restartItem(state, canRestart)]
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
    why: body?.why ?? 'it could not be restarted, and the host did not say why',
    detail: Array.isArray(body?.detail) ? body.detail.filter((line): line is string => typeof line === 'string') : [],
    ...(body?.busy ? { busy: true as const } : {}),
  }
}
