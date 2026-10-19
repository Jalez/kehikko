import type { Database } from 'bun:sqlite'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { KEHIKOT_DIR, MODULE_ID } from 'kehikot-module-protocol'

import { dataVersionsFile } from './dataVersions.ts'
import { hostRoot } from './hostData.ts'
import { kehikotFile } from './kehikot.ts'
import { modulesDir } from './machineDirs.ts'

/**
 * The leftovers from before the app was called Kehikot, cleaned up once, at
 * start. Delete this file (and its call in `server.ts`, its test and the
 * `remedy` sentence in `discover.ts`) in a later release: after 2027-01-01, or
 * once every machine has started a host with it.
 *
 * ## Why
 *
 * The app was called "roadmap", and module ids were `roadmap.<name>`. Hosts
 * from the rename until eaafa6c read an old id as the new one AND respelled
 * what they had stored. eaafa6c ("one spelling of a module id") removed all of
 * that and added no clean-up, so a machine that never ran one of those hosts
 * is stranded: its registry still holds `roadmap.checklist.json`, the module
 * there calls itself `kehikot.checklist`, and the modules list says the two
 * disagree — with advice (start it again) that cannot work.
 *
 * ## What this is not
 *
 * Not an alias. Nothing here runs after start, and nothing else in the host
 * knows the old prefix: the stored leftovers are migrated to the new name and
 * from then on the host sees only `kehikot.<name>`. A `roadmap.<name>` id that
 * arrives in a request is just another id.
 *
 * ## What it migrates
 *
 * 1. Registrations: `roadmap.<name>.json|yaml|yml` in the registry
 *    (`modulesDir`), and in the retired `~/.roadmap/modules` (read only),
 *    become `kehikot.<name>.<ext>` in the registry. A twin already there is
 *    kept unless the old file is newer (the twin is then set aside as
 *    `.replaced`, never deleted). The old file in the registry is renamed to
 *    `<file>.migrated`. A module checkout from before the rename may write
 *    its old file again on every start; the next host start repeats this.
 * 2. Each known project's `.kehikot/roadmap/{epics,state}` is copied to
 *    the host's folder (`.kehikot/host/`, `.kehikot/kehikko/` before protocol
 *    2.2.0) when that does not exist yet (the copy the hosts
 *    before eaafa6c made), and the module ids in its `kehikot.json` and
 *    `data-versions.json` are respelled — ids only.
 * 3. `frame.sqlite`: every column that holds a module id is respelled, in one
 *    transaction, only when it holds an old one. A cache row whose new twin
 *    already exists is dropped.
 *
 * Idempotent, and it copies before it changes. One line is logged per thing
 * migrated.
 */

/** The prefix module ids carried before the rename. Spelled here and nowhere else in the host. */
const BEFORE = 'roadmap.'
/** The prefix they carry now. */
const AFTER = 'kehikot.'

type Env = Record<string, string | undefined>
type Log = (line: string) => void

/** The new id for an old one, or null when it is not an old id (or would not be an id). */
function respelled(id: string): string | null {
  if (!id.startsWith(BEFORE)) return null
  const now = AFTER + id.slice(BEFORE.length)
  return MODULE_ID.test(now) ? now : null
}

/**
 * Everything, in the order it has to happen: the files first, so the database
 * respelled last is not then refilled from a project file that still says the
 * old ids. Called once in `server.ts`, before registrations are read and before
 * any project's `kehikot.json` is synced into the database.
 */
export function forgetFormerName(db: Database, env: Env = process.env, log: Log = (line) => console.log(`kehikko: ${line}`)): string[] {
  const lines: string[] = []
  const say = (line: string) => {
    lines.push(line)
    log(line)
  }
  const step = (what: string, run: () => void) => {
    try {
      run()
    } catch (error) {
      say(`could not finish migrating ${what} from before the rename: ${(error as Error).message}`)
    }
  }
  step('registrations', () => migrateRegistrations(env, say))
  step('projects', () => {
    for (const { path } of db.query<{ path: string }, []>('select path from projects').all()) migrateProject(path, say)
  })
  step('the canvases database', () => migrateDatabase(db, say))
  return lines
}

/* ---- 1. registrations ---- */

const OLD_FILE = /^roadmap\.(.+)\.(json|ya?ml)$/
const EXTENSIONS = ['json', 'yaml', 'yml'] as const

/** `~/.roadmap/modules`, where registrations lived before the machine directory. Read, never written. */
export function formerRegistryDir(env: Env = process.env): string {
  const home = env.HOME || homedir()
  return join(home, '.roadmap', 'modules') // kehikot-storage: allow read-only, once at start: registrations from before the rename, copied into the registry (server/formerName.ts)
}

