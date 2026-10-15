import { z } from 'zod'

import type { Narrowing, Inbox } from './inbox.ts'
import type { Scope } from '../src/host/inbox.ts'
import { itemsIn } from './inbox.ts'

/**
 * The Inbox's routes: what the page says its modules are doing, and what the
 * person did with it. The record itself is `server/inbox.ts`.
 *
 *  - `GET  /host/inbox?project=N` — the open entries and a revision.
 *  - `GET  /host/inbox/log?project=N&scope=&epic=&kehikko=&offset=&limit=` — Earlier, a page of it.
 *  - `POST /host/inbox/report` — one module's whole list, or that it went silent.
 *  - `POST /host/inbox/notice` — one legacy `kehikot.notifications@1` line.
 *  - `POST /host/inbox/act` — see, dismiss, forget: the person's.
 *  - `POST /host/inbox/migrate` — what the page kept in its own storage, once.
 *
 * The four POSTs are the page's alone (`PAGE_ONLY` in `guard.ts`): a module's
 * frame is another origin, and an agent has no tool that sees or dismisses.
 * What a page posts is a browser's word and is held to the protocol's own
 * schema before anything is kept.
 */

const BODY_MAX = 1024 * 1024
const NAME_MAX = 120
const LOG_PAGE_MAX = 100

export interface InboxDeps {
  inbox: Inbox
  /** The folder of a project, or null when there is no such project. */
  pathOf(project: number): string | null | undefined
  /** The project's kehikot by key and name, for filing imported lines. */
  kehikotOf?(project: number): readonly { key: string; name: string }[]
  /** Say that a project's inbox is not what the pages last read. */
  changed(project: number, rev: number): void
}

const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

const projectIn = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null

const keysSchema = z
  .array(z.object({ module: z.string().min(1).max(64), id: z.string().min(1).max(128) }))
  .max(512)

const lineSchema = z.object({
  epic: z.string().max(200).default(''),
  message: z.string().min(1).max(2000),
  level: z.string().max(32).default('info'),
  refs: z.array(z.string().max(120)).max(16).default([]),
  place: z
    .object({
      epic: z.string().max(200).optional(),
      parts: z.array(z.string().max(128)).max(16).optional(),
      kehikko: z.string().max(200).optional(),
    })
    .optional(),
})

/** The narrowing a request names: `scope=here` needs the key of the kehikko and the epic open. */
function narrowingIn(scope: unknown, epic: unknown, kehikko: unknown): Narrowing | null {
  if (scope !== 'here') return null
  const text = (value: unknown) => (typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null)
  return { scope: 'here' as Scope, at: { epic: text(epic), kehikko: text(kehikko) } }
}

