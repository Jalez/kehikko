import { z } from 'zod'

import { compareReleases, isRelease, releasesNewestFirst, releaseVersion, type Follows } from './moduleReleases.ts'
import { compareVersions } from './worksWith.ts'

/**
 * "What's new" after an update: Kehikot and every module, in one dialog.
 *
 * ## What is remembered
 *
 * Machine level, one row of `settings` in `frame.sqlite` (`server/whatsNew.ts`):
 * the app version and each installed module's position (the release its copy
 * is on, or the commit of a copy that follows `main`) the person last
 * ACKNOWLEDGED, and whether they want the dialog after updates at all. Never
 * in browser storage, never in a project.
 *
 * ## What counts as new
 *
 * The app's version newer than the acknowledged one; a module on a newer
 * release than the acknowledged one; a module following `main` on another
 * commit. A module the record does not name yet (installed since) and the
 * very first run (no record at all — the introduction has the floor then) are
 * recorded as they are, silently: `baselined`.
 *
 * ## When it opens
 *
 * Never over anything: after Settings' one-time question and the introduction
 * (`firstRunSettled`), and only at a quiet moment (`whenQuiet`) — no dialog,
 * popover, menu or tour standing, nobody typing in the page or in a module's
 * frame, no update batch running in the Updates menu, and `QUIET_MS` of that.
 * Updates that land meanwhile are gathered into the one dialog; one landing
 * while it stands adds to its list. A module still updating (the server's
 * `updating`) or whose update failed is left out.
 *
 * This file is pure apart from the page's requests and the quiet gate at the
 * bottom; the server uses the record rules too.
 */

export const APP_ITEM = 'kehikot'

export const positionSchema = z.object({
  /** The release tag the copy is on (`v1.6.0`), or null when it is on `main`. */
  release: z.string().max(64).nullable(),
  /** The commit, for a copy that follows `main`; null when not known. */
  commit: z.string().max(64).nullable(),
})
export type Position = z.infer<typeof positionSchema>

export const recordSchema = z.object({
  /** The app version last acknowledged, or null when no app has been seen (a browser tab). */
  app: z.string().max(64).nullable().catch(null).default(null),
  modules: z.record(z.string(), positionSchema).catch({}).default({}),
  /** "Show What's new after updates". */
  show: z.boolean().catch(true).default(true),
})
export type WhatsNewRecord = z.infer<typeof recordSchema>

/** One installed module as the server reads it for "What's new". */
export interface InstalledModule {
  id: string
  name: string
  /** `owner/repo` on GitHub, where its release notes are; null elsewhere. */
  repo: string | null
  follows: Follows
  position: Position
  /** The releases since the acknowledged one up to the installed one, newest first; empty when none. */
  range: string[]
  /** "Works with Kehikot 0.1.39 and later", by tag, for `range` and the installed release. */
  works: Record<string, string>
}

/** What `GET /host/whats-new` answers. */
export interface WhatsNewAnswer {
  /** Null on the very first run: nothing has been recorded yet. */
  record: WhatsNewRecord | null
  modules: InstalledModule[]
  /** Modules an update is running on right now: not shown until it has finished. */
  updating: string[]
}

export const editSchema = z.union([
  z.object({ baseline: z.object({ app: z.string().max(64).nullable() }).strict() }).strict(),
  z
    .object({
      acknowledge: z
        .object({ app: z.string().max(64).optional(), modules: z.record(z.string().max(200), positionSchema).optional() })
        .strict(),
    })
    .strict(),
  z.object({ read: z.object({ module: z.string().max(200), from: z.string().max(64).nullable(), to: z.string().max(64) }).strict() }).strict(),
  z.object({ show: z.boolean() }).strict(),
])
export type WhatsNewEdit = z.infer<typeof editSchema>

/** The later of two app versions, either of which may be missing. */
function laterApp(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null
  if (!b) return a
  return compareVersions(b, a) > 0 ? b : a
}

