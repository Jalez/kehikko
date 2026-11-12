import type { Database } from 'bun:sqlite'
import { z } from 'zod'

/**
 * The person's agent for Kehikot's own tasks: one module that provides `agent.tasks` (protocol 2.88.0),
 * picked in Settings › Agents, with no default until the person picks one. Adopting an Inbox item with
 * an agent starts a conversation there (`adoption.ts`); with none picked, the person chooses the epic
 * themselves. Kept as one row of `settings` in `frame.sqlite`: it is about this machine.
 *
 * `GET /host/tasks-agent` → `{ ok, agent, choices }` — the picked module (or null) and every module that
 * provides `agent.tasks` now, by id and registered name; this host names none of its own accord.
 * `POST /host/tasks-agent` `{ agent: <id> | null }`. Both the page's alone (`PAGE_ONLY`).
 */

const KEY = 'tasks-agent'

export function readTasksAgent(db: Database): string | null {
  try {
    const row = db.query<{ value: string }, [string]>('select value from settings where key = ?').get(KEY)
    const value = row ? (JSON.parse(row.value) as unknown) : null
    return typeof value === 'string' && value ? value : null
  } catch {
    return null
  }
}

export function writeTasksAgent(db: Database, agent: string | null): void {
  db.exec('create table if not exists settings (key text primary key, value text not null)')
  db.query('insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value').run(KEY, JSON.stringify(agent))
}

export interface TasksAgentDeps {
  db: Database
  /** The modules that provide `agent.tasks` now. */
  choices(): { module: string; name: string }[]
}

const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export function tasksAgentRoute(deps: TasksAgentDeps) {
  return async function handle(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname !== '/host/tasks-agent') return null
    if (request.method === 'GET') return reply({ ok: true, agent: readTasksAgent(deps.db), choices: deps.choices() })
    if (request.method !== 'POST') return reply({ ok: false, error: '/host/tasks-agent answers GET or POST.' }, 405)
    let raw: unknown = null
    try {
      raw = JSON.parse(await request.text())
    } catch {
      /* Read as nothing below. */
    }
    const got = z.object({ agent: z.string().min(1).max(64).nullable() }).safeParse(raw)
    if (!got.success) return reply({ ok: false, error: 'Name a module, or null for none.' }, 400)
    if (got.data.agent !== null && !deps.choices().some((one) => one.module === got.data.agent)) {
      return reply({ ok: false, error: 'That module does not start conversations for Kehikot’s own tasks.' }, 400)
    }
    writeTasksAgent(deps.db, got.data.agent)
    return reply({ ok: true, agent: got.data.agent })
  }
}
