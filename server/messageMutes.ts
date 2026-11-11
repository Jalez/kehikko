import type { Database } from 'bun:sqlite'

/**
 * "Messages to agents": the person's switch, per module and per project, for whether a module's
 * OWN messages reach the agent sessions there. On unless the person turned it off.
 *
 * Off, the host takes none of that module's own messages in that project — `messages.notify` from
 * its server, `messages.post` from its page, a message to every session at a place — and answers
 * each with its `declined` outcome and `MUTED_SAYS`. Nothing is kept for delivery and nothing is
 * woken. What it never touches: the person's own messages sent through a module (`from.person`),
 * and a session's messages to other sessions (`messages.send`, stamped with the session): those are
 * not the module's own words.
 *
 * Kept in `frame.sqlite` per project id, never in the project; set only by a press in the page
 * (`POST /host/messages/mute`, `PAGE_ONLY`). No MCP tool mutes or unmutes; `read_canvas` says it.
 */

/** What a muted module is told, as its call's `declined` reason. Generic: the host names no module. */
export const MUTED_SAYS = 'The person muted this module’s messages.'

export function ensureMessageMutes(db: Database): void {
  db.exec(`
    -- "Messages to agents" off, per project and module: the person's switch (MessageMutes.set).
    create table if not exists messages_muted (
      project integer not null references projects(id) on delete cascade,
      module  text    not null,
      at      integer not null,
      primary key (project, module)
    );
  `)
}

/** The modules whose messages the person muted in a project, sorted. Read straight from the store. */
export function mutedIn(db: Database, project: number): string[] {
  ensureMessageMutes(db)
  return db
    .query<{ module: string }, [number]>('select module from messages_muted where project = ? order by module')
    .all(project)
    .map((row) => row.module)
}

export class MessageMutes {
  constructor(
    private readonly db: Database,
    private readonly clock: () => number = () => Date.now(),
  ) {
    ensureMessageMutes(db)
  }

  /** The modules muted in this project, sorted. */
  muted(project: number): string[] {
    return mutedIn(this.db, project)
  }

  /** Whether this module's own messages are muted in this project. */
  has(project: number, module: string): boolean {
    return this.db.query<{ n: number }, [number, string]>('select 1 as n from messages_muted where project = ? and module = ?').get(project, module) !== null
  }

  /** Mute or unmute one module in one project: the person's act. Answers whether anything changed. */
  set(project: number, module: string, muted: boolean): { changed: boolean } {
    const id = module
    const was = this.has(project, id)
    if (was === muted) return { changed: false }
    if (muted) this.db.query('insert into messages_muted (project, module, at) values (?, ?, ?)').run(project, id, this.clock())
    else this.db.query('delete from messages_muted where project = ? and module = ?').run(project, id)
    return { changed: true }
  }
}