/** A position moved to `next`, never back to an older release. */
function forward(was: Position | undefined, next: Position): Position {
  if (!was) return next
  if (was.release && next.release && compareReleases(next.release, was.release) < 0) return was
  if (was.release && !next.release) return { release: was.release, commit: next.commit }
  return next
}

/**
 * The record with whatever it does not know yet set to what is here now: the
 * whole of it on the very first run, then the app the first time one is seen
 * and each module the first time it is installed. Nothing it knows is moved.
 */
export function baselined(record: WhatsNewRecord | null, app: string | null, here: Readonly<Record<string, Position>>): WhatsNewRecord {
  if (!record) return { app, modules: { ...here }, show: true }
  const modules = { ...record.modules }
  for (const [id, position] of Object.entries(here)) if (!Object.hasOwn(modules, id)) modules[id] = position
  return { ...record, app: record.app ?? app, modules }
}

/** What was shown, acknowledged: never moving anything backwards. */
export function acknowledged(record: WhatsNewRecord, ack: { app?: string; modules?: Readonly<Record<string, Position>> }): WhatsNewRecord {
  const modules = { ...record.modules }
  for (const [id, position] of Object.entries(ack.modules ?? {})) modules[id] = forward(modules[id], position)
  return { ...record, app: ack.app ? laterApp(record.app, ack.app) : record.app, modules }
}

/**
 * The person read a module's notes in the Updates menu, from the release after
 * `from` up to `to`. When that covers everything since the acknowledged
 * release, those releases count as acknowledged: the module is left out of the
 * next "What's new" for them. A gap (an earlier update not acknowledged yet)
 * leaves the record as it is, so the dialog still shows the whole range.
 */
export function afterRead(record: WhatsNewRecord, module: string, from: string | null, to: string): WhatsNewRecord {
  if (!isRelease(to)) return record
  const was = record.modules[module]
  if (!was) return record
  const covers = was.release === null ? from === null : from === null || compareReleases(was.release, from) >= 0
  if (!covers) return record
  if (was.release && compareReleases(to, was.release) <= 0) return record
  return { ...record, modules: { ...record.modules, [module]: { release: to, commit: null } } }
}

/** The releases after the acknowledged one up to the installed one, newest first. */
export function rangeFor(ack: Position | undefined, position: Position, local: readonly string[]): string[] {
  if (!position.release || !isRelease(position.release)) return []
  if (!ack) return []
  if (!ack.release) return [position.release]
  if (compareReleases(position.release, ack.release) <= 0) return []
  return releasesNewestFirst([...local, position.release]).filter(
    (tag) => compareReleases(tag, position.release!) <= 0 && compareReleases(tag, ack.release!) > 0,
  )
}

/** Whether a module moved since it was acknowledged. */
export function moved(ack: Position | undefined, position: Position): boolean {
  if (!ack) return false
  if (position.release) return !ack.release || compareReleases(position.release, ack.release) > 0
  /* On main: another commit is news; leaving a release for main is not a release to tell of. */
  return ack.release === null && !!position.commit && !!ack.commit && position.commit !== ack.commit
}

/** One row of the dialog: Kehikot, or one module. */
export interface NewsItem {
  id: string
  kind: 'app' | 'module'
  name: string
  repo: string | null
  /** "0.1.41", "1.5.0", "main"; null when not known (shown on demand). */
  from: string | null
  /** "0.1.43", "1.6.0", or "main". */
  to: string
  /** The releases whose notes are shown, newest first; empty for a copy following main. */
  tags: string[]
  follows: Follows | 'app'
  /** "Works with Kehikot …" by tag. */
  works: Record<string, string>
  /** What "Got it" records for it. */
  ack: { app: string } | { module: Position }
  /** Whether this is news, rather than what is installed shown on demand. */
  news: boolean
}

