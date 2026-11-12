import { z } from 'zod'
import { EPIC_SLUG, KEHIKKO_KEY, LIMITS } from 'kehikot-module-protocol'
import { spendServerPass } from 'kehikot-module-protocol/serve'

import type { Adoption } from './adoption.ts'

/**
 * The routes of adopting a tracker item no epic names (protocol 2.88.0; `adoption.ts`):
 *
 *  - `GET  /host/inbox/adoption?project=N&module=M&id=I` — what the page offers (`inboxAdoptionResult`).
 *  - `GET  /host/inbox/afters?project=N` — each item's line after its last adopt or untrack.
 *  - `POST /host/inbox/adopt` — `{ project, module, id, epic, parts?, kehikko?, task?, also? }`.
 *  - `POST /host/inbox/untrack` — `{ project, module, id }`.
 *  - `POST /host/inbox/undo` — `{ project, module, id }`.
 *  - `GET  /host/inbox/untracked?project=N`, `POST /host/inbox/retrack` `{ project, id }` — Settings › Trackers.
 *  - `POST /host/inbox/task` — `{ project, module, id }`: the person's agent for Kehikot's own tasks started on it.
 *
 * Every one is the page's alone (`PAGE_ONLY` in `guard.ts`): conversation titles are read, and the
 * person's acts are taken, nowhere else. The page holds each act to the person's fresh press in the
 * frame that asked. No MCP tool reaches any of them.
 *
 *  - `GET  /host/server-pass?pass=P` — `{ ok, minted }`: whether this host minted a pass it sent a module
 *    with a service call (`HOST_PASS_PATH`, `vouchHost`). For programs; spent by the asking.
 */

export const ADOPT_ROUTES = [
  '/host/inbox/adoption',
  '/host/inbox/afters',
  '/host/inbox/adopt',
  '/host/inbox/untrack',
  '/host/inbox/undo',
  '/host/inbox/untracked',
  '/host/inbox/retrack',
  '/host/inbox/task',
] as const

export interface AdoptRouteDeps {
  adoption: Adoption
  /** Items the person said not to track in a project. */
  untracked(project: number): { id: string; ref: string; title: string; at: number }[]
  hasProject(project: number): boolean
}

const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const project = z.number().int().positive()
const key = z.object({ project, module: z.string().min(1).max(64), id: z.string().min(1).max(LIMITS.ACTIVITY_ID) })
const adoptBody = key.extend({
  epic: z.string().regex(EPIC_SLUG),
  parts: z.array(z.string().regex(EPIC_SLUG)).max(LIMITS.PARTS).default([]),
  kehikko: z.string().regex(KEHIKKO_KEY).nullable().default(null),
  task: z.object({ module: z.string().min(1).max(64), session: z.string().min(1).max(128) }).nullable().default(null),
  also: z.array(z.string().min(1).max(128)).max(20).default([]),
  /* The space to adopt into, at any depth, by its path of ids (protocol 2.89.0); its first id is `epic`. */
  space: z.array(z.string().regex(EPIC_SLUG)).min(1).max(LIMITS.SPACE_DEPTH).nullable().default(null),
})

const BODY_MAX = 64 * 1024

async function bodyOf(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text.length > BODY_MAX) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function adoptRoutes(deps: AdoptRouteDeps) {
  return async function handle(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname === '/host/server-pass') {
      if (request.method !== 'GET') return reply({ ok: false, error: '/host/server-pass answers GET.' }, 405)
      return reply({ ok: true, minted: spendServerPass(url.searchParams.get('pass')) })
    }
    if (!(ADOPT_ROUTES as readonly string[]).includes(url.pathname)) return null
    const get = request.method === 'GET'
    if (get) {
      const id = Number(url.searchParams.get('project'))
      if (!Number.isInteger(id) || id <= 0 || !deps.hasProject(id)) return reply({ ok: false, error: 'That names no project.' }, 400)
      if (url.pathname === '/host/inbox/afters') return reply({ ok: true, afters: deps.adoption.afters(id) })
      if (url.pathname === '/host/inbox/untracked') return reply({ ok: true, untracked: deps.untracked(id) })
      if (url.pathname === '/host/inbox/adoption') {
        const module = url.searchParams.get('module') ?? ''
        const item = url.searchParams.get('id') ?? ''
        if (!module || !item) return reply({ ok: false, error: 'Name the item: module and id.' }, 400)
        return reply({ ok: true, adoption: await deps.adoption.adoption(id, module, item) })
      }
      return reply({ ok: false, error: `${url.pathname} answers POST.` }, 405)
    }
    if (request.method !== 'POST') return reply({ ok: false, error: `${url.pathname} answers GET or POST.` }, 405)
    const raw = await bodyOf(request)
    if (url.pathname === '/host/inbox/retrack') {
      const got = z.object({ project, id: z.string().min(1).max(LIMITS.ACTIVITY_ID) }).safeParse(raw)
      if (!got.success || !deps.hasProject(got.data.project)) return reply({ ok: false, error: 'That is not an item to track again.' }, 400)
      return reply({ ok: true, changed: deps.adoption.retrack(got.data.project, got.data.id) })
    }
    if (url.pathname === '/host/inbox/adopt') {
      const got = adoptBody.safeParse(raw)
      if (!got.success || !deps.hasProject(got.data.project)) return reply({ ok: false, error: 'That is not an adoption Kehikot takes.' }, 400)
      const b = got.data
      return reply({ ok: true, result: await deps.adoption.adopt(b.project, b.module, b.id, b.epic, b.parts, b.kehikko, b.task, b.also, b.space) })
    }
    const got = key.safeParse(raw)
    if (!got.success || !deps.hasProject(got.data.project)) return reply({ ok: false, error: 'That names no item of a project of yours.' }, 400)
    const b = got.data
    if (url.pathname === '/host/inbox/untrack') return reply({ ok: true, result: deps.adoption.untrack(b.project, b.module, b.id) })
    if (url.pathname === '/host/inbox/undo') return reply({ ok: true, result: await deps.adoption.undo(b.project, b.module, b.id) })
    if (url.pathname === '/host/inbox/task') return reply({ ok: true, result: await deps.adoption.startTask(b.project, b.module, b.id) })
    return null
  }
}
