import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODULE_ID } from 'kehikot-module-protocol'

import { GRACE_MS } from './lifecycle.ts'
import { RUN_SCRIPT } from './launch.ts'
import { isVersionTag, run, type Runner } from './versions.ts'

/**
 * Running a tagged version of a module beside its checkout.
 *
 * ## Two halves, and the seam between them is on purpose
 *
 * `Materialiser` turns "notes at v1.2.0" into a directory holding a runnable
 * `run.sh`. `VersionRuns` runs that directory on a port of its own, shares the
 * process between every container pinned to the same version, and stops it
 * when none is.
 *
 * Today the only materialiser is `SourceMaterialiser`: a bare mirror of the
 * module's repository, a git worktree at the tag, and `bun install
 * --frozen-lockfile`. The distributed app will map the same tag to a prebuilt
 * release package instead, and that is a second implementation of the same
 * interface — nothing above it changes, including the picker in the frame
 * header. That is the whole reason for the seam.
 *
 * ## The module's own checkout is never touched
 *
 * Not switched, not fetched into, not given a worktree. The mirror is cloned
 * from the checkout's REMOTE, borrowing the checkout's objects only for speed
 * (`--reference-if-able … --dissociate`, which copies what it borrows and keeps
 * no link). The checkout may be somebody's working copy with a half-written
 * change in it; "latest" keeps meaning exactly that checkout.
 *
 * ## Where
 *
 * `versionsDir()` (`machineDirs.ts`): `<module>/repo.git`, `<module>/<tag>/`,
 * `<module>/<tag>.ready` once installed, `<module>/<tag>.log` for what its
 * `run.sh` printed, `<module>/facts.json` for what each tag's manifest said.
 * Machine-level, because it is program code and not a project's data.
 */

/** What preparing a version is doing, for the page: "Preparing Notes v1.2.0… installing". */
export type Step = 'fetching' | 'checking out' | 'installing' | 'starting'

/** The module a version is OF: its id, what to call it, its checkout, and the remote the tags are on. */
export interface Source {
  id: string
  name: string
  /** The module's own checkout, from its registration. Read from, never written to. */
  dir: string
  /** The repository the tags live on. */
  remote: string
}

/** A version on disk, ready to be run. */
export interface Tree {
  dir: string
  /** Absolute, inside `dir`. */
  script: string
}

export type Prepared = { ok: true; tree: Tree } | { ok: false; why: string }

/**
 * Turns a module and a tag into something runnable.
 *
 * The one interface the rest of the host knows. A future implementation that
 * unpacks a prebuilt package answers the same three questions.
 */
export interface Materialiser {
  /** Make the version runnable, saying each slow step as it starts. Idempotent. */
  prepare(source: Source, tag: string, step: (step: Step) => void): Promise<Prepared>
  /** Whether a version is already prepared, without preparing it. */
  prepared(id: string, tag: string): Tree | null
  /** Where a version's run log is written. */
  log(id: string, tag: string): string
}

const CLONE_TIMEOUT_MS = 5 * 60_000
const FETCH_TIMEOUT_MS = 2 * 60_000
const INSTALL_TIMEOUT_MS = 10 * 60_000

/** Whether a module id and a tag are safe to make a path out of. Both are checked, never trusted. */
function safe(id: string, tag: string): boolean {
  return MODULE_ID.test(id) && !id.includes('..') && isVersionTag(tag)
}

/**
 * A version from source: a worktree at the tag, its dependencies installed.
 */
export class SourceMaterialiser implements Materialiser {
  readonly #root: string
  readonly #run: Runner

  constructor(root: string, runner: Runner = run) {
    this.#root = root
    this.#run = runner
  }

  #module(id: string): string {
    return join(this.#root, id)
  }

