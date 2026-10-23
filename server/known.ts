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
  /* The icon a module declared (protocol 2.14.0): what it IS, like its name. */
  if (!has.has('icon')) db.exec('alter table known_modules add column icon text')
  /* What its manifest said it reacts to, null for never seen. Kept for one reason: a module that shows
     pages (`reacts: ['address']`) and is still starting is where an address waits, not a reason to
     tell the person that nothing shows pages. It is what the module IS, as the name is. */
  if (!has.has('reacts')) db.exec('alter table known_modules add column reacts text')
  db.exec(`
    create table if not exists known_doors (
      id        text primary key,
      path      text not null,
      transport text not null,
      as_name   text,
      seen      integer not null
    )
  `)
}

/** What the host keeps about a module for when it is not answering. */
export interface Known {
  name: string
  summary: string
  /** Most fitting first, as the manifest gave them. */
  tags: string[]
  /** The icon key its manifest declared, or null for none. */
  icon: string | null
  /** The context kinds its manifest said it reacts to, or null when it was never seen answering. */
  reacts: string[] | null
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
  about: { summary?: string; tags?: readonly string[]; icon?: string | null; reacts?: readonly string[] } = {},
  now = Date.now(),
): void {
  if (!id || !name) return
  db.query(
    `insert into known_modules (id, name, summary, tags, icon, reacts, seen) values (?, ?, ?, ?, ?, ?, ?)
     on conflict(id) do update set name = excluded.name, summary = excluded.summary, tags = excluded.tags, icon = excluded.icon,
       reacts = coalesce(excluded.reacts, known_modules.reacts), seen = excluded.seen`,
  ).run(id, name, about.summary ?? '', JSON.stringify(about.tags ?? []), about.icon ?? null, about.reacts ? JSON.stringify(about.reacts) : null, now)
}

/** Everything the host has been told, by module id. */
export function known(db: Database): Map<string, Known> {
  const rows = db
    .query<{ id: string; name: string; summary: string; tags: string; icon: string | null; reacts: string | null }, []>(
      'select id, name, summary, tags, icon, reacts from known_modules',
    )
    .all()
  return new Map(
    rows.map((row) => [
      row.id,
      { name: row.name, summary: row.summary, tags: tagsIn(row.tags), icon: row.icon ?? null, reacts: row.reacts === null ? null : tagsIn(row.reacts) },
    ]),
  )
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
  for (const id of knownDoors(db).keys()) {
    if (!keep.has(id)) forgetDoor(db, id)
  }
}

/**
 * Where a module's MCP door was, the last time it was running.
 *
 * ## Why this one is remembered, when the tools are not
 *
 * The essay above refuses to repeat for a sleeping module what it OFFERS. The
 * door is remembered for one use that is not a claim of that kind: keeping an
 * entry in the person's agent (Settings, `agentSync.ts`) while the module is
 * stopped, so a module that sleeps most of the time is not one the agent
 * forgets most of the time. Nothing says the module is answering because its
 * door is remembered; the Settings line says "connected (not running now)".
 *
 * ## What is kept, and why not the address
 *
 * The door's PATH on the module's origin, its transport and the name it asks
 * for (`mcp.as`). Not the url: a door is same-origin by the protocol
 * (`resolveOnOrigin`), and the origin is the registration's, which a module's
 * start script rewrites when it has to move port. So the address is derived
 * every time from the registration as it is now (`doorAt`), and a module that
 * moved while asleep is pointed at where it will answer.
 *
 * ## Why not read it without the module ever having run
 *
 * The registration says only where a module answers, and a manifest is built
 * by the module's own code (`manifest.ts`), not a file a host can read without
 * running it. Reading that source as text would be guessing at a program. So a
 * module never seen running has no door here until its first run.
 *
 * Replaced on every sweep that reads a manifest; forgotten when the running
 * module declares no door, and with its registration.
 */
export interface KnownDoor {
  path: string
  transport: string
  /** The name its manifest asks for, or null for the one its id derives. */
  as: string | null
}

export function rememberDoor(db: Database, id: string, door: KnownDoor, now = Date.now()): void {
  if (!id || !door.path || !door.transport) return
  db.query(
    `insert into known_doors (id, path, transport, as_name, seen) values (?, ?, ?, ?, ?)
     on conflict(id) do update set path = excluded.path, transport = excluded.transport, as_name = excluded.as_name, seen = excluded.seen`,
  ).run(id, door.path, door.transport, door.as, now)
}

export function forgetDoor(db: Database, id: string): void {
  db.query('delete from known_doors where id = ?').run(id)
}

export function knownDoors(db: Database): Map<string, KnownDoor> {
  const rows = db
    .query<{ id: string; path: string; transport: string; as_name: string | null }, []>('select id, path, transport, as_name from known_doors')
    .all()
  return new Map(rows.map((row) => [row.id, { path: row.path, transport: row.transport, as: row.as_name }]))
}

/** What a running module's manifest says of its door, as kept: the path of its resolved url. */
export function doorKept(mcp: { url: string; transport: string; as?: string }): KnownDoor | null {
  try {
    const url = new URL(mcp.url)
    return { path: `${url.pathname}${url.search}`, transport: mcp.transport, as: mcp.as ?? null }
  } catch {
    return null
  }
}

/** The address a remembered door has now: its path on the registration's origin. Null when they do not make one. */
export function doorAt(origin: string, door: KnownDoor): string | null {
  try {
    const base = new URL(origin)
    const url = new URL(door.path, base)
    return url.origin === base.origin ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * A stopped module's door as a manifest would have said it: the remembered
 * path at the registration's origin now, with its transport and name. Null when
 * nothing is remembered or the two do not make an address.
 */
export function rememberedMcp(
  kept: KnownDoor | undefined,
  origin: string | undefined,
): { url: string; transport: string; as?: string } | null {
  const url = kept && origin ? doorAt(origin, kept) : null
  return kept && url ? { url, transport: kept.transport, ...(kept.as ? { as: kept.as } : {}) } : null
}