export function inboxDesk(deps: InboxDeps) {
  const { inbox } = deps

  /** The Notifications module's file, taken in the first time a project's inbox is read. */
  function opened(project: number): void {
    const path = deps.pathOf(project)
    if (path === undefined) return
    const done = inbox.importNotifications(project, path ?? null, deps.kehikotOf?.(project) ?? [])
    if (done.imported) deps.changed(project, inbox.rev(project))
  }

  async function route(request: Request, url: URL): Promise<Response | null> {
    if (!url.pathname.startsWith('/host/inbox')) return null
    if (request.method === 'GET') {
      const project = projectIn(Number(url.searchParams.get('project')))
      if (project === null || deps.pathOf(project) === undefined) {
        return reply({ ok: false, why: 'An inbox is read for a project: ?project=<id>.' }, 400)
      }
      if (url.pathname === '/host/inbox') {
        opened(project)
        return reply({ ok: true, ...inbox.snapshot(project) })
      }
      if (url.pathname === '/host/inbox/log') {
        opened(project)
        const narrowing = narrowingIn(
          url.searchParams.get('scope'),
          url.searchParams.get('epic'),
          url.searchParams.get('kehikko'),
        )
        const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0))
        const limit = Math.min(LOG_PAGE_MAX, Math.max(1, Math.floor(Number(url.searchParams.get('limit')) || 20)))
        return reply({ ok: true, ...inbox.log(project, narrowing, offset, limit) })
      }
      return null
    }
    if (request.method !== 'POST') return null

    const text = await request.text().catch(() => '')
    if (text.length > BODY_MAX) return reply({ ok: false, why: 'That is more than an inbox takes at once.' }, 413)
    let body: Record<string, unknown> | null = null
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
    } catch {
      /* Refused below. */
    }
    if (!body) return reply({ ok: false, why: 'The body is a JSON object.' }, 400)
    const project = projectIn(body.project)
    if (project === null || deps.pathOf(project) === undefined) {
      return reply({ ok: false, why: 'This names a project this host does not have.' }, 400)
    }
    const module = typeof body.module === 'string' && body.module.length > 0 && body.module.length <= 64 ? body.module : null
    const name = typeof body.name === 'string' ? body.name.slice(0, NAME_MAX) : ''

    if (url.pathname === '/host/inbox/report') {
      if (module === null) return reply({ ok: false, why: 'A report names the module.' }, 400)
      const silent = body.silent === true
      const items = silent ? [] : itemsIn(body.items)
      if (items === null) return reply({ ok: false, why: 'That is not a list of activity items the protocol takes.' }, 400)
      const loadedAt = typeof body.loadedAt === 'number' && Number.isFinite(body.loadedAt) ? body.loadedAt : undefined
      opened(project)
      const before = inbox.rev(project)
      const out = inbox.report(project, module, name, items, { silent, ...(loadedAt !== undefined ? { loadedAt } : {}) })
      if (out.rev !== before) deps.changed(project, out.rev)
      return reply({ ok: true, rev: out.rev, open: out.open, earlier: out.earlier, news: out.news })
    }

    if (url.pathname === '/host/inbox/notice') {
      if (module === null) return reply({ ok: false, why: 'A notice names the module.' }, 400)
      const line = lineSchema.safeParse(body.line)
      if (!line.success) return reply({ ok: false, why: 'That is not a notification line.' }, 400)
      const kehikko = typeof body.kehikko === 'string' && body.kehikko.length <= 200 ? body.kehikko : undefined
      opened(project)
      const out = inbox.notice(project, module, name, line.data, kehikko)
      deps.changed(project, out.rev)
      return reply({ ok: true, rev: out.rev, open: out.open, earlier: out.earlier })
    }

    if (url.pathname === '/host/inbox/act') {
      const act = body.do
      const narrowing = narrowingIn(body.scope, body.epic, body.kehikko)
      const keys = body.keys === undefined ? null : keysSchema.safeParse(body.keys)
      if (keys && !keys.success) return reply({ ok: false, why: 'keys is a list of { module, id }.' }, 400)
      let changed = 0
      if (act === 'seen') {
        if (!keys) return reply({ ok: false, why: 'seen names the items: keys.' }, 400)
        changed = inbox.see(project, keys.data).changed
      } else if (act === 'dismiss') {
        if (!keys) return reply({ ok: false, why: 'dismiss names the items: keys.' }, 400)
        changed = inbox.dismiss(project, keys.data).changed
      } else if (act === 'seen-all') {
        changed = inbox.seeAll(project, narrowing).changed
      } else if (act === 'forget') {
        changed = inbox.forget(project, keys ? keys.data : null, narrowing).forgotten
      } else {
        return reply({ ok: false, why: 'do is one of seen, dismiss, seen-all, forget.' }, 400)
      }
      if (changed) deps.changed(project, inbox.rev(project))
      return reply({ ok: true, changed, ...inbox.snapshot(project) })
    }

    if (url.pathname === '/host/inbox/migrate') {
      const migrated = inbox.migrate(project, body.seen, body.told)
      deps.changed(project, migrated.rev)
      return reply({ ok: true, ...inbox.snapshot(project) })
    }
    return null
  }

  return { route }
}
