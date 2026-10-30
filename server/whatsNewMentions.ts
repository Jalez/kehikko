import type { ActivityItem } from 'kehikot-module-protocol'

import { isDismissed, isOpen, isSeen, type Entry } from '../src/host/inbox.ts'
import { isRelease } from '../src/host/moduleReleases.ts'
import {
  MENTIONS_BY,
  MENTIONS_MODULE,
  RELEASES_MAX,
  mentionId,
  mentionItem,
  mentionsIn,
  type Release,
} from '../src/host/whatsNewMentions.ts'
import type { Inbox } from './inbox.ts'

/**
 * "You're mentioned in What's new", kept (`src/host/whatsNewMentions.ts` has the
 * rules and the words).
 *
 * The page names the releases the person gets (`POST /host/whats-new/mentions`,
 * in `PAGE_ONLY`); this resolves each to a repository the host knows — the
 * app's own, or an installed module's release repository, never one the page
 * names — reads its notes through the release-notes desk (whose cache the
 * dialog reads too), and looks for the person's login on GitHub.
 *
 * What was told is the Inbox's record: an item per release and handle under
 * `MENTIONS_MODULE`, in any project, is never told again — whether it is still
 * open, seen, dismissed or closed. A release already told is not read at all.
 * The host's list in a project is what is still open and not put away, plus
 * what is new; what was put away closes and stays in the log.
 */
export interface MentionsDeps {
  inbox: Pick<Inbox, 'report' | 'all' | 'holds'>
  /** The person's login on github.com, held or asked once (`ForgeLogins.login`). Null when not known. */
  login(): Promise<string | null>
  /** The repository and name of a release's row: Kehikot's own (`APP_ITEM`), or an installed module's. Null when it has none. */
  resolve(item: string): Promise<{ repo: string; name: string } | null>
  /** A release's notes as GitHub has them, or null when they could not be read. */
  notes(repo: string, tag: string): Promise<string | null>
}

/** The releases a request names, kept to what can be one. */
export function releasesIn(raw: unknown): Release[] | null {
  if (!Array.isArray(raw) || raw.length > RELEASES_MAX) return null
  const out: Release[] = []
  for (const one of raw) {
    if (!one || typeof one !== 'object') return null
    const { item, tag } = one as Record<string, unknown>
    if (typeof item !== 'string' || !item || item.length > 200 || typeof tag !== 'string' || !isRelease(tag)) return null
    out.push({ item, tag })
  }
  return out
}

/** An open entry as the item it was: what the host's list says again. */
function itemOf(entry: Entry): ActivityItem {
  return { id: entry.id, state: entry.state, label: entry.label, ...(entry.detail ? { detail: entry.detail } : {}) }
}

export function mentionsDesk(deps: MentionsDeps) {
  /**
   * Look at these releases' notes for the person's handle, and tell the Inbox
   * of `project` about each one not told before. Answers how many were told
   * and the Inbox's rev when it changed.
   */
  async function check(project: number, releases: readonly Release[]): Promise<{ told: number; rev: number | null }> {
    if (!releases.length) return { told: 0, rev: null }
    const login = await deps.login()
    if (!login) return { told: 0, rev: null }
    const fresh: ActivityItem[] = []
    for (const release of releases) {
      const id = mentionId(release, login)
      if (!id || deps.inbox.holds(MENTIONS_MODULE, id)) continue
      const row = await deps.resolve(release.item)
      if (!row) continue
      const body = await deps.notes(row.repo, release.tag).catch(() => null)
      if (!body) continue
      const found = mentionsIn(body, login)
      if (!found.length) continue
      const item = mentionItem(release, login, row.name, found[0]!)
      if (item && !fresh.some((one) => one.id === item.id)) fresh.push(item)
    }
    if (!fresh.length) return { told: 0, rev: null }
    const kept = deps.inbox
      .all(project)
      .filter((one) => one.module === MENTIONS_MODULE && isOpen(one) && !isSeen(one) && !isDismissed(one))
      .map(itemOf)
    const out = deps.inbox.report(project, MENTIONS_MODULE, MENTIONS_BY, [...kept, ...fresh])
    return { told: fresh.length, rev: out.rev }
  }

  return { check }
}

export type MentionsDesk = ReturnType<typeof mentionsDesk>
