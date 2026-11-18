import { spawn } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import { LIMITS, UNINSTALL_SCRIPT, moduleDir, readUninstallReport, type UninstallReport } from 'kehikot-module-protocol'

import { readDevelopment, writeDevelopment } from './development.ts'
import { INCOMING, PREVIOUS, sizeSaid } from './moduleBundles.ts'
import { logFile } from './moduleLog.ts'
import { idOfFile } from './registrations.ts'

/**
 * Uninstall: everything Kehikot put on this computer for a module, gone on one press.
 *
 * ## What the person expects
 *
 * "Uninstall" is not "unregister". A person who presses it means the module is gone: not running,
 * not listed, its copy and its logs not taking space, nothing of it left in their agent. They also
 * expect two things never to happen: a folder of their own deleted, and their work lost. So:
 *
 * ## What it removes, in this order
 *
 *  1. **It is stopped**: the child this host holds, by its handle (`deps.stop`), and any pinned
 *     version it runs (`deps.stopVersions`). Something answering that this host did not start is
 *     refused before anything is touched — it is somebody's own process.
 *  2. **Its own clean-up runs** (protocol 2.108.0, `uninstall.ts` in its folder): what the MODULE
 *     wrote outside its folder — an entry in an agent's settings, skills it copied, session folders —
 *     only it knows, and the host never edits an agent's configuration for it. Its report is said.
 *  3. **Its registration** (every file in the registry that names it).
 *  4. **What Kehikot keeps for it on this machine**: `installed/<id>/`, `installed/.previous/<id>/`,
 *     leftovers under `installed/.incoming/<id>-…`, the pinned versions under `versions/<id>/`, its
 *     logs (`<logs>/modules/<id>.log` and its versions' `<id>@<tag>.log`).
 *  5. **Its machine-level records in `frame.sqlite`** (`forgetModule`): the views it kept per
 *     container and in all, the person's grants and switches for it, its Inbox items and their
 *     history, the door tokens of its sessions, its sessions' read places, the doors and names
 *     remembered for it, and its development folder. What is NOT removed there, and why: the
 *     containers on kehikot (they live in projects and travel; they show "Module removed" with
 *     Reinstall), the messages its sessions sent (they are other sessions' conversations), and the
 *     "left because you changed it" notes about skills (so that is not said again).
 *  6. **What the host itself made for it in the agent** — the tools entry and skills the agent setup
 *     installed (`deps.agentTidy`): the agent sync removes those for a module no longer registered,
 *     and only those it can prove are its own (its record of what it made, a skill's marker).
 *
 * ## What it never removes
 *
 *  - **A folder of the person's own.** A registration that names a checkout is unregistered, and the
 *    summary says "Kehikot no longer uses <folder>; it's yours to keep or remove."
 *  - **Project data** (`<project>/.kehikot/<module>/`), unless the person ticked "Also remove its
 *    saved data in N projects" in the confirmation (`projects: true`), which lists them with sizes.
 *
 * ## Said in words
 *
 * The answer is a summary: what was removed, the space freed, and what was left and why.
 *
 * The host names no module here; every id and word arrives from the registry, the list or the module.
 */

export interface UninstallRegistration {
  id: string
  url: string
  dir?: string | undefined
}

/** What one module's own clean-up came to. */
export type CleanUpRan = { ran: false } | { ran: true; report: UninstallReport | null; why?: string }

export interface UninstallDeps {
  db: Database
  /** `installed/`, where this host puts what it installs. */
  installed: string
  /** `versions/`, where pinned versions are materialised. */
  versions: string
  /** `logsDir()`. */
  logs: string
  /** Where registrations are. */
  registry: string
  registered(): Promise<UninstallRegistration[]>
  /** The module's name as the person knows it. */
  nameOf(id: string): string
  /** Every project this host knows, with its folder. */
  projects(): { id: number; name: string; path: string }[]
  /** An update, install, start or restart of it is in hand. */
  busy(id: string): boolean
  /** Stop the module this host holds, by its handle, and wait for its address to come free. Refuses one it did not start. */
  stop(id: string, registration: UninstallRegistration): Promise<{ ok: true } | { ok: false; why: string }>
  /** Stop every pinned version of it this host runs. */
  stopVersions(id: string): void
  /** Run the module's own clean-up in `dir`. Tests pass their own; the server's is `runCleanUp`. */
  cleanUp(dir: string, id: string): Promise<CleanUpRan>
  /** Whether the module, as last seen, ran agent sessions (and so wrote outside its folder). */
  agentModule(id: string): boolean
  /** The registry changed: sweep, and let the pages look again. */
  registryChanged(): Promise<void> | void
  /** After the registration is gone: what the host itself had made in the agent for it, removed. Each line says one thing. */
  agentTidy(): Promise<string[]>
  /** Every Inbox item of the module, and their history, taken out of every project, and the pages told (`Inbox.forgetAll`). */
  forgetInbox(id: string): void
  log(line: string): void
}

