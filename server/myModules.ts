import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { LIMITS, MODULE_ID, PACKAGE_VERSION } from 'kehikot-module-protocol'
import { z } from 'zod'

import type { Ran, Runner } from './feedback.ts'
import { hostOf, minePort, repoSaid, type InstallDesk, type Installable } from './installs.ts'
import { meetsProtocol, type Official } from './official.ts'
import { trouble } from './trackers/common.ts'
import { spell } from './trackers/edit.ts'
import { splitRemote } from './trackers/sources.ts'
import type { Runner as GitRunner } from './versions.ts'

/**
 * "My modules": modules a person installs from a repository they can read,
 * which is on no official list.
 *
 * ## Why there is a second list
 *
 * The official list (`official.ts`) is what this host vouches for, and it is
 * published to every installed app. A module in a private repository cannot go
 * there — its name would be shown to everybody and Install would fail for
 * anybody without access — and a module somebody is still writing should not
 * have to. Before this, the only way in was by hand: clone into `installed/`,
 * `bun install`, write the registration, and the app knew nothing of it.
 *
 * ## What the list is
 *
 * One file in the machine directory (`myModulesFile`), beside the official
 * list's cache. This machine's alone: nothing here publishes it, proposes it,
 * sends it to a module or an agent, or reads another machine's. Each entry has
 * the same shape as an official one, plus the host its repository is on (a
 * GitLab is fine), and is installed through the same path (`installs.ts`
 * `begin`): cloned into `installed/<id>/`, `bun install --frozen-lockfile`,
 * registered — and, from then on, brought level with its branch before it
 * starts and removable, like any other.
 *
 * ## Who adds to it
 *
 * The person, in the modules list, and nobody else. Every write is a route in
 * `PAGE_ONLY` (`guard.ts`) and there is no MCP tool for any of it: an agent
 * that could add a repository here could make this machine run whatever code
 * it liked.
 *
 * ## What is checked before anything is written
 *
 * With the person's own `gh` (or `glab`): that the repository can be read with
 * their login, and that it holds a Kehikot module — a `manifest.ts` built with
 * `kehikot-module-protocol` and a `package.json` that depends on it. The id,
 * name and summary are read out of that source, and the protocol package it
 * pins is what it needs (`meetsProtocol`, the same check as an official
 * entry's). The page shows those and the person confirms; the add checks it
 * all again rather than trusting what the page was shown.
 *
 * A repository already on the official list is installed as the official
 * module instead. An id the official list uses is refused: two modules cannot
 * answer to one name.
 *
 * ## The port
 *
 * From `MINE_PORT_FLOOR` (9000) up, never a port the official list names and
 * never one somebody else has: `minePort`.
 *
 * ## One installed by hand
 *
 * A checkout under `installed/` whose remote is on no list — `kehikot.flows`
 * was put there this way — is offered, in the list, as "Keep it as one of my
 * modules". Pressing it writes its entry (moving its registration off an
 * official port if it is on one). Nothing is adopted without that press.
 */

/** A module's repository path: `owner/repo`, or `group/sub/repo` on a GitLab. No segment reads as a flag or a path step. */
const REPO = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}){1,5}$/
/** A host name, nothing else. */
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/
const TAG = /^[a-z][a-z0-9-]{0,23}$/

const mineSchema = z.object({
  id: z.string().regex(MODULE_ID).refine((id) => !id.startsWith('.')),
  name: z.string().min(1).max(LIMITS.NAME),
  repo: z.string().regex(REPO).refine((repo) => !repo.split('/').some((part) => part === '.' || part === '..' || part.endsWith('.git'))),
  host: z.string().regex(HOST),
  port: z.number().int().min(1024).max(65535),
  summary: z.string().max(LIMITS.SUMMARY),
  tags: z.array(z.string().regex(TAG)).max(5),
  protocol: z.string().min(1).max(32).optional(),
  /** When it was added: a day a person can be told. */
  added: z.string().max(40),
  /** Kept from a checkout somebody had put under `installed/` by hand. */
  adopted: z.boolean().optional(),
})

export type Mine = z.infer<typeof mineSchema>

/** The list as it is on disk. `broken` says why a file that is there could not be read — and then nothing writes over it. */
export type MineRead = { modules: Mine[]; broken: string | null }

