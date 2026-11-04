import type { Database } from 'bun:sqlite'
import { PERSON_MESSAGES_SETTING } from 'kehikot-module-protocol'

/**
 * Which modules the person allowed to send messages AS THEM (protocol 2.50.0,
 * `messages:as-person`, `PERSON_MESSAGES_SETTING`).
 *
 * The setting is the module's — declared by it, kept in its own store — but a
 * module's store is a file any program on this machine can write, and an agent
 * session that edits it must not be able to make its words the person's. So
 * this host keeps its OWN record of the grant, and writes it only when it
 * relays the person's change of that setting from its own settings form
 * (`/host/module-settings/set`, `PAGE_ONLY`) and the module took it. Nothing
 * else writes here: not the module's word, not a file, not a door. Per machine,
 * like the setting; in `frame.sqlite`, never in a project.
 */

export function ensurePersonGrants(db: Database): void {
  db.exec(`
    create table if not exists person_message_grants (
      module text primary key,
      at     integer not null
    )
  `)
}

export class PersonGrants {
  constructor(
    private readonly db: Database,
    private readonly clock: () => number = () => Date.now(),
  ) {
    ensurePersonGrants(db)
  }

  /** Whether the person allowed this module, as this host saw them do it. */
  granted(module: string): boolean {
    return this.db.query<{ n: number }, [string]>('select count(*) as n from person_message_grants where module = ?').get(module)!.n > 0
  }

  /**
   * A change of a module's setting that this host relayed for the person and
   * the module saved. Only `PERSON_MESSAGES_SETTING`'s key moves the record, and
   * only a boolean: `true` grants, anything else takes it back.
   */
  saw(module: string, key: string, value: unknown): void {
    if (key !== PERSON_MESSAGES_SETTING.key) return
    if (value === true) {
      this.db.query('insert into person_message_grants (module, at) values (?, ?) on conflict (module) do update set at = excluded.at').run(module, this.clock())
    } else {
      this.db.query('delete from person_message_grants where module = ?').run(module)
    }
  }
}