export interface UninstallItem {
  what: string
  path?: string
  bytes?: number
}
export interface UninstallLeftItem {
  what: string
  path?: string
  why: string
}

export interface Uninstalled {
  ok: true
  id: string
  name: string
  removed: UninstallItem[]
  left: UninstallLeftItem[]
  /** Bytes freed on disk. */
  freed: number
  /** The person's own folder it ran from, kept. */
  own?: string
  /** The whole of it in words. */
  said: string
}
export type UninstallOutcome = Uninstalled | { ok: false; why: string; status: number }

/** What the confirmation shows before the press. */
export interface UninstallPreview {
  ok: true
  id: string
  name: string
  /** The person's own folder it runs from; never deleted. */
  own?: string
  /** What Kehikot keeps for it on this machine, in bytes. */
  bytes: number
  /** Its saved data in projects, for the checkbox. */
  projects: { id: number; name: string; path: string; bytes: number }[]
  /** It brings its own clean-up (protocol 2.108.0). */
  cleanUp: boolean
}

const ID = /^[a-z0-9][\w.-]{0,63}$/i

const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Bytes a file or folder takes, never following a link. Zero for nothing there. */
export function sizeOf(path: string): number {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return 0
  }
  if (!stat.isDirectory()) return stat.size
  let total = 0
  let names: string[] = []
  try {
    names = readdirSync(path)
  } catch {
    return 0
  }
  for (const name of names) total += sizeOf(join(path, name))
  return total
}

/** Whether a registration's directory is somebody's own checkout rather than the copy under `installed/<id>/`. No directory is not a copy of ours. */
export function isOwnCheckout(dir: string | undefined, copy: string): boolean {
  return dir === undefined || real(dir) !== real(copy)
}

/** The places Kehikot keeps for a module on this machine, each with the words for it. */
export function placesOf(id: string, at: Pick<UninstallDeps, 'installed' | 'versions' | 'logs'>): { what: string; path: string }[] {
  const out: { what: string; path: string }[] = [
    { what: 'The copy Kehikot installed', path: join(at.installed, id) },
    { what: 'The version kept for rolling back', path: join(at.installed, PREVIOUS, id) },
  ]
  const incoming = join(at.installed, INCOMING)
  for (const name of list(incoming)) if (name.startsWith(`${id}-`)) out.push({ what: 'A download that was never finished', path: join(incoming, name) })
  out.push({ what: 'The versions kept for pinned containers', path: join(at.versions, id) })
  const own = logFile(id, at.logs)
  const logs = join(at.logs, 'modules')
  const stem = own.slice(logs.length + 1, -'.log'.length)
  for (const name of list(logs)) {
    if (name === `${stem}.log` || name.startsWith(`${stem}.log.`) || (name.startsWith(`${stem}@`) && name.endsWith('.log'))) out.push({ what: 'Its log', path: join(logs, name) })
  }
  return out
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

/** Delete from a table that may not exist in this database. The count deleted. */
function drop(db: Database, sql: string, ...values: (string | number)[]): number {
  try {
    return db.query(sql).run(...values).changes
  } catch {
    return 0
  }
}

/**
 * A module's machine-level records in `frame.sqlite`, removed: the count. Containers, the messages its
 * sessions sent and the notes about skills left in place are kept (see the file's comment for why).
 */
export function forgetModule(db: Database, id: string): number {
  let count = 0
  for (const table of ['module_state', 'container_state', 'inbox_muted', 'person_message_grants', 'messages_muted', 'door_tokens', 'agent_message_cursors', 'agent_message_once', 'agent_message_tells']) {
    count += drop(db, `delete from ${table} where module = ?`, id)
  }
  count += drop(db, 'delete from known_modules where id = ?', id)
  count += drop(db, 'delete from known_doors where id = ?', id)
  const dev = readDevelopment(db)
  if (dev && (dev.folders[id] || dev.seen?.[id] !== undefined)) {
    const { [id]: _folder, ...folders } = dev.folders
    const { [id]: _seen, ...seen } = dev.seen ?? {}
    writeDevelopment(db, { ...dev, folders, seen })
    count += 1
  }
  return count
}

/* ---- the modules that were uninstalled, for their containers ---- */

export function ensureUninstalled(db: Database): void {
  db.exec(`
    -- A module uninstalled on this computer, by name, so its containers say "Module removed" with Reinstall.
    create table if not exists uninstalled_modules (
      id   text primary key,
      name text not null,
      at   integer not null
    )
  `)
}

/** The modules uninstalled here and not registered again, newest first. */
export function uninstalledModules(db: Database, registered: ReadonlySet<string>): { id: string; name: string; at: number }[] {
  ensureUninstalled(db)
  const rows = db.query<{ id: string; name: string; at: number }, []>('select id, name, at from uninstalled_modules order by at desc').all()
  for (const row of rows) if (registered.has(row.id)) db.query('delete from uninstalled_modules where id = ?').run(row.id)
  return rows.filter((row) => !registered.has(row.id))
}

function recordUninstalled(db: Database, id: string, name: string, at: number): void {
  ensureUninstalled(db)
  db.query('insert into uninstalled_modules (id, name, at) values (?, ?, ?) on conflict (id) do update set name = excluded.name, at = excluded.at').run(id, name, at)
}

/* ---- the words ---- */

/** The summary a person reads after Uninstall. Pure. */
export function uninstallSaid(name: string, removed: readonly UninstallItem[], left: readonly UninstallLeftItem[], freed: number, own?: string): string {
  const parts: string[] = []
  const things = removed.map((one) => one.what.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase()))
  parts.push(
    things.length
      ? `${name} is uninstalled. Removed: ${[...new Set(things)].join('; ')}.${freed > 0 ? ` ${sizeSaid(freed)} freed.` : ''}`
      : `${name} is uninstalled.`,
  )
  if (own) parts.push(`Kehikot no longer uses ${own}; it's yours to keep or remove.`)
  for (const one of left) parts.push(`Left: ${one.what.replace(/\.$/, '')}${one.path ? ` (${one.path})` : ''}, because ${one.why.replace(/\.$/, '')}.`)
  return parts.join(' ')
}