/** "1.5.0 → 1.6.0", "0.1.43", "following main". */
export function rangeSaid(item: Pick<NewsItem, 'from' | 'to'>): string {
  return item.from && item.from !== item.to ? `${item.from} → ${item.to}` : item.to
}

/** "2 releases", "1 release", or null when there are none to count. */
export function releasesSaid(count: number): string | null {
  if (count <= 0) return null
  return count === 1 ? '1 release' : `${count} releases`
}

export const FOLLOWING_MAIN = 'following main · no release notes'

/** The app's releases after `from` up to `to`, newest first, from GitHub's list; null when the list is not known. */
export function appRange(listed: readonly string[] | null, from: string | null, to: string): string[] | null {
  if (!listed) return null
  return [...new Set(listed)]
    .filter((tag) => /^v?\d+\.\d+\.\d+$/.test(tag))
    .filter((tag) => {
      const v = tag.replace(/^v/i, '')
      return compareVersions(v, to) <= 0 && (from === null || compareVersions(v, from) > 0)
    })
    .sort((a, b) => compareVersions(b.replace(/^v/i, ''), a.replace(/^v/i, '')))
}

const short = (commit: string | null) => (commit ? commit.slice(0, 7) : 'main')

/**
 * The rows of the dialog. With `all` (opened on demand) every installed module
 * is listed, news first; otherwise only what is news. `appTags` is the app's
 * range when its release list could be read, null when it could not (offline):
 * then the row still says its versions and the pane says why there are no notes.
 */
export function newsItems(input: {
  answer: WhatsNewAnswer
  /** The running app's version, inside the desktop app; null elsewhere. */
  app: string | null
  appTags: string[] | null
  /** Modules whose update failed this session: never shown as news. */
  failed?: ReadonlySet<string>
  all?: boolean
}): NewsItem[] {
  const { answer, app } = input
  const record = answer.record
  const failed = input.failed ?? new Set<string>()
  const updating = new Set(answer.updating)
  const items: NewsItem[] = []
  if (app && record) {
    const news = !!record.app && compareVersions(app, record.app) > 0
    if (news || input.all) {
      const tag = `v${app.replace(/^v/i, '')}`
      items.push({
        id: APP_ITEM,
        kind: 'app',
        name: 'Kehikot',
        repo: null,
        from: news ? record.app : null,
        to: app,
        tags: input.appTags && input.appTags.length ? input.appTags : [tag],
        follows: 'app',
        works: {},
        ack: { app },
        news,
      })
    }
  }
  const later: NewsItem[] = []
  for (const one of answer.modules) {
    if (updating.has(one.id)) continue
    const ack = record?.modules[one.id]
    const news = !!record && !failed.has(one.id) && moved(ack, one.position)
    if (!news && !input.all) continue
    const onMain = !one.position.release
    const tags = onMain ? [] : news && one.range.length ? one.range : [one.position.release!]
    const item: NewsItem = {
      id: one.id,
      kind: 'module',
      name: one.name,
      repo: one.repo,
      from: news ? (onMain ? short(ack?.commit ?? null) : ack?.release ? releaseVersion(ack.release) : 'main') : null,
      to: onMain ? short(one.position.commit) : releaseVersion(one.position.release!),
      tags,
      follows: one.follows,
      works: one.works,
      ack: { module: one.position },
      news,
    }
    ;(news ? items : later).push(item)
  }
  return [...items, ...later.sort((a, b) => a.name.localeCompare(b.name))]
}

/** Items merged into what the dialog already shows: a row updated in place, a new one added at the end. */
export function mergeItems(shown: readonly NewsItem[], next: readonly NewsItem[]): NewsItem[] {
  const byId = new Map(next.map((one) => [one.id, one]))
  const merged = shown.map((one) => {
    const fresh = byId.get(one.id)
    if (!fresh) return one
    /* A later release of the same module: the range grows from where it started. */
    return { ...fresh, from: one.from ?? fresh.from, tags: [...new Set([...fresh.tags, ...one.tags])].sort((a, b) => (isRelease(a) && isRelease(b) ? compareReleases(b, a) : 0)), news: one.news || fresh.news }
  })
  for (const one of next) if (!shown.some((was) => was.id === one.id)) merged.push(one)
  return merged
}

