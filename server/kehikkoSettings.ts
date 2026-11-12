import type { Database } from 'bun:sqlite'

import { NO_SETTINGS, takesPlaceNews, type KehikkoSettings } from '../src/host/kehikkoSettings.ts'

/**
 * A kehikko's own settings (`src/host/kehikkoSettings.ts`): today, which agent module is the
 * primary one, and whether the person put that choice off.
 *
 * ## Where they live, and why there
 *
 * In `frame.sqlite`, per project id and kehikko key (`Canvas.key`, the kehikko's identity that
 * survives a re-add), never in the project. Which agent modules a person has installed is a fact
 * about this computer; a teammate's clone may have others, and a file in the repository that
 * routed news would be a way for a pulled branch to choose who hears what.
 *
 * ## Who writes
 *
 * The person, from the page: `POST /host/kehikko-settings` is in `PAGE_ONLY` (`guard.ts`). No MCP
 * tool reads or changes them; routing reads them (`AgentMessages`' `takesNews`).
 */

export function ensureKehikkoSettings(db: Database): void {
  db.exec(`
    -- A kehikko's own settings, per project and kehikko key: the person's (kehikkoSettings.ts).
    create table if not exists kehikko_settings (
      project integer not null references projects(id) on delete cascade,
      key     text    not null,
      primary_module text,
      later   text    not null default '[]',
      at      integer not null,
      primary key (project, key)
    );
  `)
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const MODULE = /^[a-z0-9][a-z0-9._-]{0,199}$/

const strings = (text: string): string[] => {
  try {
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed) ? parsed.filter((one): one is string => typeof one === 'string') : []
  } catch {
    return []
  }
}

/** One kehikko's settings; the defaults when nothing was kept. */
export function readKehikkoSettings(db: Database, project: number, key: string): KehikkoSettings {
  ensureKehikkoSettings(db)
  const row = db
    .query<{ primary_module: string | null; later: string }, [number, string]>('select primary_module, later from kehikko_settings where project = ? and key = ?')
    .get(project, key)
  return row ? { primary: row.primary_module, later: strings(row.later) } : { ...NO_SETTINGS, later: [] }
}

export type KehikkoSettingsEdit = { primary: string | null } | { later: readonly string[] }

/**
 * The person's act: choose a primary (one of `agents`, the agent modules on the kehikko now), clear
 * it, or put the choice off for the agent modules there now. Choosing clears Later. Refused with a
 * sentence when the module is not an agent module on that kehikko.
 */
export function editKehikkoSettings(
  db: Database,
  project: number,
  key: string,
  edit: KehikkoSettingsEdit,
  agents: readonly string[],
  clock: () => number = () => Date.now(),
): { ok: true; settings: KehikkoSettings } | { ok: false; why: string; status: number } {
  ensureKehikkoSettings(db)
  if (!KEY.test(key)) return { ok: false, why: 'That is not a kehikko this host keeps settings for.', status: 400 }
  const was = readKehikkoSettings(db, project, key)
  let next: KehikkoSettings
  if ('primary' in edit) {
    const primary = edit.primary
    if (primary !== null && (!MODULE.test(primary) || !agents.includes(primary))) {
      return { ok: false, why: 'That module is not an agent on this kehikko, so it cannot be its primary agent.', status: 400 }
    }
    next = { primary, later: primary === null ? was.later : [] }
  } else {
    next = { primary: was.primary, later: [...new Set(edit.later)].filter((one) => MODULE.test(one)).slice(0, 64) }
  }
  db.query(
    `insert into kehikko_settings (project, key, primary_module, later, at) values (?, ?, ?, ?, ?)
     on conflict (project, key) do update set primary_module = excluded.primary_module, later = excluded.later, at = excluded.at`,
  ).run(project, key, next.primary, JSON.stringify(next.later), clock())
  return { ok: true, settings: next }
}

/**
 * Whether a session of `module`, at kehikko `key` in `project`, is handed news to a place. A session
 * at no kehikko is handed it, as before; at one, only the primary's sessions when one is chosen.
 */
export function takesNewsAt(db: Database, project: number, key: string | null, module: string, agentsOn: (project: number, key: string) => readonly string[]): boolean {
  if (key === null) return true
  const settings = readKehikkoSettings(db, project, key)
  if (settings.primary === null) return true
  return takesPlaceNews(module, agentsOn(project, key), settings)
}
