import type { ActivityItem } from 'kehikot-module-protocol'

import { parseMarkdown, plainText, whatsNew, type Block } from './markdown.ts'
import { compareReleases, isRelease, releaseVersion } from './moduleReleases.ts'
import { APP_ITEM, type NewsItem } from './whatsNew.ts'

/**
 * "You're mentioned in What's new": when the notes of a release the person
 * gets thank them by their forge handle ("Thank you, @tp-coder!"), the Inbox
 * says so once, as the host's own item, and pressing it opens What's new at
 * that release with the mention marked.
 *
 * Pure, shared by the page and the server like `inbox.ts`:
 *
 *  - who the person is comes from the server (`server/forgeLogins.ts`), the
 *    login the tracker reads already know, kept machine-wide;
 *  - which releases are looked at is what the page's What's new holds as news
 *    (`releasesToCheck`), plus the app version the desktop app is bringing;
 *  - what was told is the Inbox's own record: one item per release and handle
 *    (`mentionId`), never a second set of its own.
 *
 * The words are the host's; the only names in them come from data — "Kehikot"
 * for the app, a module's registered name.
 */

/** The host's own list these items are filed under; the by-line is `MENTIONS_BY`. */
export const MENTIONS_MODULE = 'kehikko.whatsnew'
export const MENTIONS_BY = 'Kehikot'

const PREFIX = 'mention:'
/** `LIMITS.ACTIVITY_ID`, `ACTIVITY_LABEL`, `ACTIVITY_DETAIL` in the protocol. */
const ID_MAX = 128
const LABEL_MAX = 120
const DETAIL_MAX = 200
/** How many releases one check may name. */
export const RELEASES_MAX = 64

/** One release the person gets: Kehikot's (`APP_ITEM`) or an installed module's, by its tag. */
export interface Release {
  item: string
  tag: string
}

/** A mention found: the line it is on, as plain text, clipped around the handle. */
export interface Mention {
  excerpt: string
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether a login can be one: a forge handle (GitHub's letters, digits and hyphens; GitLab's also `_` and `.`). */
export function isLogin(login: unknown): login is string {
  return typeof login === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,62}[A-Za-z0-9_])?$/.test(login)
}

/**
 * `@login` as a whole handle, any case: not inside an address (`a@login`), not
 * the start of a longer handle (`@login2`, `@login-x`, `@login.x`). A full stop
 * that ends a sentence still ends the handle.
 */
