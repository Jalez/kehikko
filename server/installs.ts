import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { githubRepo } from './feedback.ts'
import { officialOf, type Official } from './official.ts'
import type { Runner } from './versions.ts'

/**
 * Installing an official module: clone it, install it, register it.
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
 * ## Why it is a job and not a request
 *
 * A clone and a dependency install take as long as a network takes. The press
 * starts the job and returns; the page reads how far it has got with the list.
 * A failure is kept, as a sentence, until the next press tries again.
 */

export type Step = 'cloning' | 'installing' | 'registering'

export type Installing = { state: 'installing'; step: Step } | { state: 'failed'; why: string }

/** One line of the list as the page receives it. */
export interface Listed extends Official {
  installed: boolean
  install?: Installing
}

export interface Deps {
  list: readonly Official[]
  run: Runner
  /** Where installed modules are cloned. See `installsDir`. */
  root: string
  /** Where registrations are written — the directory this host sweeps. */
  registry: string
  /** What is registered now: each id and the port it answers on, when it names one. */
  registered(): Promise<{ id: string; port: number | null }[]>
  /** Called once a registration has been written, so pages sweep again. */
  installed?(id: string): void
}

const CLONE_TIMEOUT_MS = 5 * 60_000
const INSTALL_TIMEOUT_MS = 10 * 60_000

/** Modules sit ten ports apart, and a new one never goes below this. The protocol's `create` uses the same grid. */
const PORT_STEP = 10
const PORT_FLOOR = 7960

/** The listed port, or the next free place on the grid when a registered module already has it. */
export function portFor(entry: Official, taken: readonly number[]): number {
  if (!taken.includes(entry.port)) return entry.port
  let port = Math.max(PORT_FLOOR, ...taken.map((one) => Math.floor(one / PORT_STEP) * PORT_STEP + PORT_STEP))
  while (taken.includes(port)) port += PORT_STEP
  return port
}

export function installDesk(deps: Deps) {
  const jobs = new Map<string, Installing>()

  async function list(): Promise<Listed[]> {
    const ids = new Set((await deps.registered()).map((one) => one.id))
    return deps.list.map((entry) => {
      const installed = ids.has(entry.id)
      const install = installed ? undefined : jobs.get(entry.id)
      return { ...entry, installed, ...(install ? { install } : {}) }
    })
  }

  async function work(entry: Official): Promise<void> {
    const dir = join(deps.root, entry.id)
    const step = (now: Step) => jobs.set(entry.id, { state: 'installing', step: now })

    step('cloning')
    if (existsSync(dir)) {
      /* Something is already there. It is used only when it is this module's
         own repository — what an earlier attempt left after cloning and then
         failing to install — and never cloned over or cleared away. */
      const remote = await deps.run(['git', '-C', dir, 'remote', 'get-url', 'origin'])
      if (!remote.ok || githubRepo(remote.out)?.toLowerCase() !== entry.repo.toLowerCase()) {
        throw new Error(`${dir} already exists and is not a checkout of ${entry.repo}. Move it away and install again.`)
      }
    } else {
      mkdirSync(deps.root, { recursive: true })
      /* Over https first, which needs no account for a public repository, and
         then over ssh for a person whose git is set up that way. */
      const https = await deps.run(['git', 'clone', '--quiet', `https://github.com/${entry.repo}.git`, dir], { timeoutMs: CLONE_TIMEOUT_MS })
      if (!https.ok) {
        const ssh = await deps.run(['git', 'clone', '--quiet', `git@github.com:${entry.repo}.git`, dir], { timeoutMs: CLONE_TIMEOUT_MS })
        if (!ssh.ok) throw new Error(`${entry.repo} could not be cloned: ${https.why}`)
      }
    }

    step('installing')
    const installed = await deps.run(['bun', 'install', '--frozen-lockfile'], { cwd: dir, timeoutMs: INSTALL_TIMEOUT_MS })
    if (!installed.ok) throw new Error(`${entry.name} was cloned, and its dependencies could not be installed: ${installed.why}`)

    step('registering')
    const registered = await deps.registered()
    /* Registered by somebody else while this ran: theirs stands. */
    if (registered.some((one) => one.id === entry.id)) return
    const port = portFor(entry, registered.flatMap((one) => (one.port === null ? [] : [one.port])))
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
  async function install(id: string): Promise<{ ok: true; install: Installing | null } | { ok: false; why: string; status: number }> {
    const entry = officialOf(id, deps.list)
    if (!entry) return { ok: false, why: `${id} is not on the official module list, so there is nothing to install.`, status: 404 }
    if ((await deps.registered()).some((one) => one.id === entry.id)) {
      return { ok: false, why: `${entry.name} is already registered on this computer.`, status: 409 }
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

  /** `/host/official` (the list) and `/host/official/install`; null for any other request. */
  async function route(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname === '/host/official' && request.method === 'GET') return reply({ modules: await list() })
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

  return { list, install, route }
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
