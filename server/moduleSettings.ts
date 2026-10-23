import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, sep } from 'node:path'

import {
  LIMITS,
  SETTINGS_PASS,
  SETTINGS_PATH,
  moduleDir,
  settingValueIssue,
  settingsGetResult,
  settingsSetResult,
  settingsValues,
  type SettingField,
  type SettingsPassAbout,
  type SettingsSetResult,
} from 'kehikot-module-protocol'

/**
 * A module's settings, seen and changed from this host's page (protocol 2.15.0).
 *
 * The module declares its settings (`declares.settings`) and is the ONLY writer of its files. The
 * host draws the form, reads the values at the module's door (`settings.get`) and sends each change
 * the person makes there (`settings.set`). It never writes into `.kehikot/<module>/`: "Open the
 * file" reads it, and shows it read-only.
 *
 * ## The person's pass
 *
 * A `personOnly` setting changes only for the person. A module's server cannot tell this host's
 * server from an agent's `curl` — both are programs on this machine — so a change sent from here
 * carries a PASS: minted by `Passes.issue` only on the page's own route (`PAGE_ONLY`, so only a
 * press in this host's page reaches it), for one module, one key and one project, good for
 * `LIMITS.SETTINGS_PASS_MS` (30 s) and for one answer. The module asks back at
 * `/host/settings-pass` (`vouch`), and that answer spends it. An agent cannot mint one: no MCP tool
 * changes a setting, and the route that mints is the page's alone.
 */

/** How long a module gets to answer a read or a change, in ms. */
export const SETTINGS_ASK_MS = 4000
/** The most of a settings file "Open the file" shows, in bytes. */
export const SETTINGS_FILE_MAX = 256 * 1024

interface Kept {
  module: string
  key: string
  project: string | null
  until: number
}

/** The passes this host minted, each for one person's change. In memory: they die with the process. */
export class Passes {
  #kept = new Map<string, Kept>()
  readonly #now: () => number
  readonly #mint: () => string

  constructor(now: () => number = () => Date.now(), mint: () => string = () => randomBytes(32).toString('base64url')) {
    this.#now = now
    this.#mint = mint
  }

  /** A new pass for one change: this module, this key, this project (null: a machine setting). */
  issue(about: { module: string; key: string; project: string | null }): string {
    this.#sweep()
    const pass = this.#mint()
    this.#kept.set(pass, { ...about, until: this.#now() + LIMITS.SETTINGS_PASS_MS })
    return pass
  }

  /**
   * Whether `pass` is one this host minted for exactly this module, key and project, and still
   * good. Spent by being asked, whatever the answer: a pass is shown once.
   */
  take(pass: string | null, about: { module: string | null; key: string | null; project: string | null }): boolean {
    this.#sweep()
    if (typeof pass !== 'string' || !SETTINGS_PASS.test(pass)) return false
    const kept = this.#kept.get(pass)
    if (!kept) return false
    this.#kept.delete(pass)
    return kept.until >= this.#now() && kept.module === about.module && kept.key === about.key && kept.project === (about.project || null)
  }

  /** How many are held; for the tests. */
  get size(): number {
    return this.#kept.size
  }

  #sweep(): void {
    const now = this.#now()
    for (const [pass, kept] of this.#kept) if (kept.until < now) this.#kept.delete(pass)
  }
}

/** A module that can be asked: ready, with the settings it declared and where it answers. */
export interface SettingsModule {
  id: string
  name: string
  /** The origin the registration names. Loopback only (`readRegistrations`). */
  origin: string
  fields: readonly SettingField[]
}

export interface ModuleSettingsDeps {
  /** The module, when it is running and answering; null otherwise. */
  moduleOf(id: string): Promise<SettingsModule | null>
  passes: Passes
  fetch?: typeof fetch
}

export type Refused = { ok: false; why: string }

/** What the page is answered for one module: its fields, the values now, and the file behind them. */
export interface SettingsRead {
  ok: true
  module: string
  name: string
  fields: readonly SettingField[]
  values: Record<string, unknown>
  /** Relative to the project: `.kehikot/factory/settings.json`. */
  file: string | null
  problem: string | null
}

const NOT_RUNNING = (id: string) => `${id} is not running, so its settings cannot be read or changed now. Start it and try again.`
const NO_SETTINGS = (name: string) => `${name} has no settings it shows here.`

