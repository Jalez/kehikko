import type { ActivityItem } from 'kehikot-module-protocol'

import { hostRead } from './hostRead.ts'
import type { Entry, LogRow, NoticeLine, Scope } from './inbox.ts'

/**
 * The page's side of the Inbox routes (`server/inboxRoutes.ts`). Every call
 * answers `null` when the server could not be reached or refused: the page
 * keeps what it has, and the next wake or reopening of the stream reads again.
 */

export interface Snapshot {
  rev: number
  open: Entry[]
  earlier: number
}

export interface Narrowing {
  scope: Scope
  epic: string | null
  kehikko: string | null
}

async function ask<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(url, init)
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}

const post = (path: string, body: unknown) =>
  ask<Record<string, unknown>>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const query = (narrowing: Narrowing | null): string =>
  narrowing && narrowing.scope === 'here'
    ? `&scope=here${narrowing.epic ? `&epic=${encodeURIComponent(narrowing.epic)}` : ''}${narrowing.kehikko ? `&kehikko=${encodeURIComponent(narrowing.kehikko)}` : ''}`
    : '&scope=everywhere'

/**
 * One project's record. `join`: a read of it already out will do (the reads at load, which
 * StrictMode makes twice in development); without, it is read now — news said it changed.
 * Nothing is kept.
 */
export async function fetchInbox(project: number, { join = false }: { join?: boolean } = {}): Promise<Snapshot | null> {
  const got = await hostRead(`inbox:${project}`, () => ask<Snapshot & { ok: boolean }>(`/host/inbox?project=${project}`), { keep: false, fresh: !join })
  return got && Array.isArray(got.open) ? { rev: got.rev, open: got.open, earlier: got.earlier ?? 0 } : null
}

export async function fetchLog(
  project: number,
  narrowing: Narrowing | null,
  offset: number,
  limit: number,
): Promise<{ rows: LogRow[]; more: boolean; total: number } | null> {
  const got = await ask<{ rows: LogRow[]; more: boolean; total: number }>(
    `/host/inbox/log?project=${project}&offset=${offset}&limit=${limit}${query(narrowing)}`,
  )
  return got && Array.isArray(got.rows) ? got : null
}

export async function postReport(body: {
  project: number
  module: string
  name: string
  items: readonly ActivityItem[]
  silent?: boolean
  /** The module's new page did not say its list again in its grace. */
  unreported?: boolean
  loadedAt: number
}): Promise<(Snapshot & { news: Entry[] }) | null> {
  const got = (await post('/host/inbox/report', body)) as (Snapshot & { news?: Entry[]; ok?: boolean }) | null
  return got && got.ok && Array.isArray(got.open)
    ? { rev: got.rev, open: got.open, earlier: got.earlier ?? 0, news: got.news ?? [] }
    : null
}

export async function postNotice(body: {
  project: number
  module: string
  name: string
  line: NoticeLine
  kehikko?: string
}): Promise<Snapshot | null> {
  const got = (await post('/host/inbox/notice', body)) as (Snapshot & { ok?: boolean }) | null
  return got && got.ok && Array.isArray(got.open) ? { rev: got.rev, open: got.open, earlier: got.earlier ?? 0 } : null
}

export type Act = 'seen' | 'dismiss' | 'forget' | 'seen-all'

export async function postAct(body: {
  project: number
  do: Act
  keys?: readonly { module: string; id: string }[]
  narrowing?: Narrowing | null
}): Promise<(Snapshot & { changed: number }) | null> {
  const { narrowing, ...rest } = body
  const scope = narrowing && narrowing.scope === 'here'
    ? { scope: 'here', epic: narrowing.epic, kehikko: narrowing.kehikko }
    : {}
  const got = (await post('/host/inbox/act', { ...rest, ...scope })) as (Snapshot & { changed?: number; ok?: boolean }) | null
  return got && got.ok && Array.isArray(got.open)
    ? { rev: got.rev, open: got.open, earlier: got.earlier ?? 0, changed: got.changed ?? 0 }
    : null
}

export async function postMigrate(project: number, seen: object, told: object): Promise<Snapshot | null> {
  const got = (await post('/host/inbox/migrate', { project, seen, told })) as (Snapshot & { ok?: boolean }) | null
  return got && got.ok && Array.isArray(got.open) ? { rev: got.rev, open: got.open, earlier: got.earlier ?? 0 } : null
}
