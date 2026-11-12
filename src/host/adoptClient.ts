import type { InboxAdoptResult, InboxAdoptionResult } from 'kehikot-module-protocol'

/**
 * The page's side of adopting a tracker item no epic names (protocol 2.88.0): the server's routes
 * (`server/adoptRoutes.ts`), every one the page's alone. The person's press is checked before any of
 * these is called (`answerInbox`, and the dialog's own buttons).
 */

type Key = { module: string; id: string }

async function ask<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(url, init)
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
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
  const got = await ask<{ adoption?: InboxAdoptionResult }>(`/host/inbox/adoption?project=${project}&module=${encodeURIComponent(key.module)}&id=${encodeURIComponent(key.id)}${at}`)
  return got?.adoption ?? { outcome: 'declined', why: NO_ANSWER, item: null, epics: [], suggested: null, conversations: [], agent: null, proposal: null }
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

/** Start the agent of kehikko `kehikko` (its primary, or its only one) on the item. */
export async function postTask(project: number, key: Key, kehikko: string | null = null): Promise<TaskStarted> {
  return (await post<{ result?: TaskStarted }>('/host/inbox/task', { project, ...key, kehikko }))?.result ?? { ok: false, why: NO_ANSWER }
}

export async function fetchUntracked(project: number): Promise<{ id: string; ref: string; title: string; at: number }[]> {
  return (await ask<{ untracked?: { id: string; ref: string; title: string; at: number }[] }>(`/host/inbox/untracked?project=${project}`))?.untracked ?? []
}

export async function postRetrack(project: number, id: string): Promise<boolean> {
  return (await post<{ ok?: boolean }>('/host/inbox/retrack', { project, id }))?.ok === true
}

