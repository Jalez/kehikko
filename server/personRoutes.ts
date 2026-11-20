import type { Database } from 'bun:sqlite'
import type { ModuleRelease } from '../src/host/moduleReleases.ts'
import { AUTO_UPDATES_NOTE } from '../src/host/autoUpdates.ts'
import { onboardingEditSchema } from '../src/host/onboarding.ts'
import { pinEditSchema } from '../src/host/pinnedPlaces.ts'
import { editSchema as whatsNewEditSchema, notesDue, type Position } from '../src/host/whatsNew.ts'
import { readAutoUpdates, type AutoUpdates } from './autoUpdates.ts'
import type { moduleIntros } from './moduleIntros.ts'
import { readOnboarding, writeOnboarding } from './onboarding.ts'
import { editPinnedPlaces, readPinnedPlaces } from './pinnedPlaces.ts'
import { projectById } from './projects.ts'
import { json, routes, type Desk, type RouteTable } from './routes.ts'
import type { Place, ReleaseFollower } from './updates.ts'
import { editWhatsNew, installedModule, positionOf, readWhatsNew } from './whatsNew.ts'
import { releasesIn, type mentionsDesk } from './whatsNewMentions.ts'

/**
 * What the page keeps for the person, and what it introduces them to:
 *
 *  - `GET  /host/module-intro` — a module's own introduction, read without running it.
 *  - `GET  /host/onboarding`, `POST /host/onboarding` — the introduction seen, and where the tour was left. The POST is the page's alone.
 *  - `GET  /host/pinned-places`, `POST /host/pinned-places` — the person's pinned places. The POST is the page's alone.
 *  - `GET  /host/whats-new`, `POST /host/whats-new` — "What's new" after an update. The POST is the page's alone.
 *  - `POST /host/whats-new/mentions` — "You're mentioned in What's new". The page's alone.
 */
export const PERSON_ROUTES = {
  moduleIntro: { method: 'GET', path: '/host/module-intro' },
  onboarding: { method: 'GET', path: '/host/onboarding' },
  editOnboarding: { method: 'POST', path: '/host/onboarding', pageOnly: true },
  pinnedPlaces: { method: 'GET', path: '/host/pinned-places' },
  editPinnedPlaces: { method: 'POST', path: '/host/pinned-places', pageOnly: true },
  whatsNew: { method: 'GET', path: '/host/whats-new' },
  mentions: { method: 'POST', path: '/host/whats-new/mentions', pageOnly: true },
  editWhatsNew: { method: 'POST', path: '/host/whats-new', pageOnly: true },
} as const satisfies RouteTable

/** One installed module's copy as it is now. */
type InstalledCopy = { place: Place; release: ModuleRelease | undefined; commit: string }

export interface PersonRouteDeps {
  db: Database
  intros: Pick<ReturnType<typeof moduleIntros>, 'introFor'>
  /** Every installed module's copy as it is now: no fetch, and none that could not be read. */
  installedCopies(signal?: AbortSignal): Promise<InstalledCopy[]>
  follower: Pick<ReleaseFollower, 'local' | 'worksFor'>
  /** An update still running, by checkout. */
  progress: { keys(): IterableIterator<string> }
  auto: Pick<AutoUpdates, 'said'>
  mentions: Pick<ReturnType<typeof mentionsDesk>, 'check'>
  wakes: { inboxChanged(project: number, rev: number): void }
}

export function personDesk(deps: PersonRouteDeps): Desk {
  const { db, intros, installedCopies, follower, progress, auto, mentions, wakes } = deps
  return routes(PERSON_ROUTES, {
    /* A module's own introduction (protocol 2.57.0), read without running it: its manifest, its
       installed copy's intro.json, or that file at the release an install would take
       (`server/moduleIntros.ts`). */
    moduleIntro: async (_request, url) => {
      const id = url.searchParams.get('module') ?? ''
      if (!id || id.length > 200) return json({ error: 'Name a module: ?module=<id>.' }, 400)
      return json(await intros.introFor(id))
    },

    /* Whether the introduction was seen and where the tour was left
       (`server/onboarding.ts`). The POST is in `PAGE_ONLY`. */
    onboarding: () => json(readOnboarding(db)),
    editOnboarding: async (request) => {
      const edit = onboardingEditSchema.safeParse(await request.json().catch(() => null))
      if (!edit.success) return json({ error: 'An onboarding change is { intro: "seen" } or { tour: { step, paused?, finished? } }.' }, 400)
      return json(writeOnboarding(db, edit.data))
    },

    /* The person's pinned places (`server/pinnedPlaces.ts`), resolved against
       what is there now. The POST — pin, unpin, order — is in `PAGE_ONLY`. */
    pinnedPlaces: () => json({ pinned: readPinnedPlaces(db) }),
    editPinnedPlaces: async (request) => {
      const edit = pinEditSchema.safeParse(await request.json().catch(() => null))
      if (!edit.success) return json({ error: 'A pinned-places change is { pin: { project, kehikko, epic, scope, parts } }, { unpin: id } or { order: [id, …] }.' }, 400)
      const done = editPinnedPlaces(db, edit.data)
      if (!done.ok) return json({ error: done.why }, done.status)
      return json({ pinned: done.pinned })
    },

    /* "What's new" after an update (`server/whatsNew.ts`): what was last
       acknowledged, beside where each installed copy is now — read from the
       copies, nothing asked of the network. The POST is in `PAGE_ONLY`. */
    whatsNew: async (request, url) => {
      const record = readWhatsNew(db)
      /* Settings' switch needs the setting alone, not every copy read. */
      if (url.searchParams.get('only') === 'record') return json({ record })
      const copies = await installedCopies(request.signal)
      const modules = await Promise.all(
        copies.map(({ place, release, commit }) =>
          installedModule({
            id: place.id,
            name: place.name,
            release,
            commit,
            record,
            local: () => follower.local?.(place) ?? Promise.resolve([]),
            works: (tags) => follower.worksFor?.(place, tags) ?? Promise.resolve({}),
          }),
        ),
      )
      /* Told once: that modules now update themselves, while they do (`autoUpdates.ts`). */
      const notes = notesDue(record, { [AUTO_UPDATES_NOTE]: readAutoUpdates(db) })
      return json({ record, modules, updating: [...progress.keys()], notes, auto: [...new Set(auto.said().updated.map((one) => one.id))] })
    },
    /* "You're mentioned in What's new": the releases the person gets, named by
       the page, read for their handle (`server/whatsNewMentions.ts`). In `PAGE_ONLY`. */
    mentions: async (request) => {
      const body = (await request.json().catch(() => null)) as { project?: unknown; releases?: unknown } | null
      const releases = releasesIn(body?.releases)
      const project = typeof body?.project === 'number' && Number.isInteger(body.project) ? projectById(db, body.project) : null
      if (!releases || !project) return json({ error: 'Name a project and the releases as { item, tag }.' }, 400)
      const out = await mentions.check(project.id, releases)
      if (out.rev !== null) wakes.inboxChanged(project.id, out.rev)
      return json({ told: out.told })
    },
    editWhatsNew: async (request) => {
      const edit = whatsNewEditSchema.safeParse(await request.json().catch(() => null))
      if (!edit.success) return json({ error: 'A change is { baseline }, { acknowledge }, { read } or { show }.' }, 400)
      const record = await editWhatsNew(db, edit.data, async () => {
        const here: Record<string, Position> = {}
        for (const one of await installedCopies()) here[one.place.id] = positionOf(one.release, one.commit)
        return here
      })
      return json({ record })
    },
  })
}
