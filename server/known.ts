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
 * a canvas of containers labelled `kehikot.checklist`, `kehikot.notes`,
 * `kehikot.paper`. Correct, in the sense that the host genuinely did not know;
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
 * name, the one-line summary and the tags. All three say what a module IS, for
 * a person choosing one from a list, and none of them goes stale by the module
 * stopping. Not the guidance, not the tools, not the protocol range — those ARE
 * claims about what a module currently offers, and a host repeating them for a
 * program that is not running would be answering for it.
 *
 * The summary and the tags were not remembered at first, and the module list
 * is why they are now. Most modules are asleep most of the time, so a list
 * that could describe only the running ones described almost nothing, and
 * filled the gap with a sentence about why each one was not answering. A list
 * also cannot be grouped by category when the category is known only for
 * whatever happens to be awake.
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
  /* Two columns newer than the table. A database made before them gains them
     here, empty, and the next sweep that finds the module awake fills them. */
  const has = new Set(db.query<{ name: string }, []>('pragma table_info(known_modules)').all().map((c) => c.name))
  if (!has.has('summary')) db.exec("alter table known_modules add column summary text not null default ''")
  if (!has.has('tags')) db.exec("alter table known_modules add column tags text not null default '[]'")
}

/** What the host keeps about a module for when it is not answering. */
export interface Known {
  name: string
  summary: string
  /** Most fitting first, as the manifest gave them. */
  tags: string[]
}

/**
 * Remember what a module answered with.
 *
 * Called for every presence that came back with a name, on every sweep, so the
 * memory follows a module that has been renamed rather than pinning the first
 * answer it ever gave.
 */
export function remember(
  db: Database,
  id: string,
  name: string,
  about: { summary?: string; tags?: readonly string[] } = {},
  now = Date.now(),
): void {
  if (!id || !name) return
  db.query(
    `insert into known_modules (id, name, summary, tags, seen) values (?, ?, ?, ?, ?)
     on conflict(id) do update set name = excluded.name, summary = excluded.summary, tags = excluded.tags, seen = excluded.seen`,
  ).run(id, name, about.summary ?? '', JSON.stringify(about.tags ?? []), now)
}

/** Everything the host has been told, by module id. */
export function known(db: Database): Map<string, Known> {
  const rows = db
    .query<{ id: string; name: string; summary: string; tags: string }, []>('select id, name, summary, tags from known_modules')
    .all()
  return new Map(rows.map((row) => [row.id, { name: row.name, summary: row.summary, tags: tagsIn(row.tags) }]))
}

function tagsIn(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text)
    return Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []
  } catch {
    return []
  }
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
