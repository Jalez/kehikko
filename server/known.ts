import type { Database } from 'bun:sqlite'

/**
 * What a module called itself, the last time it was awake enough to say.
 *
 * ## The gap this closes, which lazy activation opened
 *
 * A module's name comes from the manifest it serves. Before modules slept, that
 * was a distinction without a difference: everything was always running, so
 * every presence had a name and nobody noticed where it came from.
 *
 * Now most modules are asleep most of the time, and an asleep module serves
 * nothing. So the host had no name for them, and the page fell back to the id —
 * a canvas of containers labelled `roadmap.checklist`, `roadmap.notes`,
 * `roadmap.paper`. Correct, in the sense that the host genuinely did not know;
 * useless, because the person reading it knows those are Checklist, Notes and
 * Paper, and so does the host, which read them an hour ago.
 *
 * ## Why remembering is honest here, when caching usually is not
 *
 * This codebase refuses to state things it cannot vouch for — `epics.list`
 * answers empty rather than guessing, `no-such-target` is refused because the
 * host holds no epics. Remembering a name looks like the same sin and is not,
 * for one reason: **a name is not a claim about what is true now.** "This is
 * called Paper" was true when it was read and does not go stale the way
 * "this module is answering" does. The presence still says `silent` or
 * `asleep`; the name only says what to call the thing that is not answering.
 *
 * The line is worth holding, so what is remembered is deliberately thin: the
 * name, and nothing else. Not the summary, not the guidance, not the tools, not
 * the protocol range — those ARE claims about what a module currently offers,
 * and a host repeating them for a program that is not running would be
 * answering for it. A person needs to know which container is which. They do
 * not need a sleeping module's description of itself.
 *
 * Kept in the host's own database rather than written back into the
 * registration file, because the registration is the person's — they wrote it,
 * and a host that edited it to cache something would be taking a file somebody
 * maintains and putting its own bookkeeping in it.
 */

export function ensureKnown(db: Database): void {
  db.exec(`
    create table if not exists known_modules (
      id    text primary key,
      name  text not null,
      seen  integer not null
    )
  `)
}

/**
 * Remember what a module answered with.
 *
 * Called for every presence that came back with a name, on every sweep, so the
 * memory follows a module that has been renamed rather than pinning the first
 * answer it ever gave.
 */
export function remember(db: Database, id: string, name: string, now = Date.now()): void {
  if (!id || !name) return
  db.query('insert into known_modules (id, name, seen) values (?, ?, ?) on conflict(id) do update set name = excluded.name, seen = excluded.seen')
    .run(id, name, now)
}

/** Every name the host has been told, by module id. */
export function known(db: Database): Map<string, string> {
  const rows = db.query<{ id: string; name: string }, []>('select id, name from known_modules').all()
  return new Map(rows.map((row) => [row.id, row.name]))
}

/**
 * Forget a module the host no longer has a registration for.
 *
 * Not strictly necessary — an id nobody asks about costs one row — but a table
 * that only grows is a table that eventually holds the name of every experiment
 * somebody ever registered, and the one place it would surface is a list of
 * things that no longer exist.
 */
export function forgetUnregistered(db: Database, ids: readonly string[]): void {
  const keep = new Set(ids)
  for (const id of known(db).keys()) {
    if (!keep.has(id)) db.query('delete from known_modules where id = ?').run(id)
  }
}
