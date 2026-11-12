import type { InboxAdoptResult, InboxAdoptionResult } from 'kehikot-module-protocol'

/**
 * The page's side of adopting a tracker item no epic names (protocol 2.88.0): the server's routes
 * (`server/adoptRoutes.ts`), every one the page's alone. The person's press is checked before any of
 * these is called (`answerInbox`, and the dialog's own buttons).
 */

type Key = { module: string; id: string }

/**
 * How long the page waits for one of these routes. None of them waits on a module for longer than a
 * few seconds (`ADOPTION_LIMITS` in `server/adoption.ts`), and a module's page that asked through the
 * host gives up after 12 s, so the page gives up before that and says why.
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
export async function fetchAdoption(project: number, key: Key, kehikko: string | null = null): Promise<InboxAdoptionResult & { finding?: boolean }> {
  const at = kehikko ? `&kehikko=${encodeURIComponent(kehikko)}` : ''
  const got = await asked<{ adoption?: InboxAdoptionResult; finding?: boolean }>(
    `/host/inbox/adoption?project=${project}&module=${encodeURIComponent(key.module)}&id=${encodeURIComponent(key.id)}${at}`,
  )
  if (got.ok && got.body.adoption) return { ...got.body.adoption, ...(got.body.finding ? { finding: true } : {}) }
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

export type TaskStarted = { ok: true; module: string; name: string; session: string; view: string } | { ok: false; why: string; noAgent?: true }

/** How the host says a start stands (`TaskState` in `server/adoption.ts`). */
type TaskState =
  | { state: 'starting'; module: string; name: string }
  | { state: 'started'; module: string; name: string; session: string; view: string }
  | { state: 'failed'; why: string; noAgent?: true }

/** How long the page reads a start that is under way before saying the agent did not say. */
export const TASK_WITHIN_MS = 45_000

/**
 * Start the agent of kehikko `kehikko` (its primary, or its only one) on the item. The host answers
 * at once and starts it in the background; this reads how it went every `everyMs` until it started
 * or failed, and says why in words when it did not.
 */
export async function postTask(project: number, key: Key, kehikko: string | null = null, everyMs = 1000, withinMs = TASK_WITHIN_MS): Promise<TaskStarted> {
  const begun = await asked<{ result?: TaskState }>('/host/inbox/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, ...key, kehikko }) })
  if (!begun.ok) return { ok: false, why: begun.why }
  let state = begun.body.result ?? null
  const until = Date.now() + withinMs
  const name = state && 'name' in state ? state.name : 'The agent'
  while (state?.state === 'starting' && Date.now() < until) {
    await new Promise((done) => setTimeout(done, everyMs))
    const read = await asked<{ result?: TaskState | null }>(`/host/inbox/task?project=${project}&module=${encodeURIComponent(key.module)}&id=${encodeURIComponent(key.id)}`)
    if (read.ok && read.body.result) state = read.body.result
  }
  if (!state) return { ok: false, why: NO_ANSWER }
  if (state.state === 'started') return { ok: true, module: state.module, name: state.name, session: state.session, view: state.view }
  if (state.state === 'failed') return { ok: false, why: state.why, ...(state.noAgent ? { noAgent: true as const } : {}) }
  return { ok: false, why: `${name} didn’t say it started the task within ${Math.round(withinMs / 1000)} s.` }
}

export async function fetchUntracked(project: number): Promise<{ id: string; ref: string; title: string; at: number }[]> {
  return (await ask<{ untracked?: { id: string; ref: string; title: string; at: number }[] }>(`/host/inbox/untracked?project=${project}`))?.untracked ?? []
}

export async function postRetrack(project: number, id: string): Promise<boolean> {
  return (await post<{ ok?: boolean }>('/host/inbox/retrack', { project, id }))?.ok === true
}