/** "0.1.41 → 0.1.43" for the header, from Kehikot's row; else how many modules. */
export function headerSaid(items: readonly NewsItem[]): string {
  const app = items.find((one) => one.kind === 'app')
  const modules = items.filter((one) => one.kind === 'module' && one.news).length
  const parts: string[] = []
  if (app) parts.push(app.from ? `${app.from} → ${app.to}` : app.to)
  if (modules) parts.push(`${modules} module${modules === 1 ? '' : 's'} updated`)
  if (!parts.length) parts.push('Kehikot and your modules, as installed')
  return parts.join(' · ')
}

/** What "Got it" sends: every row shown. */
export function ackFor(items: readonly NewsItem[]): { app?: string; modules?: Record<string, Position> } {
  const ack: { app?: string; modules?: Record<string, Position> } = {}
  for (const one of items) {
    if ('app' in one.ack) ack.app = one.ack.app
    else (ack.modules ??= {})[one.id] = one.ack.module
  }
  return ack
}

/* ---- the page's side ---- */

export async function fetchWhatsNew(signal?: AbortSignal): Promise<WhatsNewAnswer | null> {
  try {
    const response = await fetch('/host/whats-new', { signal, cache: 'no-store' })
    /* An older host has no such route: nothing is shown by itself. */
    if (!response.ok) return null
    const body = (await response.json()) as WhatsNewAnswer
    return { record: body.record ? recordSchema.parse(body.record) : null, modules: body.modules ?? [], updating: body.updating ?? [] }
  } catch {
    return null
  }
}

/** The setting alone: true unless the person turned it off. */
export async function fetchShowSetting(signal?: AbortSignal): Promise<boolean | null> {
  try {
    const response = await fetch('/host/whats-new?only=record', { signal, cache: 'no-store' })
    if (!response.ok) return null
    const body = (await response.json()) as { record?: unknown }
    return body.record ? recordSchema.parse(body.record).show : true
  } catch {
    return null
  }
}

export async function postWhatsNew(edit: WhatsNewEdit): Promise<WhatsNewRecord | null> {
  try {
    const response = await fetch('/host/whats-new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(edit),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { record?: unknown }
    return body.record ? recordSchema.parse(body.record) : null
  } catch {
    return null
  }
}

const OPEN_WHATS_NEW = 'kehikot:open-whats-new'
const POKE = 'kehikot:whats-new-poke'
const SHOW_CHANGED = 'kehikot:whats-new-show'

/** Open "What's new" now, on demand: About, the Updates menu. */
export function openWhatsNew(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_WHATS_NEW))
}

export function onOpenWhatsNew(then: () => void): () => void {
  window.addEventListener(OPEN_WHATS_NEW, then)
  return () => window.removeEventListener(OPEN_WHATS_NEW, then)
}

export type Poke = { updated: string } | { failed: string }

/** The Updates menu: a module's update landed, or failed. */
export function pokeWhatsNew(poke: Poke): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(POKE, { detail: poke }))
}

export function onPoke(then: (poke: Poke) => void): () => void {
  const listener = (event: Event) => then((event as CustomEvent).detail as Poke)
  window.addEventListener(POKE, listener)
  return () => window.removeEventListener(POKE, listener)
}

/** The setting changed (Settings' switch, the dialog's checkbox): whoever shows it reads it again. */
export function announceShow(show: boolean): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SHOW_CHANGED, { detail: show }))
}

export function onShowChanged(then: (show: boolean) => void): () => void {
  const listener = (event: Event) => then((event as CustomEvent).detail === true)
  window.addEventListener(SHOW_CHANGED, listener)
  return () => window.removeEventListener(SHOW_CHANGED, listener)
}

