import type { InboxAdoptResult, InboxAdoptionResult } from 'kehikot-module-protocol'

/**
 * The page's side of adopting a tracker item no epic names (protocol 2.88.0): the server's routes
 * (`server/adoptRoutes.ts`), every one the page's alone. The person's press is checked before any of
 * these is called (`answerInbox`, and the dialog's own buttons).
 */

type Key = { module: string; id: string }

/**
 * How long the page waits for one of these routes. None of them waits on a module for longer than a
 * few seconds (`AGENT_START_MS` in `server/agentSession.ts`, `ADOPTION_LIMITS` in `server/adoption.ts`),
 * and a module's page that asked through the host gives up after 12 s, so the page gives up before
 * that and says why.
 */
export const ASK_WITHIN_MS = 10_000

/** An answer, or why there was none, in words. */
type Asked<T> = { ok: true; body: T } | { ok: false; why: string }

async function asked<T>(url: string, init?: RequestInit, within = ASK_WITHIN_MS): Promise<Asked<T>> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(within) })
    const body = (await response.json().catch(() => null)) as (T & { error?: unknown }) | null
    if (!response.ok) {
      const said = body && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`
      /* A failure says its reason as the host gave it (every 5xx carries one, `server/routeFailure.ts`). */
      if (response.status >= 500) return { ok: false, why: `${said.replace(/\.$/, '')}. Nothing was changed.` }
      return { ok: false, why: `Kehikot refused it: ${said.replace(/\.$/, '')}. Nothing was changed.` }
    }
    if (body === null) return { ok: false, why: 'Kehikot answered in a shape this page does not read. Nothing was changed.' }
    return { ok: true, body }
  } catch (error) {
    const name = (error as { name?: string } | null)?.name
    return {
      ok: false,
      why:
        name === 'TimeoutError' || name === 'AbortError'
          ? `Kehikot did not answer within ${Math.round(within / 1000)} s. Nothing was changed.`
          : `Kehikot's server could not be reached (${(error as Error)?.message ?? 'no reason'}). Nothing was changed.`,
    }
  }
}

async function ask<T>(url: string, init?: RequestInit): Promise<T | null> {
  const got = await asked<T>(url, init)
  return got.ok ? got.body : null
}

const post = <T>(path: string, body: unknown) =>
  ask<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const NO_ANSWER = 'Kehikot did not answer. Nothing was changed.'

export async function fetchAfters(project: number): Promise<Map<string, { said: string; undo: boolean }>> {
  const got = await ask<{ afters?: { module: string; id: string; said: string; undo: boolean }[] }>(`/host/inbox/afters?project=${project}`)
  return new Map((got?.afters ?? []).map((one) => [`${one.module}\u0000${one.id}`, { said: one.said, undo: one.undo }]))
}

/** What to offer for one item; `kehikko` (its key) is the one the person is on, whose agent would do the task. */
export async function fetchAdoption(project: number, key: Key, kehikko: string | null = null): Promise<InboxAdoptionResult> {
  const at = kehikko ? `&kehikko=${encodeURIComponent(kehikko)}` : ''
  const got = await asked<{ adoption?: InboxAdoptionResult }>(
    `/host/inbox/adoption?project=${project}&module=${encodeURIComponent(key.module)}&id=${encodeURIComponent(key.id)}${at}`,
  )
  if (got.ok && got.body.adoption) return got.body.adoption
  return { outcome: 'declined', why: got.ok ? NO_ANSWER : got.why, item: null, epics: [], suggested: null, conversations: [], agent: null, proposal: null }
}

export async function postAdopt(
  project: number,
  key: Key,
  epic: string,
  parts: readonly string[],
  kehikko: string | null,
  task: { module: string; session: string } | null = null,
  also: readonly string[] = [],
  /** The space to adopt into, at any depth, by its path of ids (protocol 2.89.0); its first id is `epic`. */
  space: readonly string[] | null = null,
): Promise<InboxAdoptResult> {
  const got = await post<{ result?: InboxAdoptResult }>('/host/inbox/adopt', { project, ...key, epic, parts, kehikko, task, also, ...(space ? { space } : {}) })
  return got?.result ?? { outcome: 'declined', said: '', brought: [], why: NO_ANSWER }
}

type Done = { outcome: 'done' | 'declined'; changed: number; why: string }

export async function postUntrack(project: number, key: Key): Promise<Done> {
  return (await post<{ result?: Done }>('/host/inbox/untrack', { project, ...key }))?.result ?? { outcome: 'declined', changed: 0, why: NO_ANSWER }
}

export async function postUndo(project: number, key: Key): Promise<Done> {
  return (await post<{ result?: Done }>('/host/inbox/undo', { project, ...key }))?.result ?? { outcome: 'declined', changed: 0, why: NO_ANSWER }
}

export type TaskStarted = { ok: true; module: string; name: string; session: string; pending: boolean } | { ok: false; why: string; noAgent?: true }

/** How the host says a start went (`TaskState` in `server/adoption.ts`). */
type TaskState = { state: 'started'; module: string; name: string; session: string; pending?: boolean } | { state: 'failed'; why: string; noAgent?: true }

/**
 * Start a new session of `agent` (or, null, the kehikko's own agent) on the item, with the host's
 * short prompt (`adoptPrompt`). One call; the answer is the session, or why not in words.
 */
export async function postTask(project: number, key: Key, kehikko: string | null = null, agent: string | null = null): Promise<TaskStarted> {
  const got = await asked<{ result?: TaskState }>('/host/inbox/task', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project, ...key, kehikko, ...(agent ? { agent } : {}) }),
  })
  if (!got.ok) return { ok: false, why: got.why }
  const state = got.body.result
  if (state?.state === 'started') return { ok: true, module: state.module, name: state.name, session: state.session, pending: state.pending === true }
  if (state?.state === 'failed') return { ok: false, why: state.why, ...(state.noAgent ? { noAgent: true as const } : {}) }
  return { ok: false, why: NO_ANSWER }
}

export async function fetchUntracked(project: number): Promise<{ id: string; ref: string; title: string; at: number }[]> {
  return (await ask<{ untracked?: { id: string; ref: string; title: string; at: number }[] }>(`/host/inbox/untracked?project=${project}`))?.untracked ?? []
}

export async function postRetrack(project: number, id: string): Promise<boolean> {
  return (await post<{ ok?: boolean }>('/host/inbox/retrack', { project, id }))?.ok === true
}