  tree(id: string, tag: string): string {
    return join(this.#module(id), tag)
  }

  log(id: string, tag: string): string {
    return join(this.#module(id), `${tag}.log`)
  }

  prepared(id: string, tag: string): Tree | null {
    if (!safe(id, tag)) return null
    const dir = this.tree(id, tag)
    const script = join(dir, RUN_SCRIPT)
    return existsSync(join(this.#module(id), `${tag}.ready`)) && existsSync(script) ? { dir, script } : null
  }

  async prepare(source: Source, tag: string, step: (step: Step) => void): Promise<Prepared> {
    if (!safe(source.id, tag)) return { ok: false, why: `"${tag}" is not a version tag this host will run.` }
    const already = this.prepared(source.id, tag)
    if (already) return { ok: true, tree: already }

    const home = this.#module(source.id)
    const mirror = join(home, 'repo.git')
    const dir = this.tree(source.id, tag)
    const ready = join(home, `${tag}.ready`)
    mkdirSync(home, { recursive: true })

    step('fetching')
    if (!existsSync(join(mirror, 'HEAD'))) {
      rmSync(mirror, { recursive: true, force: true })
      const borrow = existsSync(source.dir) ? ['--reference-if-able', source.dir, '--dissociate'] : []
      const cloned = await this.#run(['git', 'clone', '--bare', '--quiet', ...borrow, source.remote, mirror], {
        timeoutMs: CLONE_TIMEOUT_MS,
      })
      if (!cloned.ok) {
        rmSync(mirror, { recursive: true, force: true })
        return { ok: false, why: `could not copy ${source.remote}: ${cloned.why}` }
      }
    }
    const fetched = await this.#run(
      ['git', '-C', mirror, 'fetch', '--quiet', '--force', source.remote, `refs/tags/${tag}:refs/tags/${tag}`],
      { timeoutMs: FETCH_TIMEOUT_MS },
    )
    if (!fetched.ok) return { ok: false, why: `could not fetch ${tag} from ${source.remote}: ${fetched.why}` }

    step('checking out')
    if (existsSync(dir)) {
      /* A tree from an attempt that did not finish. Taken away whole: it has no
         `.ready`, so nothing is running from it and nothing in it is anybody's. */
      await this.#run(['git', '-C', mirror, 'worktree', 'remove', '--force', dir])
      rmSync(dir, { recursive: true, force: true })
      await this.#run(['git', '-C', mirror, 'worktree', 'prune'])
    }
    const added = await this.#run(['git', '-C', mirror, 'worktree', 'add', '--detach', '--force', dir, `refs/tags/${tag}`])
    if (!added.ok) return { ok: false, why: `could not check out ${tag}: ${added.why}` }

    step('installing')
    if (existsSync(join(dir, 'package.json'))) {
      const frozen = existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))
      const installed = await this.#run(['bun', 'install', ...(frozen ? ['--frozen-lockfile'] : [])], {
        cwd: dir,
        timeoutMs: INSTALL_TIMEOUT_MS,
      })
      if (!installed.ok) return { ok: false, why: `bun install failed in ${tag}: ${installed.why}` }
      /* The stamp a module's `run.sh` looks for (see the protocol's template),
         so its first start does not install a second time. */
      if (existsSync(join(dir, 'node_modules'))) writeFileSync(join(dir, 'node_modules', '.kehikot-installed'), '')
    }

    const script = join(dir, RUN_SCRIPT)
    if (!existsSync(script)) return { ok: false, why: `${tag} has no ${RUN_SCRIPT}, so there is nothing to run.` }
    try {
      accessSync(script, constants.X_OK)
    } catch {
      return { ok: false, why: `${RUN_SCRIPT} in ${tag} is not executable.` }
    }
    writeFileSync(ready, `${tag}\n`)
    return { ok: true, tree: { dir, script } }
  }
}

/* ------------------------------------------------------------------ *
 * What each tag's manifest said, remembered
 * ------------------------------------------------------------------ */

/**
 * What a version's own manifest said about it, once it has run.
 *
 * Kept on disk so the picker can mark a tag incompatible or blocked without
 * running it again. `compatible` is the protocol verdict `discover.ts` reached;
 * `why` is its sentence when it said no.
 */
export interface Facts {
  dataVersion: number
  compatible: boolean
  why: string | null
  version: string | null
}

export class FactsStore {
  readonly #root: string
  constructor(root: string) {
    this.#root = root
  }

  #file(id: string): string {
    return join(this.#root, id, 'facts.json')
  }