/** The Updates menu's notes for a module were read: `from` the installed release, `to` the newest shown. */
export function readInUpdates(module: string, from: string | null, to: string): void {
  void postWhatsNew({ read: { module, from, to } })
}

/* An "Update all" in the Updates menu: while one runs, nothing opens. */
let batches = 0
export function updatesRunning(on: boolean): void {
  batches = Math.max(0, batches + (on ? 1 : -1))
}
export function updatesBusy(): boolean {
  return batches > 0
}

/* ---- a quiet moment ---- */

/** How long the page has to be quiet — nothing open, nobody typing — before "What's new" opens. */
export const QUIET_MS = 1500

const STANDING = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .driver-popover'

/** Why now is not a moment to open a dialog, or null when it is. */
export function notQuiet(root: Document = document): string | null {
  if (updatesBusy()) return 'updating'
  if (root.querySelector(STANDING)) return 'open'
  if (root.body?.classList.contains('driver-active')) return 'tour'
  const active = root.activeElement as HTMLElement | null
  const focused = typeof root.hasFocus === 'function' ? root.hasFocus() : true
  if (focused && active && active !== root.body) {
    const tag = active.tagName
    if (tag === 'IFRAME' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable) return 'typing'
  }
  return null
}

/**
 * Call `then` once the page has been quiet for `idleMs`: nothing standing, no
 * focus in a field or a module's frame, no update batch running, and no key or
 * press in that time. Returns the cancel.
 */
export function whenQuiet(then: () => void, { idleMs = QUIET_MS, everyMs = 250, root = document }: { idleMs?: number; everyMs?: number; root?: Document } = {}): () => void {
  let since: number | null = null
  let lastInput = 0
  const input = () => {
    lastInput = Date.now()
    since = null
  }
  const view = root.defaultView ?? window
  view.addEventListener('keydown', input, true)
  view.addEventListener('pointerdown', input, true)
  const stop = () => {
    clearInterval(timer)
    view.removeEventListener('keydown', input, true)
    view.removeEventListener('pointerdown', input, true)
  }
  const look = () => {
    const now = Date.now()
    if (notQuiet(root) !== null || now - lastInput < idleMs) {
      since = null
      return
    }
    since ??= now
    if (now - since >= idleMs) {
      stop()
      then()
    }
  }
  const timer = setInterval(look, everyMs)
  look()
  return stop
}

/** Has Settings' one-time question been answered? True when it cannot be told. */
async function settingsAsked(): Promise<boolean> {
  try {
    const response = await fetch('/host/settings', { cache: 'no-store' })
    if (!response.ok) return true
    const body = (await response.json()) as { settings?: { asked?: unknown } } | null
    return body?.settings?.asked !== false
  } catch {
    return true
  }
}

/**
 * Resolves once the first-run windows are done with: Settings' one-time
 * question answered (or shown and closed this session) and the introduction
 * seen. Asked again every `everyMs` while either stands; `introDue` is the
 * onboarding module's own rule.
 */
export function firstRunSettled(
  deps: { introDue(): Promise<boolean>; asked?: () => Promise<boolean>; everyMs?: number; root?: Document },
  signal?: AbortSignal,
): Promise<void> {
  const root = deps.root ?? document
  const asked = deps.asked ?? settingsAsked
  const everyMs = deps.everyMs ?? 1500
  let questionSeen = false
  return new Promise((resolve) => {
    const look = async () => {
      if (signal?.aborted) return
      if (root.querySelector('[data-first-question]')) questionSeen = true
      const questionDone = !root.querySelector('[data-first-question]') && (questionSeen || (await asked()))
      const introDone = questionDone && !(await deps.introDue())
      if (signal?.aborted) return
      if (questionDone && introDone) resolve()
      else setTimeout(() => void look(), everyMs)
    }
    void look()
  })
}