/* ---- running a module's own clean-up ---- */

const secondsSaid = (ms: number): string => {
  const n = Math.max(1, Math.round(ms / 1000))
  return `${n} second${n === 1 ? '' : 's'}`
}

/**
 * Run `uninstall.ts` in `dir` with `bun`, for at most `LIMITS.UNINSTALL_MS`, and read its report.
 * `env` is the environment the host starts the module with.
 */
export function runCleanUp(dir: string, bun: string, env: Record<string, string | undefined>, timeoutMs: number = LIMITS.UNINSTALL_MS): Promise<CleanUpRan> {
  if (!existsSync(join(dir, UNINSTALL_SCRIPT))) return Promise.resolve({ ran: false })
  return new Promise((done) => {
    let out = ''
    let finished = false
    const child = spawn(bun, [UNINSTALL_SCRIPT], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    const timer = setTimeout(() => {
      if (finished) return
      try {
        child.kill('SIGKILL')
      } catch {
        /* Gone. */
      }
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (out.length < 1024 * 1024) out += chunk.toString('utf8')
    })
    let err = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      err = (err + chunk.toString('utf8')).slice(-4000)
    })
    /* The last thing it said on stderr, for a failure's sentence. */
    const said = () => err.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 200) ?? ''
    const end = (why?: string) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      const report = readUninstallReport(out)
      done({ ran: true, report, ...(report ? {} : { why: why ?? 'said nothing Kehikot could read' }) })
    }
    child.on('error', (error) => end(`could not be run (${error.message})`))
    child.on('close', (code, signal) => end(signal ? `did not finish within ${secondsSaid(timeoutMs)}` : code ? `stopped with exit code ${code}${said() ? ` (${said()})` : ''}` : undefined))
  })
}

/* ---- the desk ---- */

