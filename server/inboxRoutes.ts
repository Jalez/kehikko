import { z } from 'zod'
import { INBOX_VIA, messageFromPlaceSchema, type InboxEvent } from 'kehikot-module-protocol'

import type { AgentMessages } from './agentMessages.ts'
import type { Narrowing, Inbox } from './inbox.ts'
import { answerFor, type Entry, type Present, type Scope } from '../src/host/inbox.ts'
import { itemsIn } from './inbox.ts'
import { HOST_ID } from './kehikot.ts'
import type { NoticeLink } from '../src/host/trackerNotices.ts'

/**
 * The Inbox's routes: what the page says its modules are doing, and what the
 * person did with it. The record itself is `server/inbox.ts`.
 *
 *  - `GET  /host/inbox?project=N` — the open entries and a revision.
 *  - `GET  /host/inbox/log?project=N&scope=&epic=&kehikko=&offset=&limit=` — Earlier, a page of it.
 *  - `GET  /host/inbox/link?project=N&module=M&id=I` — where one of the host's own items points
 *    (a tracker notice's ref, forge, project path, number and page: `linkOf`), or `link: null`.
 *  - `POST /host/inbox/report` — one module's whole list, or that it went
 *    silent (`silent: true`), or that its new page did not say it again
 *    (`unreported: true`).
 *
 * Every read and report first retires what nothing will report again: the
 * entries of a module that is not installed, a kehikko or an epic that is gone
 * (`present`, `Inbox.retire`).
 *  - `POST /host/inbox/notice` — one legacy `kehikot.notifications@1` line (`events.emit`).
 *  - `POST /host/inbox/act` — see, dismiss, forget, and `took` (an agent's offer the person went to,
 *    closed as taken): the person's.
 *  - `POST /host/inbox/migrate` — what the page kept in its own storage, once.
 *  - `POST /host/inbox/use` — `{ module, use }`: the person's "Use inbox" switch for one module,
 *    machine-wide (`Inbox.use`). Every project's record is said to have changed.
 *  - `POST /host/inbox/answer` — `{ project, module, item, answer?, choice?, pressed: true }`: the
 *    person's answer to an entry's question (protocol 2.55.0), sent to the session the question
 *    names as the PERSON's message, by `INBOX_VIA`, and the entry marked answered (`answer` below).
 *
 * The six POSTs are the page's alone (`PAGE_ONLY` in `guard.ts`): a module's
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
  /** What is still there for a project — installed modules, its kehikot, its epics — or null when not known. */
  present?(project: number): Present | null
  /**
   * The Inbox events a module's manifest declares (protocol 2.31.0), from the
   * last sighting of it: what an item's `event` is held to. None known, none
   * held: the item is an ordinary item of its state.
   */
  eventsOf?(module: string): readonly InboxEvent[] | undefined
  /**
   * Whether a module's manifest, as last seen, declares `messages:as-person`: a module that relays
   * other sessions' questions, whose item may name another module's session (`heldQuestion`).
   */
  relays?(module: string): boolean
  /** The messages between agent sessions: where an answer from the Inbox is kept for its session. */
  messages?: Pick<AgentMessages, 'send'>
  /** The project's messages changed: pages, and the module that delivers them, read them again. */
  messagesChanged?(project: number): void
  /** Say that a project's inbox is not what the pages last read. */
  changed(project: number, rev: number): void
  /** Where one of the host's own items points (a tracker notice's `NoticeLink`), or null. */
  linkOf?(project: number, module: string, id: string): NoticeLink | null
}

export const ANSWER_SAYS = {
  noPress: 'An answer from the Inbox goes only on the person’s own press in this page, and none came with it. Nothing was sent.',
  noItem: 'That names no open item of this module in this project.',
  noMessages: 'This host keeps no messages between agent sessions, so there is nowhere to send an answer.',
} as const

/**
 * The person's answer to an entry's question, as the message it is sent as: the person's own
 * (`person`), by the name `INBOX_VIA`, from the host and no session, at the item's place; to the
 * one session the question names; answering its message (`replyTo`) or else its text (`answers`).
 */