  all(id: string): Record<string, Facts> {
    if (!MODULE_ID.test(id)) return {}
    try {
      const raw = JSON.parse(readFileSync(this.#file(id), 'utf8')) as Record<string, Facts>
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  get(id: string, tag: string): Facts | null {
    const all = this.all(id)
    return Object.hasOwn(all, tag) ? all[tag]! : null
  }

  set(id: string, tag: string, facts: Facts): void {
    if (!safe(id, tag)) return
    const all = this.all(id)
    const was = all[tag]
    if (was && JSON.stringify(was) === JSON.stringify(facts)) return
    all[tag] = facts
    const file = this.#file(id)
    mkdirSync(join(this.#root, id), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`)
    renameSync(tmp, file)
  }
}

/* ------------------------------------------------------------------ *
 * Running them: one process per module and version, shared
 * ------------------------------------------------------------------ */

export type RunState = 'preparing' | 'starting' | 'running' | 'failed'

export interface Instance {
  key: string
  id: string
  tag: string
  state: RunState
  /** The slow step under way while preparing or starting. */
  step: Step | null
  port: number | null
  origin: string | null
  /** Why it failed, when it did. */
  why: string | null
  /** When it was last on a kehikko somebody had open. */
  neededAt: number
}

export interface RunDeps {
  materialiser: Materialiser
  /** The module a version is of, from its registration — or why there is none. */
  source(id: string): Promise<Source | { why: string }>
  /** A port where this exact tree is ALREADY running — left by a host that restarted — or null. */
  adoptable(id: string, tag: string, tree: Tree): Promise<number | null>
  /** A free port beside the module's own, avoiding the ones given. */
  port(id: string, taken: ReadonlySet<number>): Promise<number | null>
  /** Run the tree's script with `PORT` set. Keeps the child where it can be stopped by `key`. */
  spawn(key: string, tree: Tree, port: number, log: string): { ok: true } | { ok: false; why: string }
  /** Whether a module answers at that origin within a while. */
  answered(origin: string): Promise<boolean>
  /** Stop what runs for `key`. Only ever a process this host started or proved to be the tree. */
  stop(key: string, instance: Instance): void
  /** Something about an instance changed; the pages should look again. */
  changed(): void
  log?(line: string): void
}

export const versionKey = (id: string, tag: string): string => `${id}@${tag}`

/**
 * Every version this host is running or preparing.
 *
 * ## Shared, and counted
 *
 * Containers are what pin, and containers pinned to the same module and tag
 * share ONE process: `ensure` hands back the instance that already exists. A
 * second process exists only when a second version is wanted. `reconcile` is
 * told how many containers pin each version and which of them are on a kehikko
 * somebody has open, and from that alone decides:
 *
 *  - pinned by a container on an open kehikko, and not running → prepare and start it;
 *  - pinned by no container anywhere → stop it now;
 *  - pinned, but on no open kehikko for `grace` → stop it, as `lifecycle.ts`
 *    stops a module nobody is looking at.
 *
 * A failed instance stays failed — and says why — until `retry`, so a version
 * that will not install is not reinstalled on every sweep.
 */
export class VersionRuns {
  #runs = new Map<string, Instance>()
  readonly #deps: RunDeps
  readonly #grace: number
  readonly #now: () => number
  /** Keys a reconcile last saw pinned anywhere, so a preparation finishing late can tell it is no longer wanted. */
  #pinned = new Set<string>()

  constructor(deps: RunDeps, grace = GRACE_MS, now: () => number = Date.now) {
    this.#deps = deps
    this.#grace = grace
    this.#now = now
  }

  get(id: string, tag: string): Instance | null {
    return this.#runs.get(versionKey(id, tag)) ?? null
  }

  all(): Instance[] {
    return [...this.#runs.values()]
  }

  /** The instance for this version, started if there is none. Never a second one. */
  ensure(id: string, tag: string): Instance {
    const key = versionKey(id, tag)
    const was = this.#runs.get(key)
    if (was) {
      was.neededAt = this.#now()
      return was
    }
    const instance: Instance = {
      key,
      id,
      tag,
      state: 'preparing',
      step: null,
      port: null,
      origin: null,
      why: null,
      neededAt: this.#now(),
    }
    this.#runs.set(key, instance)
    this.#pinned.add(key)
    void this.#bring(instance)
    return instance
  }

  /** Forget a failure and try again. */
  retry(id: string, tag: string): Instance {
    const was = this.#runs.get(versionKey(id, tag))
    if (was?.state === 'failed') this.#runs.delete(was.key)
    return this.ensure(id, tag)
  }

  /**
   * Start what open kehikot need, stop what nothing pins.
   *
   * `uses` counts the containers pinned to each version key, on every
   * kehikko; `needed` is the keys pinned by a container on a kehikko a page
   * has open. `mayStart` false is the reaper's tick, which stops and never
   * starts — the same split `govern` and the reaper have for modules. Returns
   * the keys it stopped.
   */
  reconcile(uses: ReadonlyMap<string, number>, needed: ReadonlySet<string>, mayStart = true): string[] {
    const now = this.#now()
    this.#pinned = new Set([...uses.entries()].filter(([, n]) => n > 0).map(([key]) => key))
    for (const key of needed) {
      const at = key.lastIndexOf('@')
      const was = this.#runs.get(key)
      if (was) was.neededAt = now
      else if (mayStart) this.ensure(key.slice(0, at), key.slice(at + 1))
    }
    const stopped: string[] = []
    for (const instance of [...this.#runs.values()]) {
      const pinned = (uses.get(instance.key) ?? 0) > 0
      const idle = !needed.has(instance.key) && now - instance.neededAt >= this.#grace
      if (pinned && !idle) continue
      if (instance.state === 'failed') {
        if (!pinned) this.#runs.delete(instance.key)
        continue
      }
      /* Preparing: nothing is running yet. `#bring` checks `#pinned` before it
         spawns, and an unpinned preparation ends there. */
      if (instance.state === 'preparing') continue
      this.#deps.stop(instance.key, instance)
      this.#runs.delete(instance.key)
      stopped.push(instance.key)
      this.#deps.log?.(
        `kehikko: stopped ${instance.key} — ${pinned ? 'no open kehikko has had it for the grace period' : 'no container is pinned to it any more'}`,
      )
    }
    if (stopped.length) this.#deps.changed()
    return stopped
  }

  async #bring(instance: Instance): Promise<void> {
    const deps = this.#deps
    const fail = (why: string) => {
      instance.state = 'failed'
      instance.step = null
      instance.why = why
      deps.log?.(`kehikko: ${instance.key} could not be run — ${why}`)
      deps.changed()
    }
    try {
      const source = await deps.source(instance.id)
      if ('why' in source) return fail(source.why)

      const prepared = await deps.materialiser.prepare(source, instance.tag, (step) => {
        instance.step = step
        deps.changed()
      })
      if (!prepared.ok) return fail(prepared.why)
      if (!this.#pinned.has(instance.key)) {
        this.#runs.delete(instance.key)
        deps.changed()
        return
      }

      instance.step = 'starting'
      instance.state = 'starting'
      deps.changed()

      const adopted = await deps.adoptable(instance.id, instance.tag, prepared.tree)
      let port = adopted
      if (port === null) {
        const taken = new Set(this.all().flatMap((one) => (one.port === null ? [] : [one.port])))
        port = await deps.port(instance.id, taken)
        if (port === null) return fail('there is no free port to run it on')
        instance.port = port
        const spawned = deps.spawn(instance.key, prepared.tree, port, deps.materialiser.log(instance.id, instance.tag))
        if (!spawned.ok) return fail(spawned.why)
        deps.log?.(`kehikko: started ${instance.key} on port ${port}`)
      }
      instance.port = port
      instance.origin = `http://127.0.0.1:${port}`
      if (!(await deps.answered(instance.origin))) {
        return fail(`it was started on port ${port} and did not answer. Its output is in ${deps.materialiser.log(instance.id, instance.tag)}.`)
      }
      instance.state = 'running'
      instance.step = null
      deps.changed()
    } catch (error) {
      fail((error as Error).message)
    }
  }
}