export function uninstallDesk(deps: UninstallDeps, now: () => number = Date.now) {
  const claimed = new Set<string>()

  function registrationFiles(id: string): string[] {
    return list(deps.registry)
      .filter((file) => /\.(json|ya?ml)$/i.test(file) && idOfFile(file) === id)
      .map((file) => join(deps.registry, file))
  }

  function projectData(id: string): { id: number; name: string; path: string; bytes: number; dir: string }[] {
    const out: { id: number; name: string; path: string; bytes: number; dir: string }[] = []
    for (const project of deps.projects()) {
      let dir: string | null
      try {
        dir = moduleDir(project.path, id)
      } catch {
        dir = null
      }
      if (!dir || !existsSync(dir)) continue
      out.push({ ...project, dir, bytes: sizeOf(dir) })
    }
    return out
  }

  async function find(id: string) {
    const registration = (await deps.registered()).find((r) => r.id === id) ?? null
    const copy = join(deps.installed, id)
    const own = registration !== null && registration.dir !== undefined && isOwnCheckout(registration.dir, copy) ? registration.dir : undefined
    const places = placesOf(id, deps).filter((one) => existsSync(one.path) && (!own || real(one.path) !== real(own)))
    return { registration, own, places, files: registrationFiles(id) }
  }

  /** What the confirmation shows: what goes, what stays, and the projects with saved data. */
  async function preview(id: string): Promise<UninstallPreview | { ok: false; why: string; status: number }> {
    if (!ID.test(id)) return { ok: false, why: 'An uninstall names one module.', status: 400 }
    const found = await find(id)
    if (!found.registration && found.files.length === 0 && found.places.length === 0) return { ok: false, why: `${id} is not on this computer.`, status: 404 }
    const dir = found.registration?.dir ?? (existsSync(join(deps.installed, id)) ? join(deps.installed, id) : null)
    return {
      ok: true,
      id,
      name: deps.nameOf(id),
      ...(found.own ? { own: found.own } : {}),
      bytes: found.places.reduce((sum, one) => sum + sizeOf(one.path), 0),
      projects: projectData(id).map(({ dir: _dir, ...one }) => one),
      cleanUp: dir !== null && existsSync(join(dir, UNINSTALL_SCRIPT)),
    }
  }

  /** Take a module off this computer, on the person's press. */
  async function uninstall(id: string, options: { projects?: boolean } = {}): Promise<UninstallOutcome> {
    if (!ID.test(id)) return { ok: false, why: 'An uninstall names one module.', status: 400 }
    if (claimed.has(id)) return { ok: false, why: `${id} is already being uninstalled.`, status: 409 }
    claimed.add(id)
    try {
      const found = await find(id)
      if (!found.registration && found.files.length === 0 && found.places.length === 0) return { ok: false, why: `${id} is not on this computer.`, status: 404 }
      const name = deps.nameOf(id)
      if (deps.busy(id)) return { ok: false, why: `${name} is being installed, updated or started. Nothing was removed; try again when it is done.`, status: 409 }

      /* 1. Stopped, or nothing is touched. */
      if (found.registration) {
        const stopped = await deps.stop(id, found.registration)
        if (!stopped.ok) return { ok: false, why: `${stopped.why}. Nothing was removed.`, status: 409 }
      }
      deps.stopVersions(id)

      const removed: UninstallItem[] = []
      const left: UninstallLeftItem[] = []
      let freed = 0

      /* 2. Its own clean-up, from the folder it ran from, before that folder goes. */
      const dir = found.registration?.dir ?? (existsSync(join(deps.installed, id)) ? join(deps.installed, id) : null)
      const cleaned = dir ? await deps.cleanUp(dir, id) : ({ ran: false } as const)
      if (cleaned.ran && cleaned.report) {
        removed.push(...cleaned.report.removed)
        left.push(...cleaned.report.left)
      } else if (cleaned.ran) {
        left.push({ what: `What ${name} put outside its folder`, why: `its own clean-up ${cleaned.why ?? 'did not finish'}` })
      } else if (deps.agentModule(id)) {
        left.push({
          what: `Anything ${name} wrote into your agent's own settings`,
          why: 'this version has no clean-up of its own, so Kehikot removed only what it could prove was the module’s',
        })
      }

      /* 3. Its registration. */
      for (const file of found.files) {
        try {
          rmSync(file, { force: true })
          removed.push({ what: 'Its registration', path: file })
        } catch (error) {
          left.push({ what: 'Its registration', path: file, why: (error as Error).message })
        }
      }

      /* 4. What Kehikot keeps for it on this machine. */
      for (const one of found.places) {
        const bytes = sizeOf(one.path)
        try {
          rmSync(one.path, { recursive: true, force: true })
          removed.push({ ...one, bytes })
          freed += bytes
        } catch (error) {
          left.push({ ...one, why: (error as Error).message })
        }
      }

      /* Project data, only when the person ticked it. */
      if (options.projects === true) {
        for (const project of projectData(id)) {
          try {
            rmSync(project.dir, { recursive: true, force: true })
            removed.push({ what: `Its saved data in ${project.name}`, path: project.dir, bytes: project.bytes })
            freed += project.bytes
          } catch (error) {
            left.push({ what: `Its saved data in ${project.name}`, path: project.dir, why: (error as Error).message })
          }
        }
      }

      /* 5. Its records in this machine's database; the Inbox told. */
      deps.forgetInbox(id)
      const records = forgetModule(deps.db, id)
      if (records > 0) removed.push({ what: `What Kehikot remembered for it (${records} record${records === 1 ? '' : 's'}: kept views, grants, switches)` })
      recordUninstalled(deps.db, id, name, now())

      await deps.registryChanged()
      /* 6. What the host had made for it in the agent, now that it is no longer registered. */
      for (const line of await deps.agentTidy()) removed.push({ what: line })

      const said = uninstallSaid(name, removed, left, freed, found.own)
      deps.log(`kehikko: ${id} was uninstalled on a press — ${said}`)
      return { ok: true, id, name, removed, left, freed, ...(found.own ? { own: found.own } : {}), said }
    } finally {
      claimed.delete(id)
    }
  }

  return { uninstall, preview }
}