/** Whole milliseconds, as `registrations.ts` compares them. */
function mtime(file: string): number {
  return Math.floor(statSync(file).mtimeMs)
}

/** A free name beside `file` ending in `suffix`, for setting it aside without losing an earlier one. */
function aside(file: string, suffix: string): string {
  const plain = `${file}${suffix}`
  return existsSync(plain) ? `${plain}.${Date.now()}` : plain
}

/** Written beside and renamed into place, with the source's time, so a second run finds the two tied. */
function writeLike(dest: string, body: string, time: number): void {
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = `${dest}.tmp`
  writeFileSync(tmp, body)
  utimesSync(tmp, time / 1000, time / 1000)
  renameSync(tmp, dest)
}

export function migrateRegistrations(env: Env, say: Log): void {
  const registry = modulesDir(env)
  for (const source of [registry, formerRegistryDir(env)]) {
    let names: string[]
    try {
      names = readdirSync(source)
    } catch {
      continue
    }
    const inRegistry = source === registry
    for (const name of names.sort()) {
      const match = OLD_FILE.exec(name)
      if (!match) continue
      const was = `${BEFORE}${match[1]}`
      const now = respelled(was)
      if (!now) continue
      const ext = match[2]!
      const file = join(source, name)
      const body = readFileSync(file, 'utf8')
      const time = mtime(file)
      const from = inRegistry ? was : `${was} (from ${source})`

      const twins = EXTENSIONS.map((e) => join(registry, `${now}.${e}`)).filter((f) => existsSync(f))
      const newest = twins.reduce((best, twin) => Math.max(best, mtime(twin)), -Infinity)
      if (twins.length === 0) {
        writeLike(join(registry, `${now}.${ext}`), body, time)
        say(`renamed registration ${from} → ${now}`)
      } else if (time > newest) {
        for (const twin of twins) renameSync(twin, aside(twin, '.replaced'))
        writeLike(join(registry, `${now}.${ext}`), body, time)
        say(`renamed registration ${from} → ${now}, over an older ${now} (set aside as .replaced)`)
      } else if (inRegistry) {
        say(`kept registration ${now}; the older ${was} is set aside`)
      }
      /* The old file in the registry is set aside, never deleted; `~/.roadmap` is left exactly as it is. */
      if (inRegistry) renameSync(file, aside(file, '.migrated'))
    }
  }
}

/* ---- 2. projects ---- */

export function migrateProject(root: string, say: Log): void {
  copyHostData(root, say)
  respellKehikot(root, say)
  respellDataVersions(root, say)
}

