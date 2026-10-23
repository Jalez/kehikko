import type { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  DEFAULT_SETTINGS,
  excepting,
  settingsPatched,
  settingsStored,
  type AgentSettings,
  type SettingsAnswer,
  type StartHook,
  type SyncStatus,
} from '../src/host/agentSettings.ts'
import { noticesPatched } from '../src/host/trackerNotices.ts'
import { readNotices, writeNotices } from './trackerNotices.ts'
import { keepRunningChange, readKeepRunning, writeKeepRunning } from './keepRunning.ts'

/**
 * The app-wide agent settings (`src/host/agentSettings.ts` has the shape and
 * the words), kept on this machine: one row of `settings` in `frame.sqlite`.
 * Not in a project — they are about the person's agent, which every project
 * shares — and not in browser storage, because the server's sync acts on them
 * with no page open.
 *
 * Beside them, `agent_made`: every entry in the agent's MCP list that Kehikot
 * made (from the sync, or from a press in a module's Tools window) or found
 * pointing exactly at a module's door. It is how the sync knows which entries
 * are its own to re-point when a door moves and to remove when a module is
 * uninstalled; an entry not in it is never changed by the sync.
 *
 * The routes: `GET /host/settings` (the settings, what the sync last found, and
 * the start hook's state) and `POST /host/settings` (a change). The POST is in
 * `PAGE_ONLY`, and no MCP tool changes a setting.
 */

const KEY = 'agents'

export function ensureSettings(db: Database): void {
  db.exec(`
    create table if not exists settings (
      key   text primary key,
      value text not null
    );
    create table if not exists agent_made (
      provider text not null,
      module   text not null,
      name     text not null,
      url      text not null,
      title    text not null default '',
      at       integer not null,
      primary key (provider, module)
    );
    create table if not exists skill_left (
      name   text primary key,
      module text not null,
      at     integer not null
    );
    create table if not exists skill_bound_left (
      name   text primary key,
      module text not null,
      at     integer not null
    );
  `)
}

/**
 * Kehikko-bound skills (protocol 2.12.0) left in the person's skills folder
 * because they changed them, by name: said once (`agentSync.ts`), forgotten
 * when the folder is no longer an edited install of that module's.
 */
export function boundLeft(db: Database): Map<string, string> {
  const rows = db.query<{ name: string; module: string }, []>('select name, module from skill_bound_left').all()
  return new Map(rows.map((row) => [row.name, row.module]))
}

export function recordBoundLeft(db: Database, name: string, module: string, now = Date.now()): void {
  db.query(
    'insert into skill_bound_left (name, module, at) values (?, ?, ?) on conflict (name) do update set module = excluded.module, at = excluded.at',
  ).run(name, module, now)
}

export function forgetBoundLeft(db: Database, name: string): void {
  db.query('delete from skill_bound_left where name = ?').run(name)
}

/**
 * Skills of an uninstalled module that the person changed, so they were left
 * where they are — remembered so that is said once, not on every run.
 */
export function leftSkills(db: Database): Map<string, string> {
  const rows = db.query<{ name: string; module: string }, []>('select name, module from skill_left').all()
  return new Map(rows.map((row) => [row.name, row.module]))
}

export function recordLeft(db: Database, name: string, module: string, now = Date.now()): void {
  db.query(
    'insert into skill_left (name, module, at) values (?, ?, ?) on conflict (name) do update set module = excluded.module, at = excluded.at',
  ).run(name, module, now)
}

export function forgetLeft(db: Database, name: string): void {
  db.query('delete from skill_left where name = ?').run(name)
}