export function mentionPattern(login: string, flags = 'gi'): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_.@/-])@${escape(login)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_])`, flags)
}

/** Whether `text` mentions `login`. */
export function mentions(text: string, login: string): boolean {
  return isLogin(login) && mentionPattern(login, 'i').test(text)
}

/** The lines of a block, as plain text: a list is one line per item. */
function linesOf(block: Block): string[] {
  switch (block.kind) {
    case 'list':
      return block.items.map((item) => plainText(item))
    case 'code':
      return []
    case 'rule':
      return []
    default:
      return [plainText(block.children)]
  }
}

/** A line clipped to `max` around the first mention, an ellipsis where it was cut. */
function around(line: string, login: string, max: number): string {
  const clean = line.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const at = clean.search(mentionPattern(login, 'i'))
  const start = Math.max(0, Math.min(at - Math.floor(max / 3), clean.length - (max - 1)))
  const head = start > 0 ? '…' : ''
  const room = max - head.length - 1
  const body = clean.slice(start, start + room)
  return `${head}${body}${start + room < clean.length ? '…' : ''}`
}

/**
 * Every line of a release's notes that mentions `login`, as What's new shows
 * the notes: the "What's new" section (`whatsNew`), read as Markdown into
 * plain text. A code block is code, not a mention.
 */
export function mentionsIn(body: string, login: string, max = DETAIL_MAX): Mention[] {
  if (!isLogin(login) || !body) return []
  const out: Mention[] = []
  for (const block of parseMarkdown(whatsNew(body))) {
    for (const line of linesOf(block)) if (mentions(line, login)) out.push({ excerpt: around(line, login, max) })
  }
  return out
}

/** The Inbox item's id: one per release and handle. Null when it would not fit. */
export function mentionId(release: Release, login: string): string | null {
  const id = `${PREFIX}${release.item}@${release.tag}:${login.toLowerCase()}`
  return id.length <= ID_MAX ? id : null
}

/** The release and handle an item's id names, or null for any other id. */
export function parseMentionId(id: string): (Release & { login: string }) | null {
  if (!id.startsWith(PREFIX)) return null
  const rest = id.slice(PREFIX.length)
  const colon = rest.lastIndexOf(':')
  const at = rest.lastIndexOf('@', colon)
  if (colon < 0 || at <= 0) return null
  const item = rest.slice(0, at)
  const tag = rest.slice(at + 1, colon)
  const login = rest.slice(colon + 1)
  return item && isRelease(tag) && isLogin(login) ? { item, tag, login } : null
}

/** "Kehikot 0.1.90", "<module's name> 1.6.0". */
export function releaseSaid(name: string, tag: string): string {
  return `${name} ${releaseVersion(tag)}`
}

/**
 * The item: "You're mentioned in What's new: Kehikot 0.1.90", the line it is on
 * as its detail. Finished (`done`), so it is seen when pressed and can be put away.
 */
export function mentionItem(release: Release, login: string, name: string, mention: Mention): ActivityItem | null {
  const id = mentionId(release, login)
  if (!id) return null
  const head = 'You’re mentioned in What’s new: '
  const what = releaseSaid(name, release.tag)
  const label = `${head}${what}`.length <= LABEL_MAX ? `${head}${what}` : `${head}${what.slice(0, LABEL_MAX - head.length - 1)}…`
  return {
    id,
    state: 'done',
    label,
    ...(mention.excerpt ? { detail: mention.excerpt.slice(0, DETAIL_MAX) } : {}),
  }
}

/**
 * The releases the person gets, from What's new's rows: each row that is news
 * (not a "Preparing…" one, not an announcement), every tag it shows; and the
 * app version the desktop app is bringing (`next`), when there is one.
 */
export function releasesToCheck(items: readonly NewsItem[], next: string | null = null): Release[] {
  const out: Release[] = []
  const seen = new Set<string>()
  const add = (item: string, tag: string) => {
    const key = `${item}@${tag}`
    if (seen.has(key) || !isRelease(tag) || out.length >= RELEASES_MAX) return
    seen.add(key)
    out.push({ item, tag })
  }
  if (next && /^v?\d+\.\d+\.\d+$/.test(next)) add(APP_ITEM, `v${next.replace(/^v/, '')}`)
  for (const one of items) {
    if (!one.news || one.preparing || one.kind === 'note') continue
    if (one.kind === 'module' && !one.repo) continue
    for (const tag of one.tags) add(one.id, tag)
  }
  return out
}

/** Where What's new opens for an item: the row, the release, and the handle to mark. */
export interface WhatsNewFocus {
  item: string
  tag: string
  login: string
}

/** A row's tags with `tag` among them, newest first: the release an item names is always shown. */
export function withTag(tags: readonly string[], tag: string): string[] {
  if (tags.includes(tag) || !isRelease(tag)) return [...tags]
  return [...tags, tag].sort((a, b) => (isRelease(a) && isRelease(b) ? compareReleases(b, a) : 0))
}

/** The plain-text pieces of `text`, each marked when it is a mention of `login`. For drawing only, never markup. */
export function markedPieces(text: string, login: string | null | undefined): { text: string; mark: boolean }[] {
  if (!login || !isLogin(login)) return [{ text, mark: false }]
  const out: { text: string; mark: boolean }[] = []
  let last = 0
  for (const found of text.matchAll(mentionPattern(login))) {
    const at = found.index ?? 0
    if (at > last) out.push({ text: text.slice(last, at), mark: false })
    out.push({ text: found[0], mark: true })
    last = at + found[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), mark: false })
  return out.length ? out : [{ text, mark: false }]
}

/* ---- the page's side ---- */

/** Ask the host to look at these releases' notes for the person's handle. Never throws. */
export async function postMentions(project: number, releases: readonly Release[]): Promise<{ told: number } | null> {
  if (!releases.length) return null
  try {
    const response = await fetch('/host/whats-new/mentions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project, releases }),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { told?: unknown }
    return { told: typeof body.told === 'number' ? body.told : 0 }
  } catch {
    return null
  }
}