/** `.kehikot/roadmap/{epics,state}` → the host's folder (`.kehikot/host/`), copied into a temporary sibling and renamed into place. */
function copyHostData(root: string, say: Log): void {
  for (const name of ['epics', 'state']) {
    const before = join(root, KEHIKOT_DIR, 'roadmap', name)
    const now = join(hostRoot(root), name)
    if (existsSync(now) || !isDir(before)) continue
    const tmp = `${now}.copying`
    mkdirSync(dirname(now), { recursive: true })
    cpSync(before, tmp, { recursive: true, force: true })
    renameSync(tmp, now)
    say(`copied ${before} → ${now}`)
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

/** The fields of a container in `kehikot.json` that hold a module id, and nothing else. */
const ID_FIELD = /("(?:module|promptFor)"\s*:\s*")(roadmap\.[a-z0-9.-]+)(")/g

interface FileContainer {
  module?: unknown
  promptFor?: unknown
}

export function respellKehikot(root: string, say: Log): void {
  const file = kehikotFile(root)
  if (!file) return
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  if (!text.includes(`"${BEFORE}`)) return

  /* In place, so the file keeps its layout and every other character. */
  let count = 0
  const swapped = text.replace(ID_FIELD, (whole, open: string, id: string, close: string) => {
    const now = respelled(id)
    if (!now) return whole
    count++
    return `${open}${now}${close}`
  })
  if (count === 0) return
  let parsed: { kehikot?: Array<{ containers?: FileContainer[] }> }
  try {
    parsed = JSON.parse(swapped)
  } catch {
    say(`left ${file} as it is: it does not read as JSON, so its module ids from before the rename were not respelled`)
    return
  }

  /* One kehikko holding a module under both names: the new one is kept, the
     old container dropped, and the file written whole. */
  const twice = (parsed.kehikot ?? []).some((k) => {
    const ids = (k.containers ?? []).map((c) => c.module)
    return new Set(ids).size !== ids.length
  })
  if (twice) {
    const original = JSON.parse(text) as typeof parsed
    let dropped = 0
    for (const k of original.kehikot ?? []) {
      const have = new Set((k.containers ?? []).map((c) => c.module))
      k.containers = (k.containers ?? []).filter((c) => {
        const now = typeof c.module === 'string' ? respelled(c.module) : null
        if (now && have.has(now)) {
          dropped++
          return false
        }
        return true
      })
      for (const c of k.containers) {
        const m = typeof c.module === 'string' ? respelled(c.module) : null
        if (m) c.module = m
        const p = typeof c.promptFor === 'string' ? respelled(c.promptFor) : null
        if (p) c.promptFor = p
      }
    }
    writeAtomic(file, `${JSON.stringify(original, null, 2)}\n`)
    say(`respelled module ids from before the rename in ${file}, dropping ${dropped} container(s) already there under the new name`)
    return
  }
  writeAtomic(file, swapped)
  say(`respelled ${count} module id(s) from before the rename in ${file}`)
}

export function respellDataVersions(root: string, say: Log): void {
  const file = dataVersionsFile(root)
  if (!file) return
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const entries = Object.entries(raw as Record<string, unknown>)
  if (!entries.some(([id]) => respelled(id))) return
  const out: Record<string, unknown> = {}
  for (const [id, value] of entries) if (!respelled(id)) out[id] = value
  let count = 0
  for (const [id, value] of entries) {
    const now = respelled(id)
    if (!now) continue
    count++
    const held = out[now]
    /* The higher number wins: it never goes down (see `dataVersions.ts`). */
    out[now] = typeof held === 'number' && typeof value === 'number' ? Math.max(held, value) : (held ?? value)
  }
  writeAtomic(file, `${JSON.stringify(out, null, 2)}\n`)
  say(`respelled ${count} module id(s) from before the rename in ${file}`)
}

/* ---- 3. the canvases database ---- */

/**
 * Every column in `frame.sqlite` that holds a module id. `keyed` when the
 * column is part of the row's key, so a respelled row can collide with its
 * new twin — that twin is kept and the old row, a cache row, dropped.
 */
const COLUMNS: ReadonlyArray<{ table: string; column: string; keyed: boolean }> = [
  { table: 'placements', column: 'module', keyed: true },
  { table: 'placements', column: 'prompt_for', keyed: false },
  { table: 'module_state', column: 'module', keyed: true },
  { table: 'known_modules', column: 'id', keyed: true },
  { table: 'inbox_items', column: 'module', keyed: true },
  { table: 'inbox_moves', column: 'module', keyed: false },
]

export function migrateDatabase(db: Database, say: Log): void {
  const present = COLUMNS.filter(({ table, column }) =>
    db.query<{ name: string }, [string]>('select name from pragma_table_info(?)').all(table).some((c) => c.name === column),
  )
  const old = `substr(%s, 1, ${BEFORE.length}) = '${BEFORE}'`
  const holding = present.filter(
    ({ table, column }) => db.query(`select 1 from ${table} where ${old.replaceAll('%s', column)} limit 1`).get() !== null,
  )
  if (holding.length === 0) return
  const done: string[] = []
  db.transaction(() => {
    for (const { table, column, keyed } of holding) {
      const where = old.replaceAll('%s', column)
      const moved = db.run(
        `update or ignore ${table} set ${column} = '${AFTER}' || substr(${column}, ${BEFORE.length + 1}) where ${where}`,
      ).changes
      if (moved) done.push(`respelled ${moved} ${table}.${column} value(s) from before the rename`)
      if (keyed) {
        const dropped = db.run(`delete from ${table} where ${where}`).changes
        if (dropped) done.push(`dropped ${dropped} ${table} row(s) from before the rename already there under the new name`)
      }
    }
  })()
  for (const line of done) say(line)
}

/* ---- the one sentence it cannot fix ---- */

/**
 * For `look` in `discover.ts`: the sentence for a registration file from before
 * the rename whose program calls itself by the new name — one written after
 * this host started, by a module checkout from before the rename. Null for any
 * other mismatch, which keeps the ordinary sentence.
 */
export function formerRegistration(registration: { id: string; url: string; file: string }, calls: string): string | null {
  if (respelled(registration.id) !== calls) return null
  const name = basename(registration.file)
  const ext = /\.(json|ya?ml)$/i.exec(name)?.[0] ?? '.json'
  return (
    `The registration ${name} in ${dirname(registration.file)} is from before Kehikot was renamed: the program at ${registration.url} is ${calls}. `
    + `Rename the file to ${calls}${ext}; Kehikot also renames it the next time it starts.`
  )
}