export function readSettings(db: Database): AgentSettings {
  const row = db.query<{ value: string }, [string]>('select value from settings where key = ?').get(KEY)
  if (!row) return DEFAULT_SETTINGS
  try {
    return settingsStored(JSON.parse(row.value))
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function writeSettings(db: Database, settings: AgentSettings): void {
  db.query('insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value').run(
    KEY,
    JSON.stringify(settings),
  )
}

/** One entry Kehikot made, or adopted, in an agent's MCP list. */
export interface Made {
  module: string
  name: string
  url: string
  /** The module's name when it was made, for the line said when it is removed. */
  title: string
}

const PROVIDER = 'claudeCode'

export function madeEntries(db: Database): Made[] {
  return db
    .query<Made, [string]>('select module, name, url, title from agent_made where provider = ? order by module')
    .all(PROVIDER)
}

export function recordMade(db: Database, made: Made, now = Date.now()): void {
  db.query(
    `insert into agent_made (provider, module, name, url, title, at) values (?, ?, ?, ?, ?, ?)
     on conflict (provider, module) do update set name = excluded.name, url = excluded.url, title = excluded.title, at = excluded.at`,
  ).run(PROVIDER, made.module, made.name, made.url, made.title, now)
}

export function forgetMade(db: Database, module: string): void {
  db.query('delete from agent_made where provider = ? and module = ?').run(PROVIDER, module)
}

type Env = Record<string, string | undefined>

/**
 * Claude Code's settings file, where the Claude module's SessionStart hook
 * goes. Resolved the way `claudeSkillsDir` resolves the skills folder, so
 * `CLAUDE_CONFIG` (the test suite's scratch config) moves it too.
 */
export function claudeSettingsFile(env: Env = process.env): string {
  if (env.CLAUDE_CONFIG) return join(dirname(env.CLAUDE_CONFIG), '.claude', 'settings.json')
  if (env.CLAUDE_CONFIG_DIR) return join(env.CLAUDE_CONFIG_DIR, 'settings.json')
  return join(env.HOME || homedir(), '.claude', 'settings.json')
}

/**
 * Whether the Claude module's start hook is in that file. READ ONLY: the host
 * never writes it; the Claude module adds the entry on a person's press. The
 * entry is recognised as the module recognises it: a SessionStart entry that
 * runs its `started.sh` with its registration.
 */
export function startHook(file = claudeSettingsFile()): StartHook {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { file, on: (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null }
  }
  try {
    const parsed = JSON.parse(text) as { hooks?: { SessionStart?: unknown } } | null
    const start = parsed && typeof parsed === 'object' ? parsed.hooks?.SessionStart : undefined
    const said = Array.isArray(start) ? JSON.stringify(start) : ''
    return { file, on: said.includes('started.sh') && said.includes('kehikot.claude.json') }
  } catch {
    return { file, on: null }
  }
}

const BODY_MAX = 64 * 1024

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

export interface SettingsDeps {
  db: Database
  /** What the sync last found. */
  status(): SyncStatus
  /** The settings changed: run the sync. */
  changed(settings: AgentSettings): void
  /** The tracker notices setting changed: every project's notices again. */
  noticesChanged?(): void
  /** "Keep this project's modules running" changed: decide again what runs. */
  modulesChanged?(keep: boolean): void
  skillsAt(): string
  hook?(): StartHook
}

/**
 * `GET /host/settings` and `POST /host/settings`.
 *
 * A POST is a change of the tracker notices (`{ notices: { on, scope, events } }`,
 * any subset), "Keep this project's modules running" (`{ modules: { keep } }`,
 * `keepRunning.ts`), or a change of the settings (`{ settings: { tools: { auto } } }`,
 * any subset) or one module put on or off a list of exceptions
 * (`{ except: { kind: 'tools' | 'skills', module, out: boolean } }`), which is
 * what a module's own Tools and Skills windows send, so two windows each
 * changing one module do not undo each other.
 */
export function settingsRoute(deps: SettingsDeps) {
  const answer = (): SettingsAnswer => ({
    ok: true,
    settings: readSettings(deps.db),
    status: deps.status(),
    hook: (deps.hook ?? (() => startHook()))(),
    notices: readNotices(deps.db),
    modules: { keep: readKeepRunning(deps.db) },
    skillsAt: deps.skillsAt(),
  })

  return async (request: Request, url: URL): Promise<Response | null> => {
    if (url.pathname !== '/host/settings') return null
    if (request.method === 'GET') return json(answer())
    if (request.method !== 'POST') return json({ ok: false, why: 'GET or POST.' }, 405)

    const raw = await request.text()
    if (raw.length > BODY_MAX) return json({ ok: false, why: 'That request is too large.' }, 413)
    let body: { settings?: unknown; except?: unknown; notices?: unknown; modules?: unknown }
    try {
      body = JSON.parse(raw)
    } catch {
      return json({ ok: false, why: 'The body is not JSON.' }, 400)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ ok: false, why: 'The body is a JSON object.' }, 400)

    if (body.notices !== undefined) {
      const next = noticesPatched(readNotices(deps.db), body.notices)
      if (!next) return json({ ok: false, why: 'That is not a change the tracker notices take.' }, 400)
      writeNotices(deps.db, next)
      deps.noticesChanged?.()
      return json(answer())
    }

    if (body.modules !== undefined) {
      const keep = keepRunningChange(body.modules)
      if (keep === null) return json({ ok: false, why: 'A change of the running modules is { keep: true } or { keep: false }.' }, 400)
      if (keep !== readKeepRunning(deps.db)) {
        writeKeepRunning(deps.db, keep)
        deps.modulesChanged?.(keep)
      }
      return json(answer())
    }

    const was = readSettings(deps.db)
    let next: AgentSettings | null = null
    if (body.settings !== undefined) {
      next = settingsPatched(was, body.settings)
      if (!next) return json({ ok: false, why: 'That is not a change Settings takes.' }, 400)
    } else if (body.except !== undefined) {
      const except = body.except as { kind?: unknown; module?: unknown; out?: unknown } | null
      const kind = except?.kind
      const module = except?.module
      if (
        (kind !== 'tools' && kind !== 'skills') ||
        typeof module !== 'string' ||
        module.length === 0 ||
        module.length > 64 ||
        typeof except?.out !== 'boolean'
      ) {
        return json({ ok: false, why: 'An exception names tools or skills, one module, and out: true or false.' }, 400)
      }
      next = excepting(was, kind, module, except.out)
    } else {
      return json({ ok: false, why: 'A change names settings or one exception.' }, 400)
    }

    writeSettings(deps.db, next)
    deps.changed(next)
    return json(answer())
  }
}
