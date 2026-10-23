import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PACKAGE_VERSION } from 'kehikot-module-protocol'

import { HOST_REPO, meetsProtocol, officialOf, type Official } from './official.ts'
import type { Standing } from './officialSource.ts'
import { splitRemote } from './trackers/sources.ts'
import type { ReleaseFollower } from './updates.ts'
import type { Runner } from './versions.ts'

/**
 * Installing a module from a list: clone it, install it, register it.
 *
 * Two lists feed it, and both go through the one path below (`begin`): the
 * official list, and the person's own "My modules" (`myModules.ts`). An entry
 * from either is cloned, put on its newest release (or left on `main` when it
 * has none yet), installed, registered, moved to a newer release before it
 * starts (`moduleReleases.ts`) and removed the same way; the only differences are where
 * its repository may be (a personal one may be on a GitLab) and the port it is
 * first given (a personal one never takes a port the official list names).
 *
 * ## What "installed" means here
 *
 * The same thing it means for a module somebody set up by hand: a checkout on
 * this machine and a registration file naming it. Nothing is special about a
 * module the host installed — it is swept, started, stopped, updated and
 * removed from a kehikko like any other, which is why this file ends at the
 * registration and everything after it is code that already existed.
 *
 * ## Where it goes
 *
 * A directory the host owns under the machine directory (`installsDir`), one
 * folder per module id. Never beside somebody's projects and never into a
 * working copy: a person who already has the repository cloned registers that
 * checkout themselves, and the list then shows it as installed.
 *
 * ## What may be installed
 *
 * Only an entry on the official list, named by id. The repository, the
 * directory and the port all come from the list in this process; nothing in a
 * request is ever joined into a path or handed to git.
 *
 * The list is the one the host was built with under the one published now
 * (`officialSource.ts`), so it can change while the host runs. Two things
 * follow, and both are refusals:
 *
 *  - An entry may ask for a newer protocol package than this host has. It is
 *    listed, says so, and is not installed — by the page or by a request.
 *  - An entry may come to name another repository than the one a module on
 *    this machine was cloned from. NOTHING is repointed: a registered module
 *    is never installed over, and a clone left in the way that is not the
 *    entry's repository is never cloned over or pulled into (both below). The
 *    list only says that the two differ (`from`), so a person can see it.
 *
 * ## Why it is a job and not a request
 *
 * A clone and a dependency install take as long as a network takes. The press
 * starts the job and returns; the page reads how far it has got with the list.
 * A failure is kept, as a sentence, until the next press tries again.
 */

export type Step = 'cloning' | 'installing' | 'registering'

export type Installing = { state: 'installing'; step: Step } | { state: 'failed'; why: string }

/**
 * What can be installed: an entry on the official list, or one of the
 * person's own. The repository, the directory and the port all come from
 * here — from a list on this side — and never from a request.
 */
export interface Installable extends Official {
  /** The host the repository is on: `github.com` when not given, which is every official entry. */
  host?: string
  /** One of the person's own (`myModules.ts`): vouched for by them alone. */
  mine?: boolean
}

/** One line of the list as the page receives it. */
export interface Listed extends Installable {
  installed: boolean
  install?: Installing
  /** Set when the entry asks for a newer protocol package than this host has: what it asks for, and what this host has. */
  newer?: { protocol: string; has: string }
  /** Set for an installed module whose checkout is of another GitHub repository than the entry names: that repository. */
  from?: string
}

export interface Deps {
  /** The official list, or how to read it as it stands now. */
  list: readonly Official[] | (() => readonly Official[])
  /** Where a list that changes comes from: asked again when the list is read, and how current it is. */
  source?: { refresh(): Promise<void>; standing(): Standing }
  /** The protocol package this host has; the installed one when not given. */
  protocol?: string
  run: Runner
  /** Where installed modules are cloned. See `installsDir`. */
  root: string
  /** Where registrations are written — the directory this host sweeps. */
  registry: string
  /** What is registered now: each id and the port it answers on, when it names one. */
  registered(): Promise<{ id: string; port: number | null; dir?: string }[]>
  /** Called once a registration has been written, so pages sweep again. */
  installed?(id: string): void
  /**
   * Puts a fresh clone on its newest release before its dependencies are
   * installed (`moduleReleases.ts`). Without it the clone stays on `main`.
   */
  releases?: Pick<ReleaseFollower, 'settle'>
}

