import type { ActivityItem } from 'kehikot-module-protocol'

import { hostRead } from './hostRead.ts'
import type { Entry, LogRow, NoticeLine, Scope } from './inbox.ts'
import type { NoticeLink } from './trackerNotices.ts'

/**
 * The page's side of the Inbox routes (`server/inboxRoutes.ts`). Every call
 * answers `null` when the server could not be reached or refused: the page
 * keeps what it has, and the next wake or reopening of the stream reads again.
 */

export interface Snapshot {
  rev: number
  open: Entry[]
  earlier: number
  /** The modules "Use inbox" is off for, machine-wide, when the answer said (`inboxUse.ts`). */
  muted?: string[]
}

/** The muted list of an answer, when it carried one. */
const mutedOf = (got: { muted?: unknown } | null): { muted?: string[] } =>
  got && Array.isArray(got.muted) ? { muted: got.muted.filter((one): one is string => typeof one === 'string') } : {}

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
  return got && Array.isArray(got.open) ? { rev: got.rev, open: got.open, earlier: got.earlier ?? 0, ...mutedOf(got) } : null
}

/**
 * The person's "Use inbox" switch for one module (`POST /host/inbox/use`, the page's alone).
 * Answers the muted list after it, or null when it was not taken.
 */
export async function postUse(module: string, use: boolean): Promise<string[] | null> {
  const got = (await post('/host/inbox/use', { module, use })) as { ok?: boolean; muted?: unknown } | null
  return got && got.ok ? (mutedOf(got).muted ?? []) : null
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

/** Where one of the host's own items points (a tracker notice's ref and page), or null. */
export async function fetchLink(project: number, module: string, id: string): Promise<NoticeLink | null> {
  const got = await ask<{ link: NoticeLink | null }>(
    `/host/inbox/link?project=${project}&module=${encodeURIComponent(module)}&id=${encodeURIComponent(id)}`,
  )
  const link = got?.link
  return link && typeof link.url === 'string' && typeof link.ref === 'string' ? link : null
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

/** `took`: the person went where an agent's offer goes, and it closes as taken (the host's own act; no module asks it). */
export type Act = 'seen' | 'dismiss' | 'forget' | 'seen-all' | 'took'

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
    ? { rev: got.rev, open: got.open, earlier: got.earlier ?? 0, changed: got.changed ?? 0, ...mutedOf(got) }
    : null
}

export async function postMigrate(project: number, seen: object, told: object): Promise<Snapshot | null> {
  const got = (await post('/host/inbox/migrate', { project, seen, told })) as (Snapshot & { ok?: boolean }) | null
  return got && got.ok && Array.isArray(got.open) ? { rev: got.rev, open: got.open, earlier: got.earlier ?? 0, ...mutedOf(got) } : null
}

/** What the person said to an entry's question: one of its choices (by index), or words of their own. */
export type Said = { choice: number; answer?: string } | { answer: string; choice?: undefined }

/**
 * The person's answer to an entry's question (`POST /host/inbox/answer`, the page's alone, protocol
 * 2.55.0). `pressed` is the page's word that it came on their fresh press (`pressFresh`); the server
 * refuses without it. Answers the record after it, or why it was not sent.
 */
export async function postAnswer(body: {
  project: number
  module: string
  item: string
  said: Said
  pressed: true
}): Promise<{ ok: true; snapshot: Snapshot } | { ok: false; why: string }> {
  const { said, ...rest } = body
  try {
    const response = await fetch('/host/inbox/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...rest, ...said }),
    })
    const got = (await response.json().catch(() => null)) as (Snapshot & { ok?: boolean; why?: unknown }) | null
    if (got && got.ok && Array.isArray(got.open)) {
      return { ok: true, snapshot: { rev: got.rev, open: got.open, earlier: got.earlier ?? 0, ...mutedOf(got) } }
    }
    return { ok: false, why: typeof got?.why === 'string' ? got.why : 'The answer was not sent.' }
  } catch {
    return { ok: false, why: 'Kehikot could not be reached, so the answer was not sent. Try again in a moment.' }
  }
}