export function answerMessage(entry: Entry, text: string): {
  from: Parameters<AgentMessages['send']>[1]
  body: string
  to: { session: { module: string; session: string } }
  extras: Parameters<AgentMessages['send']>[5]
} {
  const question = entry.question!
  const place = messageFromPlaceSchema.safeParse({
    epic: entry.place?.epic || null,
    parts: entry.place?.parts ?? [],
    kehikko: entry.place?.kehikko ?? null,
  })
  const at = place.success ? place.data : { epic: null, parts: [], kehikko: null }
  return {
    from: { module: HOST_ID, name: INBOX_VIA, session: '', epic: at.epic, parts: at.parts, kehikko: at.kehikko, person: true },
    body: text,
    to: { session: { module: question.to.module, session: question.to.session } },
    extras: question.replyTo !== undefined ? { replyTo: question.replyTo } : { answers: question.text },
  }
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

/** The POSTs this desk answers. Every other `/host/inbox/…` POST is another desk's, and its body is left unread. */
export const INBOX_POSTS = ['/host/inbox/use', '/host/inbox/report', '/host/inbox/notice', '/host/inbox/act', '/host/inbox/answer', '/host/inbox/migrate'] as const

export function inboxDesk(deps: InboxDeps) {
  const { inbox } = deps

  /** What is still there, and the open entries of what is not closed, before the record is read or written. */
  function present(project: number): Present | null {
    const now = deps.present?.(project) ?? null
    if (!now) return null
    const out = inbox.retire(project, now)
    if (out.retired) deps.changed(project, out.rev)
    return now
  }

  async function route(request: Request, url: URL): Promise<Response | null> {
    if (!url.pathname.startsWith('/host/inbox')) return null
    if (request.method === 'GET') {
      const project = projectIn(Number(url.searchParams.get('project')))
      if (project === null || deps.pathOf(project) === undefined) {
        return reply({ ok: false, why: 'An inbox is read for a project: ?project=<id>.' }, 400)
      }
      if (url.pathname === '/host/inbox') {
        present(project)
        return reply({ ok: true, ...inbox.snapshot(project) })
      }
      if (url.pathname === '/host/inbox/log') {
        const narrowing = narrowingIn(
          url.searchParams.get('scope'),
          url.searchParams.get('epic'),
          url.searchParams.get('kehikko'),
        )
        const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0))
        const limit = Math.min(LOG_PAGE_MAX, Math.max(1, Math.floor(Number(url.searchParams.get('limit')) || 20)))
        return reply({ ok: true, ...inbox.log(project, narrowing, offset, limit) })
      }
      if (url.pathname === '/host/inbox/link') {
        const module = url.searchParams.get('module') ?? ''
        const id = url.searchParams.get('id') ?? ''
        if (!module || !id || module.length > 64 || id.length > 128) return reply({ ok: false, why: 'A link is read for one item: &module=&id=.' }, 400)
        return reply({ ok: true, link: deps.linkOf?.(project, module, id) ?? null })
      }
      return null
    }
    if (request.method !== 'POST') return null
    /* Only its own: a body read here is gone for the route that owns the path (the adopt routes,
       `adoptRoutes.ts`, share the prefix), which then threw "Body already used" — a silent 500. */
    if (!(INBOX_POSTS as readonly string[]).includes(url.pathname)) return null

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

    /* The person's switch is about a module, not a project: answered before a project is asked for. */
    if (url.pathname === '/host/inbox/use') {
      const module = typeof body.module === 'string' && body.module.length > 0 && body.module.length <= 64 ? body.module : null
      if (module === null) return reply({ ok: false, why: 'Use inbox names the module.' }, 400)
      if (typeof body.use !== 'boolean') return reply({ ok: false, why: 'use is true (show it in the Inbox) or false (do not).' }, 400)
      const out = inbox.use(module, body.use)
      for (const one of out.revs) deps.changed(one.project, one.rev)
      return reply({ ok: true, changed: out.changed, muted: inbox.muted() })
    }

    const project = projectIn(body.project)
    if (project === null || deps.pathOf(project) === undefined) {
      return reply({ ok: false, why: 'This names a project this host does not have.' }, 400)
    }
    const module = typeof body.module === 'string' && body.module.length > 0 && body.module.length <= 64 ? body.module : null
    const name = typeof body.name === 'string' ? body.name.slice(0, NAME_MAX) : ''

    if (url.pathname === '/host/inbox/report') {
      if (module === null) return reply({ ok: false, why: 'A report names the module.' }, 400)
      const silent = body.silent === true
      const unreported = !silent && body.unreported === true
      const items = silent || unreported ? [] : itemsIn(body.items)
      if (items === null) return reply({ ok: false, why: 'That is not a list of activity items the protocol takes.' }, 400)
      const loadedAt = typeof body.loadedAt === 'number' && Number.isFinite(body.loadedAt) ? body.loadedAt : undefined
      const now = present(project)
      const before = inbox.rev(project)
      const out = inbox.report(project, module, name, items, {
        silent,
        unreported,
        present: now,
        events: deps.eventsOf?.(module) ?? [],
        relays: deps.relays?.(module) ?? false,
        ...(loadedAt !== undefined ? { loadedAt } : {}),
      })
      if (out.rev !== before) deps.changed(project, out.rev)
      return reply({ ok: true, rev: out.rev, open: out.open, earlier: out.earlier, news: out.news })
    }

    if (url.pathname === '/host/inbox/notice') {
      if (module === null) return reply({ ok: false, why: 'A notice names the module.' }, 400)
      const line = lineSchema.safeParse(body.line)
      if (!line.success) return reply({ ok: false, why: 'That is not a notification line.' }, 400)
      const kehikko = typeof body.kehikko === 'string' && body.kehikko.length <= 200 ? body.kehikko : undefined
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
      } else if (act === 'took') {
        if (!keys) return reply({ ok: false, why: 'took names the offers: keys.' }, 400)
        changed = inbox.took(project, keys.data).changed
      } else {
        return reply({ ok: false, why: 'do is one of seen, dismiss, seen-all, forget, took.' }, 400)
      }
      if (changed) deps.changed(project, inbox.rev(project))
      return reply({ ok: true, changed, ...inbox.snapshot(project) })
    }

    /*
     * The person's answer to a question an item asks. No module's grant applies: this page is the
     * person, and only this page reaches the route (`PAGE_ONLY`). The page sends it only on their
     * fresh press (`pressFresh`) and says so; without that it is refused. No MCP tool answers.
     */
    if (url.pathname === '/host/inbox/answer') {
      if (body.pressed !== true) return reply({ ok: false, why: ANSWER_SAYS.noPress }, 403)
      if (module === null) return reply({ ok: false, why: 'An answer names the module.' }, 400)
      const id = typeof body.item === 'string' && body.item.length > 0 && body.item.length <= 128 ? body.item : null
      if (id === null) return reply({ ok: false, why: 'An answer names the item.' }, 400)
      const entry = inbox.entry(project, module, id)
      if (!entry || entry.closed !== null) return reply({ ok: false, why: ANSWER_SAYS.noItem }, 404)
      const said = answerFor(entry, { answer: body.answer, choice: body.choice })
      if (!said.ok) return reply({ ok: false, why: said.why }, 409)
      if (!deps.messages) return reply({ ok: false, why: ANSWER_SAYS.noMessages }, 503)
      const message = answerMessage(entry, said.text)
      const sent = deps.messages.send(project, message.from, message.body, message.to, null, message.extras)
      if (!sent.ok) return reply({ ok: false, why: sent.why }, 429)
      deps.messagesChanged?.(project)
      const marked = inbox.answer(project, module, id, said.text)
      if (marked) deps.changed(project, marked.rev)
      return reply({ ok: true, message: sent.id, ...inbox.snapshot(project) })
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