const CLONE_TIMEOUT_MS = 5 * 60_000
const INSTALL_TIMEOUT_MS = 10 * 60_000
/** How long opening the list waits for a fresh one before answering with what there is. */
const REFRESH_WAIT_MS = 1500

/** Modules sit ten ports apart, and a new one never goes below this. The protocol's `create` uses the same grid. */
const PORT_STEP = 10
const PORT_FLOOR = 7960

/**
 * Where the person's own modules are put: from here up, on the same grid. Every
 * official first port is below it, and the official list grows upward from
 * 7820 ten at a time, so a personal module is never registered where an
 * official one would be (and `minePort` skips an official port even so).
 */
export const MINE_PORT_FLOOR = 9000

/** The listed port, or the next free place on the grid when a registered module already has it. */
export function portFor(entry: Official, taken: readonly number[]): number {
  if (!taken.includes(entry.port)) return entry.port
  let port = Math.max(PORT_FLOOR, ...taken.map((one) => Math.floor(one / PORT_STEP) * PORT_STEP + PORT_STEP))
  while (taken.includes(port)) port += PORT_STEP
  return port
}

/** The first place on the grid from `MINE_PORT_FLOOR` up that is in none of `avoid`: registered ports, official first ports, the person's other modules. */
export function minePort(avoid: readonly number[]): number {
  let port = MINE_PORT_FLOOR
  while (avoid.includes(port)) port += PORT_STEP
  return port
}

/** Where a personal module is registered: its own port unless something has it or the official list names it. */
export function portForMine(entry: Official, taken: readonly number[], official: readonly number[]): number {
  if (!taken.includes(entry.port) && !official.includes(entry.port) && entry.port >= MINE_PORT_FLOOR) return entry.port
  return minePort([...taken, ...official])
}

/** The host an entry's repository is on. */
export const hostOf = (entry: Pick<Installable, 'host'>): string => entry.host ?? 'github.com'

/** How a repository is named to a person: `owner/repo` on GitHub, `host/group/repo` anywhere else. */
export function repoSaid(entry: Pick<Installable, 'host' | 'repo'>): string {
  const host = hostOf(entry)
  return host === 'github.com' ? entry.repo : `${host}/${entry.repo}`
}

/** The repository a remote URL names, said as `repoSaid` says one; null for what is not a repository. */
export function remoteSaid(remote: string): string | null {
  const found = splitRemote(remote)
  return found ? repoSaid({ host: found.host.replace(/:\d+$/, ''), repo: found.repo }) : null
}