export function readMine(file: string): MineRead {
  if (!existsSync(file)) return { modules: [], broken: null }
  try {
    const parsed = z.object({ modules: z.array(mineSchema) }).parse(JSON.parse(readFileSync(file, 'utf8')))
    const seen = new Set<string>()
    for (const one of parsed.modules) {
      if (seen.has(one.id)) throw new Error(`it lists ${one.id} twice`)
      seen.add(one.id)
    }
    return { modules: parsed.modules, broken: null }
  } catch (error) {
    return { modules: [], broken: `${file} could not be read (${(error as Error).message.split('\n')[0]}), so it is left as it is` }
  }
}

/** The whole list, written beside the file and renamed into place: a reader never sees half of it. */
export function writeMine(file: string, modules: readonly Mine[]): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.writing-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify({ modules }, null, 2)}\n`)
  renameSync(tmp, file)
}

/** An entry as the install path takes it. */
export const installable = (entry: Mine): Installable => ({ ...entry, mine: true })

/* ------------------------------------------------------------------ *
 * What a repository says about itself, read as text
 * ------------------------------------------------------------------ */

/** Where a module's manifest is, in the order they are looked for. Every module so far keeps it at the root. */
export const MANIFEST_PATHS = ['manifest.ts', 'src/manifest.ts', 'server/manifest.ts'] as const

/** What the source of a module says it is, before it is ever run. */
export type Described =
  | { ok: true; id: string; name: string; summary: string; tags: string[]; protocol?: string }
  | { ok: false; why: string }

/* One string literal in TypeScript source: '…', "…" or a template with no `${`. */
const LITERAL = /'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"|`((?:\\.|[^`\\$])*)`/y

function unquote(raw: string): string {
  return raw.replace(/\\(.)/g, (_, one: string) => (one === 'n' ? ' ' : one))
}

/** The string a key is given at `from` on: one literal, or several joined with `+`. Null when it is anything else. */
function stringAt(source: string, key: string, from = 0): string | null {
  const at = new RegExp(`\\b${key}\\s*:\\s*`, 'g')
  at.lastIndex = from
  const found = at.exec(source)
  if (!found) return null
  let index = at.lastIndex
  let text = ''
  for (;;) {
    LITERAL.lastIndex = index
    const literal = LITERAL.exec(source)
    if (!literal) return text || null
    text += unquote(literal[1] ?? literal[2] ?? literal[3] ?? '')
    index = LITERAL.lastIndex
    const plus = /\s*\+\s*/y
    plus.lastIndex = index
    if (!plus.exec(source)) return text
    index = plus.lastIndex
  }
}

/**
 * The id, name, summary and tags out of a module's `manifest.ts`, and the
 * protocol package it pins out of its `package.json`.
 *
 * Read as text, never run: this is what a person is shown before deciding to
 * install it, so nothing in it may execute. It reads the shape every module
 * here is written in (`export const ID = '…'` and `manifestSchema.parse({ …
 * name: '…', summary: '…', tags: [ … ] })`); a manifest written another way
 * is said to be unreadable here, not guessed at.
 */
export function describeModule(manifest: string, pkg: string | null): Described {
  if (!/kehikot-module-protocol/.test(manifest) || !/\bmanifestSchema\b|\bMANIFEST_KIND\b/.test(manifest)) {
    return { ok: false, why: 'its manifest.ts is not built with kehikot-module-protocol, so it is not a Kehikot module' }
  }
  const constant = /\bexport\s+const\s+ID\s*=\s*['"]([^'"\n]+)['"]/.exec(manifest)?.[1]
  const start = Math.max(0, manifest.search(/\bmanifestSchema\s*\.\s*parse\s*\(|\bMANIFEST\b\s*[:=]/))
  const id = constant ?? stringAt(manifest, 'id', start)
  const name = stringAt(manifest, 'name', start)
  if (!id || !name) return { ok: false, why: 'the id or the name in its manifest.ts could not be read here' }
  if (!MODULE_ID.test(id) || id.startsWith('.')) return { ok: false, why: `its manifest calls it ${JSON.stringify(id.slice(0, 80))}, which is not a module id` }
  const summary = (stringAt(manifest, 'summary', start) ?? '').replace(/\s+/g, ' ').trim()
  const tagList = /\btags\s*:\s*\[([^\]]*)\]/.exec(manifest.slice(start))?.[1] ?? ''
  const tags = [...tagList.matchAll(/['"]([^'"]+)['"]/g)].map((one) => one[1]!).filter((one) => TAG.test(one)).slice(0, 5)

  if (pkg === null) return { ok: false, why: 'it has no package.json, so it cannot be installed' }
  let dependency: unknown
  try {
    const read = JSON.parse(pkg) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }
    dependency = read.dependencies?.['kehikot-module-protocol'] ?? read.devDependencies?.['kehikot-module-protocol']
  } catch {
    return { ok: false, why: 'its package.json is not JSON' }
  }
  if (typeof dependency !== 'string') return { ok: false, why: 'its package.json does not depend on kehikot-module-protocol, so it is not a Kehikot module' }
  /* `…kehikko-protocol.git#v2.6.0`, `^2.6.0`, `2.6.0`: the version it is built with is what it needs. */
  const pinned = /(\d{1,6}\.\d{1,6}\.\d{1,6})(?!.*\d+\.\d+\.\d+)/.exec(dependency)?.[1]
  return {
    ok: true,
    id,
    name: name.slice(0, LIMITS.NAME),
    summary: summary.slice(0, LIMITS.SUMMARY),
    tags,
    ...(pinned ? { protocol: pinned } : {}),
  }
}

/* ------------------------------------------------------------------ *
 * Reading a repository with the person's own login
 * ------------------------------------------------------------------ */

/** Where a repository is: which CLI reads it, which host, which path. */
export interface Where {
  tracker: 'github' | 'gitlab'
  host: string
  repo: string
}

/** What the person typed, as a repository on GitHub or a GitLab — `owner/repo` is GitHub. */
export function whereOf(input: string): { ok: true; where: Where } | { ok: false; why: string } {
  const text = input.trim()
  if (text.length > 300) return { ok: false, why: 'That is longer than any repository link.' }
  let spelled = spell(text)
  if (!spelled.ok && spelled.needs === 'tracker' && !/^(?:https?:\/\/|ssh:\/\/|[^/\s]+@)/.test(text)) spelled = spell(text, 'github')
  if (!spelled.ok) {
    return { ok: false, why: spelled.needs ? 'Only a repository on GitHub or a GitLab can be added: a link like https://github.com/owner/repo, or owner/repo.' : spelled.why }
  }
  const host = spelled.host.toLowerCase().replace(/:\d+$/, '')
  if (!HOST.test(host) || !REPO.test(spelled.repo) || spelled.repo.split('/').some((part) => part === '..' || part === '.')) {
    return { ok: false, why: 'That does not look like a repository. Try https://github.com/owner/repo, or owner/repo.' }
  }
  if (spelled.tracker === 'github' && host !== 'github.com') return { ok: false, why: 'Only github.com is read for GitHub repositories.' }
  return { ok: true, where: { tracker: spelled.tracker, host, repo: spelled.repo } }
}

/** What reading the repository found. */
type Read = { ok: true; repo: string; private: boolean; manifest: string | null; pkg: string | null } | { ok: false; why: string }

const READ_TIMEOUT_MS = 30_000

/**
 * The repository's name as its host spells it, whether it is private, and its
 * manifest and package.json — read with `gh api` or `glab api`, as the person.
 * Nothing is cloned and nothing is written.
 */
export async function readRepository(where: Where, run: Runner): Promise<Read> {
  const said = (ran: Ran) => trouble(ran, where.tracker === 'github' ? 'gh' : 'glab', where.host)
  if (where.tracker === 'github') {
    const meta = await run(['gh', 'api', `repos/${where.repo}`], { timeout: READ_TIMEOUT_MS })
    if (meta.code !== 0) return { ok: false, why: said(meta) }
    const info = json(meta.out) as { full_name?: unknown; private?: unknown } | null
    const repo = typeof info?.full_name === 'string' && REPO.test(info.full_name) ? info.full_name : where.repo
    const file = async (path: string) => {
      const ran = await run(['gh', 'api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${path}`], { timeout: READ_TIMEOUT_MS })
      return ran.code === 0 ? ran.out : null
    }
    return { ok: true, repo, private: info?.private === true, ...(await files(file)) }
  }
  const project = encodeURIComponent(where.repo)
  const meta = await run(['glab', 'api', '--hostname', where.host, `projects/${project}`], { timeout: READ_TIMEOUT_MS })
  if (meta.code !== 0) return { ok: false, why: said(meta) }
  const info = json(meta.out) as { path_with_namespace?: unknown; default_branch?: unknown; visibility?: unknown } | null
  const repo = typeof info?.path_with_namespace === 'string' && REPO.test(info.path_with_namespace) ? info.path_with_namespace : where.repo
  const ref = typeof info?.default_branch === 'string' ? info.default_branch : 'HEAD'
  const file = async (path: string) => {
    const ran = await run(
      ['glab', 'api', '--hostname', where.host, `projects/${project}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`],
      { timeout: READ_TIMEOUT_MS },
    )
    return ran.code === 0 ? ran.out : null
  }
  return { ok: true, repo, private: info?.visibility !== 'public', ...(await files(file)) }
}

async function files(read: (path: string) => Promise<string | null>): Promise<{ manifest: string | null; pkg: string | null }> {
  let manifest: string | null = null
  for (const path of MANIFEST_PATHS) {
    manifest = await read(path)
    if (manifest !== null) break
  }
  return { manifest, pkg: manifest === null ? null : await read('package.json') }
}

function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * The desk
 * ------------------------------------------------------------------ */

/** One registration, as much of it as this file reads. */
export interface Registered {
  id: string
  url: string
  dir?: string
}

export interface Deps {
  /** Where the list is kept. See `myModulesFile`. */
  file: string
  /** The official list as it stands now. */
  official(): readonly Official[]
  /** The shared install path. */
  desk: InstallDesk
  /** The person's `gh` and `glab`. */
  run: Runner
  /** git, quietly, for the remote of a checkout already on the machine. */
  git: GitRunner
  /** Where installed modules are cloned. See `installsDir`. */
  root: string
  /** Where registrations are written — the directory this host sweeps. */
  registry: string
  /** What is registered now. */
  registered(): Promise<Registered[]>
  /** Stop a module this host started, before its files are removed or its port moved. */
  stop(id: string): unknown
  /** The registry changed: pages sweep again. */
  changed?(): void
  /** The protocol package this host has; the installed one when not given. */
  protocol?: string
  now?(): Date
}

/** What a check finds, for the page to show before anything is written. */
export type Checked =
  | { ok: true; kind: 'official'; id: string; name: string; summary: string; repo: string; installed: boolean }
  | {
      ok: true
      kind: 'mine'
      id: string
      name: string
      summary: string
      tags: string[]
      repo: string
      host: string
      /** What the module needs, when it pins a protocol package. */
      protocol?: string
      /** Set when this host is older than that: what it has. Such a module is not added. */
      newer?: { protocol: string; has: string }
      private: boolean
    }
  | { ok: false; why: string; status: number }

/** A checkout under `installed/` that is on no list, which the person may keep as one of theirs. */
export interface Adoptable {
  id: string
  name: string
  /** Its repository, as `repoSaid` spells it. */
  from: string
  /** Set when its registration is on a port the official list names (or another of theirs): where keeping it moves it. */
  moves?: { from: number | null; to: number }
}

const portOf = (url: string): number | null => {
  try {
    const port = Number(new URL(url).port)
    return Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export function myModulesDesk(deps: Deps) {
  const have = deps.protocol ?? PACKAGE_VERSION
  const today = () => (deps.now?.() ?? new Date()).toISOString().slice(0, 10)
  const read = () => readMine(deps.file)

  /** The checkout an id is installed in, when it is the one under `installed/` this host owns. */
  const ownDir = (id: string) => join(deps.root, id)
  const isOwn = (id: string, dir: string | undefined) => dir !== undefined && real(dir) === real(ownDir(id))

  function sameRepo(a: { host: string; repo: string }, b: { host?: string; repo: string }): boolean {
    return a.host === hostOf(b) && a.repo.toLowerCase() === b.repo.toLowerCase()
  }

  /**
   * Look at a repository the person named, and say what it holds. Writes
   * nothing. Refuses, with a sentence, what cannot be added.
   */
  async function check(input: string): Promise<Checked> {
    const asked = whereOf(input)
    if (!asked.ok) return { ok: false, why: asked.why, status: 400 }
    const { where } = asked
    const official = deps.official()
    const listed = official.find((entry) => sameRepo(where, entry))
    if (listed) {
      const installed = (await deps.registered()).some((one) => one.id === listed.id)
      return { ok: true, kind: 'official', id: listed.id, name: listed.name, summary: listed.summary, repo: listed.repo, installed }
    }
    const mine = read()
    const already = mine.modules.find((entry) => sameRepo(where, entry))
    if (already) return { ok: false, why: `${already.name} is already one of your modules, from ${repoSaid(already)}.`, status: 409 }

    const found = await readRepository(where, deps.run)
    if (!found.ok) return { ok: false, why: `${repoSaid(where)} could not be read with your login: ${found.why}`, status: 422 }
    const said = repoSaid({ host: where.host, repo: found.repo })
    /* Asked again with the name its host spells it by: a redirect can land on an official repository. */
    const named = official.find((entry) => sameRepo({ host: where.host, repo: found.repo }, entry))
    if (named) {
      const installed = (await deps.registered()).some((one) => one.id === named.id)
      return { ok: true, kind: 'official', id: named.id, name: named.name, summary: named.summary, repo: named.repo, installed }
    }
    if (found.manifest === null) {
      return { ok: false, why: `${said} has no manifest.ts (looked for ${MANIFEST_PATHS.join(', ')}), so it is not a Kehikot module.`, status: 422 }
    }
    const described = describeModule(found.manifest, found.pkg)
    if (!described.ok) return { ok: false, why: `${said} cannot be added: ${described.why}.`, status: 422 }

    const sameId = official.find((entry) => entry.id === described.id)
    if (sameId) {
      return {
        ok: false,
        why: `${said} calls its module ${described.id}, which is the official ${sameId.name}'s id. Two modules cannot answer to one name: install ${sameId.name} from the list, or give this module its own id.`,
        status: 409,
      }
    }
    const ours = mine.modules.find((entry) => entry.id === described.id)
    if (ours) return { ok: false, why: `${described.id} is already one of your modules, from ${repoSaid(ours)}.`, status: 409 }
    if ((await deps.registered()).some((one) => one.id === described.id)) {
      return { ok: false, why: `A module called ${described.id} is already registered on this computer.`, status: 409 }
    }
    const newer = described.protocol && !meetsProtocol(described.protocol, have) ? { protocol: described.protocol, has: have } : null
    return {
      ok: true,
      kind: 'mine',
      id: described.id,
      name: described.name,
      summary: described.summary,
      tags: described.tags,
      repo: found.repo,
      host: where.host,
      ...(described.protocol ? { protocol: described.protocol } : {}),
      ...(newer ? { newer } : {}),
      private: found.private,
    }
  }

  /**
   * Add the repository to the list and install it. Everything is checked again
   * here, so what is written is what the repository says now, not what a page
   * was shown.
   */
  async function add(input: string): Promise<{ ok: true; id: string; official: boolean } | { ok: false; why: string; status: number }> {
    const checked = await check(input)
    if (!checked.ok) return checked
    if (checked.kind === 'official') {
      /* Installed as the official module: the list vouches for it. */
      const begun = await deps.desk.install(checked.id)
      return begun.ok ? { ok: true, id: checked.id, official: true } : begun
    }
    if (checked.newer) {
      return { ok: false, why: `${checked.name} needs a newer Kehikot than this one (protocol ${checked.newer.protocol}; this one has ${checked.newer.has}).`, status: 409 }
    }
    const mine = read()
    if (mine.broken) return { ok: false, why: `${mine.broken}. Nothing was added.`, status: 500 }
    const registered = await deps.registered()
    const port = minePort([
      ...registered.flatMap((one) => {
        const port = portOf(one.url)
        return port === null ? [] : [port]
      }),
      ...deps.official().map((one) => one.port),
      ...mine.modules.map((one) => one.port),
    ])
    const entry: Mine = {
      id: checked.id,
      name: checked.name,
      repo: checked.repo,
      host: checked.host,
      port,
      summary: checked.summary,
      tags: checked.tags,
      ...(checked.protocol ? { protocol: checked.protocol } : {}),
      added: today(),
    }
    writeMine(deps.file, [...mine.modules, mineSchema.parse(entry)])
    const begun = await deps.desk.begin(installable(entry))
    return begun.ok ? { ok: true, id: entry.id, official: false } : begun
  }

  /** Install one of the person's modules again — after a failure, or after it was unregistered. */
  async function install(id: string) {
    const entry = read().modules.find((one) => one.id === id)
    if (!entry) return { ok: false as const, why: `${id} is not one of your modules.`, status: 404 }
    return deps.desk.begin(installable(entry))
  }

  /**
   * Take one of the person's modules off this machine: stopped, its installed
   * copy and its registration deleted, its entry forgotten. A registration
   * that names another directory — somebody's own checkout — and that
   * directory are left alone; only what this host installed is removed. What
   * the module kept in projects (`.kehikot/<module>/`) stays.
   */
  async function remove(id: string): Promise<{ ok: true; removed: string } | { ok: false; why: string; status: number }> {
    const mine = read()
    if (mine.broken) return { ok: false, why: `${mine.broken}. Nothing was removed.`, status: 500 }
    const entry = mine.modules.find((one) => one.id === id)
    if (!entry) return { ok: false, why: `${id} is not one of your modules, so it is not removed from here.`, status: 404 }
    if (deps.desk.busy(entry.id)) return { ok: false, why: `${entry.name} is being installed. Remove it once that has finished.`, status: 409 }

    await deps.stop(entry.id)
    const registration = (await deps.registered()).find((one) => one.id === entry.id)
    const file = join(deps.registry, `${entry.id}.json`)
    if (registration && isOwn(entry.id, registration.dir) && existsSync(file)) rmSync(file, { force: true })
    if (!registration || isOwn(entry.id, registration.dir)) rmSync(ownDir(entry.id), { recursive: true, force: true })
    writeMine(
      deps.file,
      mine.modules.filter((one) => one.id !== entry.id),
    )
    deps.desk.forget(entry.id)
    deps.changed?.()
    return { ok: true, removed: entry.id }
  }

  /* The remote of a checkout, read once per directory. */
  const remotes = new Map<string, { host: string; repo: string } | null>()
  async function remoteOf(dir: string): Promise<{ host: string; repo: string } | null> {
    if (!remotes.has(dir)) {
      const ran = await deps.git(['git', '-C', dir, 'remote', 'get-url', 'origin']).catch(() => null)
      const found = ran?.ok ? splitRemote(ran.out) : null
      remotes.set(dir, found ? { host: found.host.replace(/:\d+$/, ''), repo: found.repo } : null)
    }
    return remotes.get(dir) ?? null
  }

  /** What the checkout's own files say, read from the disk. Never run. */
  function describeDir(dir: string): Described {
    const text = (path: string) => {
      try {
        return readFileSync(join(dir, path), 'utf8')
      } catch {
        return null
      }
    }
    for (const path of MANIFEST_PATHS) {
      const manifest = text(path)
      if (manifest !== null) return describeModule(manifest, text('package.json'))
    }
    return { ok: false, why: 'no manifest.ts' }
  }

  /**
   * Checkouts under `installed/` that are on no list: registered, in the
   * folder this host owns, cloned from a repository neither list names.
   */
  async function adoptable(): Promise<Array<Adoptable & { entry: Mine }>> {
    const mine = read()
    if (mine.broken) return []
    const official = deps.official()
    const registered = await deps.registered()
    const out: Array<Adoptable & { entry: Mine }> = []
    for (const one of registered) {
      if (!isOwn(one.id, one.dir)) continue
      if (official.some((entry) => entry.id === one.id) || mine.modules.some((entry) => entry.id === one.id)) continue
      const remote = await remoteOf(one.dir!)
      if (!remote || !HOST.test(remote.host) || !REPO.test(remote.repo)) continue
      if (official.some((entry) => sameRepo(remote, entry))) continue
      const described = describeDir(one.dir!)
      const port = portOf(one.url)
      const elsewhere = registered.filter((other) => other.id !== one.id).flatMap((other) => {
        const at = portOf(other.url)
        return at === null ? [] : [at]
      })
      const avoid = [...official.map((entry) => entry.port), ...mine.modules.map((entry) => entry.port), ...elsewhere]
      const stays = port !== null && !avoid.includes(port)
      const to = stays ? port : minePort(avoid)
      const entry: Mine = {
        id: one.id,
        name: described.ok ? described.name : one.id,
        repo: remote.repo,
        host: remote.host,
        port: to,
        summary: described.ok ? described.summary : '',
        tags: described.ok ? described.tags : [],
        ...(described.ok && described.protocol ? { protocol: described.protocol } : {}),
        added: today(),
        adopted: true,
      }
      if (!mineSchema.safeParse(entry).success) continue
      out.push({ id: one.id, name: entry.name, from: repoSaid(remote), ...(stays ? {} : { moves: { from: port, to } }), entry })
    }
    return out
  }

  /** Keep a hand-installed checkout as one of the person's modules: its entry written, its port moved off an official one. */
  async function adopt(id: string): Promise<{ ok: true; adopted: string; port: number } | { ok: false; why: string; status: number }> {
    const mine = read()
    if (mine.broken) return { ok: false, why: `${mine.broken}. Nothing was kept.`, status: 500 }
    const found = (await adoptable()).find((one) => one.id === id)
    if (!found) return { ok: false, why: `${id} is not a module installed by hand under ${deps.root} that is on no list.`, status: 404 }
    if (found.moves) {
      /* Its registration names a port that is not its to keep: stopped, and
         the registration rewritten. Its own start script takes `PORT` from the
         registration the next time it is started. */
      await deps.stop(id)
      const file = join(deps.registry, `${id}.json`)
      const was = json(readFileSync(file, 'utf8')) as Record<string, unknown> | null
      if (!was || typeof was !== 'object') return { ok: false, why: `${file} could not be read, so ${found.name} was not moved or kept.`, status: 500 }
      const tmp = `${file}.moving-${process.pid}`
      writeFileSync(tmp, `${JSON.stringify({ ...was, url: `http://127.0.0.1:${found.moves.to}` }, null, 2)}\n`)
      renameSync(tmp, file)
    }
    writeMine(deps.file, [...mine.modules, found.entry])
    deps.changed?.()
    return { ok: true, adopted: id, port: found.entry.port }
  }

  /** The list as the page reads it: each entry and how its install stands, and what could be kept. */
  async function list() {
    const mine = read()
    const modules = await deps.desk.listOf(mine.modules.map(installable))
    const offered = (await adoptable()).map(({ entry: _entry, ...one }) => one)
    return { modules, adoptable: offered, ...(mine.broken ? { broken: mine.broken } : {}) }
  }

  /** `/host/mine` and its writes; null for any other request. Every write is in `PAGE_ONLY`. */
  async function route(request: Request, url: URL): Promise<Response | null> {
    if (!url.pathname.startsWith('/host/mine')) return null
    if (url.pathname === '/host/mine' && request.method === 'GET') return reply(await list())
    if (request.method !== 'POST') return null
    const body = (await request.json().catch(() => null)) as { repo?: unknown; module?: unknown } | null
    const repo = typeof body?.repo === 'string' && body.repo.length <= 300 ? body.repo : null
    const module = typeof body?.module === 'string' && body.module.length <= 64 ? body.module : null
    const answer = (out: { ok: true } | { ok: false; why: string; status: number }, status = 200) =>
      out.ok ? reply(out, status) : reply({ error: out.why }, out.status)
    switch (url.pathname) {
      case '/host/mine/check':
        if (repo === null) return reply({ error: 'Say which repository: a link to it, or owner/repo.' }, 400)
        return answer(await check(repo))
      case '/host/mine/add':
        if (repo === null) return reply({ error: 'Say which repository: a link to it, or owner/repo.' }, 400)
        return answer(await add(repo), 202)
      case '/host/mine/install':
        if (module === null) return reply({ error: 'An install names one of your modules.' }, 400)
        return answer(await install(module), 202)
      case '/host/mine/remove':
        if (module === null) return reply({ error: 'A removal names one of your modules.' }, 400)
        return answer(await remove(module))
      case '/host/mine/adopt':
        if (module === null) return reply({ error: 'Name the module to keep.' }, 400)
        return answer(await adopt(module))
      default:
        return null
    }
  }

  return { check, add, install, remove, adoptable, adopt, list, route }
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