async function asking<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), SETTINGS_ASK_MS)
  try {
    return await run(control.signal)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function moduleSettingsDesk(deps: ModuleSettingsDeps) {
  const fetching = deps.fetch ?? fetch

  async function found(id: string): Promise<SettingsModule | Refused> {
    const module = await deps.moduleOf(id)
    if (!module) return { ok: false, why: NOT_RUNNING(id) }
    if (!module.fields.length) return { ok: false, why: NO_SETTINGS(module.name) }
    return module
  }

  /** `settings.get` at the module's door, for this project. */
  async function read(id: string, project: string | null): Promise<SettingsRead | Refused> {
    const module = await found(id)
    if ('ok' in module) return module
    const query = project ? `?project=${encodeURIComponent(project)}` : ''
    const said = await asking(async (signal) => {
      const response = await fetching(`${module.origin}${SETTINGS_PATH}${query}`, { signal, headers: { accept: 'application/json' } })
      if (!response.ok) return null
      return settingsGetResult.safeParse(await response.json())
    })
    if (!said?.success) return { ok: false, why: `${module.name} did not answer with its settings.` }
    return {
      ok: true,
      module: module.id,
      name: module.name,
      fields: module.fields,
      /* Only what it declared, each of its type: a module's answer is a stranger's. */
      values: settingsValues(module.fields, said.data.values),
      file: relativeFile(said.data.file),
      problem: said.data.problem ?? null,
    }
  }

  /**
   * A person's change, made in this host's page, sent to the module with a pass. Checked here
   * first (a key it declared, a value of its type, a project for a project setting), and again by
   * the module, which is the one that writes.
   */
  async function set(id: string, project: string | null, key: string, value: unknown): Promise<SettingsSetResult | Refused> {
    const module = await found(id)
    if ('ok' in module) return module
    const field = module.fields.find((one) => one.key === key)
    if (!field) return { ok: false, why: `${module.name} has no setting called "${String(key).slice(0, 64)}".` }
    if (field.scope === 'project' && !project) return { ok: false, why: 'Open a project first: this setting is kept in the project.' }
    const issue = settingValueIssue(field, value)
    if (issue) return { outcome: 'refused', why: `${field.label}: it takes ${issue}.` }
    const pass = deps.passes.issue({ module: module.id, key, project: field.scope === 'project' ? project : null })
    const body = { ...(field.scope === 'project' && project ? { project } : {}), key, value, by: 'person', pass }
    const said = await asking(async (signal) => {
      const response = await fetching(`${module.origin}${SETTINGS_PATH}`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
      const json = (await response.json().catch(() => null)) as Record<string, unknown> | null
      if (!response.ok) return { refused: typeof json?.error === 'string' ? json.error.slice(0, LIMITS.REASON) : `${module.name} refused it.` }
      return settingsSetResult.safeParse(json)
    })
    if (!said) return { ok: false, why: `${module.name} did not answer.` }
    if ('refused' in said) return { outcome: 'refused', why: said.refused }
    if (!said.success) return { ok: false, why: `${module.name} answered with something this host cannot read.` }
    return {
      outcome: said.data.outcome,
      why: said.data.why,
      ...(said.data.values ? { values: settingsValues(module.fields, said.data.values) } : {}),
    }
  }

  /**
   * The module's settings file, to READ: the file `settings.get` named, only when it is inside the
   * module's own folder of this project, at most `SETTINGS_FILE_MAX`. Never written.
   */
  async function file(id: string, project: string | null): Promise<{ ok: true; path: string; file: string; text: string } | Refused> {
    if (!project) return { ok: false, why: 'Open a project first: the settings file is kept in the project.' }
    const got = await read(id, project)
    if (!got.ok) return got
    if (!got.file) return { ok: false, why: `${got.name} does not say where it keeps its settings.` }
    const path = inside(project, id, got.file)
    if (!path) return { ok: false, why: `${got.file} is not in ${got.name}'s own folder, so it is not shown.` }
    if (!existsSync(path)) return { ok: true, path, file: got.file, text: '' }
    const size = statSync(path).size
    if (size > SETTINGS_FILE_MAX) return { ok: false, why: `${got.file} is larger than ${SETTINGS_FILE_MAX / 1024} kB.` }
    return { ok: true, path, file: got.file, text: readFileSync(path, 'utf8') }
  }

  /**
   * A module's server asking whether a pass is one this host minted (`SETTINGS_PASS_PATH`). The
   * answer spends it.
   */
  function vouch(query: URLSearchParams): { ok: true; person: boolean } {
    const person = deps.passes.take(query.get('pass'), {
      module: query.get('module'),
      key: query.get('key'),
      project: query.get('project'),
    })
    return { ok: true, person }
  }

  return { read, set, file, vouch }
}

/** A project-relative file a module named, normalised, or null when it is not one. */
export function relativeFile(file: string | undefined): string | null {
  if (typeof file !== 'string' || !file || isAbsolute(file) || file.includes('\0')) return null
  const clean = normalize(file).replaceAll('\\', '/')
  return clean.startsWith('../') || clean === '..' ? null : clean
}

/** The absolute path of `file` when it is inside `<project>/.kehikot/<module>/` (symlinks resolved); null otherwise. */
export function inside(project: string, module: string, file: string): string | null {
  const relative = relativeFile(file)
  let own: string | null
  try {
    own = moduleDir(project, module)
  } catch {
    return null
  }
  if (!relative || !own) return null
  const path = join(project, relative)
  if (!path.startsWith(own + sep)) return null
  if (existsSync(path)) {
    try {
      const real = realpathSync(path)
      const ownReal = existsSync(own) ? realpathSync(own) : own
      if (!real.startsWith(ownReal + sep)) return null
    } catch {
      return null
    }
  }
  return path
}

export type { SettingsPassAbout }