export function installDesk(deps: Deps) {
  const jobs = new Map<string, Installing>()

  const entries = () => (typeof deps.list === 'function' ? deps.list() : deps.list)
  const unmet = (entry: Official) => (meetsProtocol(entry.protocol, deps.protocol) ? null : { protocol: entry.protocol!, has: deps.protocol ?? PACKAGE_VERSION })

  /* The repository a checkout is of, asked once per directory: it is read to
     SAY something, never to decide where anything is fetched from. */
  const origins = new Map<string, string | null>()
  async function originOf(dir: string): Promise<string | null> {
    if (!origins.has(dir)) {
      const remote = await deps.run(['git', '-C', dir, 'remote', 'get-url', 'origin']).catch(() => null)
      origins.set(dir, remote?.ok ? remoteSaid(remote.out) : null)
    }
    return origins.get(dir) ?? null
  }

  /** Each entry as the page reads it: installed or not, how an install is going, what it needs. */
  async function listOf(these: readonly Installable[]): Promise<Listed[]> {
    const here = new Map((await deps.registered()).map((one) => [one.id, one]))
    return Promise.all(
      these.map(async (entry) => {
        const registered = here.get(entry.id)
        const installed = registered !== undefined
        const install = installed ? undefined : jobs.get(entry.id)
        const newer = installed ? null : unmet(entry)
        const origin = registered?.dir ? await originOf(registered.dir) : null
        const from = origin && origin.toLowerCase() !== repoSaid(entry).toLowerCase() ? origin : null
        return { ...entry, installed, ...(install ? { install } : {}), ...(newer ? { newer } : {}), ...(from ? { from } : {}) }
      }),
    )
  }

  const list = (): Promise<Listed[]> => listOf(entries())

  async function work(entry: Installable): Promise<void> {
    const dir = join(deps.root, entry.id)
    const step = (now: Step) => jobs.set(entry.id, { state: 'installing', step: now })

    step('cloning')
    /** Why a clone left by an earlier attempt could not be updated, when it could not. */
    let stale: string | null = null
    if (existsSync(dir)) {
      /* Something is already there. It is used only when it is this module's
         own repository — what an earlier attempt left after cloning and then
         failing to install — and never cloned over or cleared away. */
      const remote = await deps.run(['git', '-C', dir, 'remote', 'get-url', 'origin'])
      if (!remote.ok || remoteSaid(remote.out)?.toLowerCase() !== repoSaid(entry).toLowerCase()) {
        throw new Error(`${dir} already exists and is not a checkout of ${repoSaid(entry)}. Move it away and install again.`)
      }
      /* And brought level with its repository first. The usual reason an
         earlier attempt cloned and then failed is something IN the
         repository — a lockfile this machine's bun will not take — and the
         fix for that arrives as a commit. Installing the old clone again
         would fail the same way for ever, with the fix one pull away.
         Fast-forward only: nothing here is anybody's work, and if it cannot
         fast-forward the install goes on with what is there and says so
         should it then fail. */
      const pulled = await deps.run(['git', '-C', dir, 'pull', '--ff-only', '--quiet'], { timeoutMs: CLONE_TIMEOUT_MS })
      if (!pulled.ok) {
        /* A clone an earlier attempt already put on a release is detached and
           cannot pull: its tags are fetched instead, and it is put on the
           newest release below. */
        const tags = await deps.run(['git', '-C', dir, 'fetch', '--quiet', '--tags', 'origin'], { timeoutMs: CLONE_TIMEOUT_MS })
        if (!tags.ok || !deps.releases) stale = pulled.why
      }
    } else {
      mkdirSync(deps.root, { recursive: true })
      /* Over https first, which needs no account for a public repository (and
         uses gh's or glab's credential helper for a private one), and then
         over ssh for a person whose git is set up that way. */
      const host = hostOf(entry)
      const https = await deps.run(['git', 'clone', '--quiet', `https://${host}/${entry.repo}.git`, dir], { timeoutMs: CLONE_TIMEOUT_MS })
      if (!https.ok) {
        const ssh = await deps.run(['git', 'clone', '--quiet', `git@${host}:${entry.repo}.git`, dir], { timeoutMs: CLONE_TIMEOUT_MS })
        if (!ssh.ok) throw new Error(`${repoSaid(entry)} could not be cloned: ${https.why}${ssh.why === https.why ? '' : ` Over SSH: ${ssh.why}`}`)
      }
    }

    /* Modules run their releases: the newest one this host can run, checked
       out before anything is installed. A repository with no release yet
       stays on main. */
    if (deps.releases) {
      const settled = await deps.releases.settle({ id: entry.id, name: entry.name, dir })
      if (!settled.ok) throw new Error(`${entry.name} was cloned, and ${settled.why}`)
    }

    step('installing')
    const installed = await deps.run(['bun', 'install', '--frozen-lockfile'], { cwd: dir, timeoutMs: INSTALL_TIMEOUT_MS })
    if (!installed.ok) {
      const old = stale ? ` — and the clone, left by an earlier attempt, could not be brought up to date first: ${stale}` : ''
      throw new Error(`${entry.name} was cloned, and its dependencies could not be installed: ${installed.why}${old}`)
    }

    step('registering')
    const registered = await deps.registered()
    /* Registered by somebody else while this ran: theirs stands. */
    if (registered.some((one) => one.id === entry.id)) return
    const taken = registered.flatMap((one) => (one.port === null ? [] : [one.port]))
    /* A personal module never takes a port the official list names, installed or not. */
    const port = entry.mine ? portForMine(entry, taken, entries().map((one) => one.port)) : portFor(entry, taken)
    mkdirSync(deps.registry, { recursive: true })
    const file = join(deps.registry, `${entry.id}.json`)
    /* Written beside the target and renamed into place, so a sweep never reads
       half a registration. The shape is the one the protocol's `registerAt`
       writes, and the module's own start script rewrites `url` if it has to
       move to another port. */
    const tmp = `${file}.installing-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify({ url: `http://127.0.0.1:${port}`, dir }, null, 2)}\n`)
    renameSync(tmp, file)
  }

  /** Start installing one official module. Returns at once; `list` says how it is going. */
  async function install(id: string): Promise<Begun> {
    const entry = officialOf(id, entries())
    if (!entry) return { ok: false, why: `${id} is not on the official module list, so there is nothing to install.`, status: 404 }
    return begin(entry)
  }

  /**
   * Start installing an entry from either list — the one path both take.
   * Returns at once; `listOf` says how it is going. The entry is the caller's,
   * read from its own list by id, never a request's.
   */
  async function begin(entry: Installable): Promise<Begun> {
    if ((await deps.registered()).some((one) => one.id === entry.id)) {
      return { ok: false, why: `${entry.name} is already registered on this computer.`, status: 409 }
    }
    const newer = unmet(entry)
    if (newer) {
      return { ok: false, why: `${entry.name} needs a newer Kehikot than this one (protocol ${newer.protocol}; this one has ${newer.has}).`, status: 409 }
    }
    const running = jobs.get(entry.id)
    if (running?.state === 'installing') return { ok: true, install: running }

    jobs.set(entry.id, { state: 'installing', step: 'cloning' })
    void work(entry).then(
      () => {
        jobs.delete(entry.id)
        deps.installed?.(entry.id)
      },
      (error: unknown) => {
        jobs.set(entry.id, { state: 'failed', why: (error as Error).message })
      },
    )
    return { ok: true, install: jobs.get(entry.id) ?? null }
  }

  /** Whether an install of this id is running now. */
  const busy = (id: string): boolean => jobs.get(id)?.state === 'installing'

  /** Forget a failed install's sentence: the entry it was for is gone. */
  function forget(id: string): void {
    if (!busy(id)) jobs.delete(id)
  }

  /** `/host/official` (the list) and `/host/official/install`; null for any other request. */
  async function route(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname === '/host/official' && request.method === 'GET') {
      /* Somebody opened the list: ask where it is published, unless that was
         done a moment ago, and wait only briefly — a slow network delays
         nothing but the newest entries, which the next opening has. */
      if (deps.source) await Promise.race([deps.source.refresh(), new Promise((done) => setTimeout(done, REFRESH_WAIT_MS))])
      return reply({ modules: await list(), ...(deps.source ? { list: { ...deps.source.standing(), repo: `https://github.com/${HOST_REPO}` } } : {}) })
    }
    if (url.pathname === '/host/official/install' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { module?: unknown } | null
      if (!body || typeof body.module !== 'string' || body.module.length > 64) {
        return reply({ error: 'An install names one module on the official list.' }, 400)
      }
      const started = await install(body.module)
      return started.ok ? reply(started, 202) : reply({ error: started.why }, started.status)
    }
    return null
  }

  return { list, listOf, install, begin, busy, forget, route }
}

export type InstallDesk = ReturnType<typeof installDesk>

export type Begun = { ok: true; install: Installing | null } | { ok: false; why: string; status: number }

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
