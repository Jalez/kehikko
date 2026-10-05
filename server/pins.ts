import type { Database } from 'bun:sqlite'

import { editCanvas, listCanvases, type Canvas } from './canvases.ts'
import { readDataVersions, recordDataVersion, recordedFor, refusal } from './dataVersions.ts'
import type { Presence } from './discover.ts'
import { projectById } from './projects.ts'
import type { Registration } from './registrations.ts'
import { isVersionTag, remoteOf, type Runner, type TagLister } from './versions.ts'
import { versionKey, type FactsStore, type Instance, type Materialiser, type VersionRuns } from './versionRuns.ts'

/**
 * Pinning a container to a version of its module, and what each pin is doing.
 *
 * The glue between the canvases (which say which container wants which
 * version), the runs (`versionRuns.ts`, which run them), the tags
 * (`versions.ts`, which say what exists) and the data guard
 * (`dataVersions.ts`, which says what may run against a project). Both doors
 * use it — the page's `/host/versions` and the agent's `pin_version` — so a
 * pin is refused for the same reasons in the same words whoever asks.
 *
 * ## "Latest" is not a pin
 *
 * A container with no version runs the module's own checkout, exactly as
 * before versions existed: the same process, the same port, the same
 * registration. Nothing here touches it. Unpinning is setting the field back
 * to null.
 */

/** One tag as the picker shows it. */
export interface VersionEntry {
  tag: string
  /** Whether this host can speak to it: null until its manifest has been read, which happens when it is first prepared. */
  compatible: boolean | null
  /** Why not, when it is not. */
  incompatible: string | null
  /** The data format it declares, when known. */
  dataVersion: number | null
  /** Why it may not run against this kehikko's project, or null. */
  blocked: string | null
  /** Already on disk and installed, so choosing it is quick. */
  prepared: boolean
  /** Running right now for some container. */
  running: boolean
}

/** Everything the picker in a container's header shows. */
export interface VersionListing {
  module: string
  name: string
  /** The module's own checkout: what its manifest calls itself, and its commit. */
  latest: { version: string | null; commit: string | null; dataVersion: number | null }
  /** The tag this container is pinned to, or null for latest. */
  pinned: string | null
  /** The highest data format recorded for this module in this kehikko's project. */
  recorded: number | null
  versions: VersionEntry[]
  /** Said when the module has no version tags at all. */
  hint: string | null
  /** Why the tags could not be read, when they could not. */
  error: string | null
}

/** What one pinned container is doing, for its header and its frame. */
export interface PinView {
  kehikko: number
  module: string
  version: string
  state: 'waiting' | 'preparing' | 'starting' | 'ready' | 'failed' | 'blocked' | 'incompatible'
  /** The sentence the container shows while it is not ready. */
  line: string
  /** The version's own presence, at its own port — only when `ready`. */
  presence: Presence | null
}

export type Pinned = { ok: true; text: string; canvas: Canvas } | { ok: false; why: string; status: number }

export interface PinsDeps {
  db: Database
  runs: VersionRuns
  facts: FactsStore
  tags: TagLister
  materialiser: Materialiser
  runner: Runner
  /** A registration from the last sweep, or the disk. */
  registration(id: string): Promise<Registration | null>
  /** The module's latest presence from the last sweep, if any. */
  latest(id: string): Presence | null
  /** Ask a version what it is — `discover.ts`'s `look`, at the version's origin. */
  look(id: string, origin: string): Promise<Presence>
  /** The page holding that kehikko should re-read it. */
  wake(canvas: number): void
  /** Write the project's `kehikot.json`. */
  keep(project: number | null): void
}

/** How many containers pin each version, on every kehikko. */
export function pinUses(canvases: readonly Canvas[]): Map<string, number> {
  const uses = new Map<string, number>()
  for (const canvas of canvases) {
    for (const p of canvas.placements) {
      if (!p.version) continue
      const key = versionKey(p.i, p.version)
      uses.set(key, (uses.get(key) ?? 0) + 1)
    }
  }
  return uses
}

/** The versions pinned by a container on a kehikko a page has open. */
export function pinsNeeded(canvases: readonly Canvas[], open: ReadonlySet<number>): Set<string> {
  const needed = new Set<string>()
  for (const canvas of canvases) {
    if (!open.has(canvas.id)) continue
    for (const p of canvas.placements) if (p.version) needed.add(versionKey(p.i, p.version))
  }
  return needed
}

/** Per module: how many containers are pinned, and to which versions. For the Updates panel. */
export function pinSummary(canvases: readonly Canvas[]): Record<string, { containers: number; versions: string[] }> {
  const out: Record<string, { containers: number; versions: string[] }> = {}
  for (const canvas of canvases) {
    for (const p of canvas.placements) {
      if (!p.version) continue
      const one = (out[p.i] ??= { containers: 0, versions: [] })
      one.containers += 1
      if (!one.versions.includes(p.version)) one.versions.push(p.version)
    }
  }
  return out
}

/** The sentence a container shows while its version is on the way. */
export function preparingLine(name: string, tag: string, instance: Instance | null): string {
  if (!instance) return `${name} ${tag} starts when this kehikko is open.`
  if (instance.state === 'failed') return `${name} ${tag} could not be run: ${instance.why ?? 'no reason given'}`
  const step = instance.step ?? 'getting ready'
  return `Preparing ${name} ${tag}… ${step}${step === 'installing' ? ' (the first time takes a minute)' : ''}`
}

export class Pins {
  readonly #deps: PinsDeps
  constructor(deps: PinsDeps) {
    this.#deps = deps
  }

  #projectPath(canvas: Canvas): string | null {
    return canvas.project === null ? null : (projectById(this.#deps.db, canvas.project)?.path ?? null)
  }

  #name(id: string): string {
    return this.#deps.latest(id)?.name ?? id
  }

  /** The tags of a module, newest first, each marked for this kehikko. */
  async list(module: string, canvasId: number, fresh = false): Promise<VersionListing | { why: string; status: number }> {
    const deps = this.#deps
    const canvas = listCanvases(deps.db).find((c) => c.id === canvasId)
    if (!canvas) return { why: `there is no kehikko with id ${canvasId}.`, status: 404 }
    const registration = await deps.registration(module)
    if (!registration) return { why: `${module} is not registered on this computer.`, status: 404 }

    const name = this.#name(module)
    const latestPresence = deps.latest(module)
    const placement = canvas.placements.find((p) => p.i === module) ?? null
    const path = this.#projectPath(canvas)
    const recorded = path ? recordedFor(readDataVersions(path), module) : null

    let commit: string | null = null
    if (registration.dir) {
      const head = await deps.runner(['git', '-C', registration.dir, 'rev-parse', '--short', 'HEAD'])
      if (head.ok) commit = head.out
    }
    const latest = {
      version: latestPresence?.module?.version ?? null,
      commit,
      dataVersion: latestPresence?.module?.dataVersion ?? null,
    }
    const base: VersionListing = {
      module,
      name,
      latest,
      pinned: placement?.version ?? null,
      recorded,
      versions: [],
      hint: null,
      error: null,
    }

    if (!registration.dir) {
      return {
        ...base,
        hint: `${name} is registered without a directory, so this host cannot read its versions. Only the running copy is available.`,
      }
    }
    const remote = await remoteOf(registration.dir, deps.runner)
    if (!remote) {
      return { ...base, hint: `${registration.dir} has no remote to read versions from, so only its checkout is available.` }
    }
    const got = await deps.tags.tags(remote, fresh)
    if (!got.ok) return { ...base, error: `could not read the versions from ${remote}: ${got.why}` }
    if (!got.tags.length) {
      return {
        ...base,
        hint: `${name} has no releases yet. Its author can publish one by tagging, e.g. git tag v1.0.0 && git push --tags.`,
      }
    }

    const facts = deps.facts.all(module)
    const versions = got.tags.map((tag): VersionEntry => {
      const known = Object.hasOwn(facts, tag) ? facts[tag]! : null
      const instance = deps.runs.get(module, tag)
      const dataVersion = known?.dataVersion ?? null
      return {
        tag,
        compatible: known ? known.compatible : null,
        incompatible: known && !known.compatible ? known.why : null,
        dataVersion,
        blocked: refusal(name, tag, dataVersion, recorded),
        prepared: deps.materialiser.prepared(module, tag) !== null,
        running: instance?.state === 'running',
      }
    })
    return { ...base, versions }
  }

  /**
   * Pin a container to a tag, or (`version: null`) back to latest.
   *
   * Refused, with a sentence, when the container is not on that kehikko, the
   * tag is not one of the module's versions, the version is known not to
   * speak this host's protocol, or the data guard says no. A version whose
   * manifest has never been read is allowed: it is prepared, read, and then
   * framed only if it passes — see `views`.
   */
  async pin(canvasId: number, module: string, version: string | null): Promise<Pinned> {
    const deps = this.#deps
    const canvas = listCanvases(deps.db).find((c) => c.id === canvasId)
    if (!canvas) return { ok: false, why: `there is no kehikko with id ${canvasId}.`, status: 404 }
    const placement = canvas.placements.find((p) => p.i === module)
    if (!placement) {
      return {
        ok: false,
        why: `${module} is not a container on kehikko ${canvas.id} (${canvas.name}); place it first.`,
        status: 409,
      }
    }
    const name = this.#name(module)

    if (version === null) {
      if (placement.version === null) {
        return { ok: true, text: `${name} on kehikko ${canvas.id} (${canvas.name}) already runs latest. Nothing changed.`, canvas }
      }
      const written = this.#write(canvas, module, null)
      if (!written) return { ok: false, why: `kehikko ${canvas.id} was there a moment ago and is not now.`, status: 409 }
      return {
        ok: true,
        text: `${name} on kehikko ${canvas.id} (${canvas.name}) runs latest again — its own checkout — instead of ${placement.version}.`,
        canvas: written,
      }
    }

    if (!isVersionTag(version)) {
      return { ok: false, why: `"${String(version).slice(0, 80)}" is not a version tag such as v1.2.0.`, status: 400 }
    }
    const listing = await this.list(module, canvasId)
    if ('why' in listing) return { ok: false, why: listing.why, status: listing.status }
    const entry = listing.versions.find((one) => one.tag === version)
    if (!entry) {
      const offline = listing.error !== null && deps.materialiser.prepared(module, version) !== null
      if (!offline) {
        const known = listing.versions.map((one) => one.tag)
        return {
          ok: false,
          why:
            `${version} is not a version of ${name}. `
            + (listing.error
              ? listing.error
              : known.length
                ? `Its versions are: ${known.join(', ')}.`
                : (listing.hint ?? 'It has no versions.')),
          status: 409,
        }
      }
    }
    if (entry?.blocked) return { ok: false, why: entry.blocked, status: 409 }
    if (entry?.compatible === false) {
      return { ok: false, why: `${name} ${version} cannot be run by this host: ${entry.incompatible ?? 'it speaks another protocol'}`, status: 409 }
    }

    if (placement.version === version) {
      deps.runs.ensure(module, version)
      return { ok: true, text: `${name} on kehikko ${canvas.id} (${canvas.name}) is already pinned to ${version}. Nothing changed.`, canvas }
    }
    const written = this.#write(canvas, module, version)
    if (!written) return { ok: false, why: `kehikko ${canvas.id} was there a moment ago and is not now.`, status: 409 }
    const instance = deps.runs.retry(module, version)
    const sharing = pinUses(listCanvases(deps.db)).get(versionKey(module, version)) ?? 1
    return {
      ok: true,
      text:
        `${name} on kehikko ${canvas.id} (${canvas.name}) is pinned to ${version}. `
        + (instance.state === 'running'
          ? `It is already running on port ${instance.port}${sharing > 1 ? `, shared with ${sharing - 1} other container${sharing === 2 ? '' : 's'}` : ''}.`
          : entry?.prepared
            ? 'It is starting.'
            : 'It is being prepared — fetched, checked out and installed — which the first time takes a minute.'),
      canvas: written,
    }
  }

  #write(canvas: Canvas, module: string, version: string | null): Canvas | null {
    const placements = canvas.placements.map((p) => (p.i === module ? { ...p, version } : p))
    const written = editCanvas(this.#deps.db, canvas.id, { placements })
    if (!written) return null
    this.#deps.keep(written.project)
    this.#deps.wake(canvas.id)
    return written
  }

  /**
   * What every pinned container is doing, and the data versions it implies.
   *
   * Asks each RUNNING version for its manifest — once per version, however
   * many containers share it — records what it said, and decides per
   * container: ready, blocked by the data guard, or incompatible. For a
   * container on an open kehikko that is ready, the version's data format is
   * recorded for its project: that is the moment it is used.
   */
  async views(open: ReadonlySet<number>): Promise<PinView[]> {
    const deps = this.#deps
    const canvases = listCanvases(deps.db)
    const asked = new Map<string, Promise<Presence>>()
    const out: PinView[] = []
    for (const canvas of canvases) {
      const path = this.#projectPath(canvas)
      for (const p of canvas.placements) {
        if (!p.version) continue
        const tag = p.version
        const name = this.#name(p.i)
        const base = { kehikko: canvas.id, module: p.i, version: tag }
        const instance = deps.runs.get(p.i, tag)
        if (!instance || instance.state !== 'running' || !instance.origin) {
          out.push({
            ...base,
            state: !instance ? 'waiting' : instance.state === 'failed' ? 'failed' : instance.state === 'starting' ? 'starting' : 'preparing',
            line: preparingLine(name, tag, instance),
            presence: null,
          })
          continue
        }
        const key = instance.key
        if (!asked.has(key)) asked.set(key, deps.look(p.i, instance.origin))
        const presence = await asked.get(key)!
        if (presence.condition === 'incompatible') {
          deps.facts.set(p.i, tag, { dataVersion: 1, compatible: false, why: presence.line, version: null })
          out.push({ ...base, state: 'incompatible', line: `${name} ${tag} cannot be run by this host: ${presence.line}`, presence: null })
          continue
        }
        if (presence.condition !== 'ready' || !presence.module) {
          out.push({ ...base, state: 'starting', line: presence.line, presence: null })
          continue
        }
        const dataVersion = presence.module.dataVersion ?? 1
        deps.facts.set(p.i, tag, { dataVersion, compatible: true, why: null, version: presence.module.version })
        const recorded = path ? recordedFor(readDataVersions(path), p.i) : null
        const blocked = refusal(name, tag, dataVersion, recorded)
        if (blocked) {
          out.push({ ...base, state: 'blocked', line: blocked, presence: null })
          continue
        }
        if (path && open.has(canvas.id)) recordDataVersion(path, p.i, dataVersion)
        out.push({ ...base, state: 'ready', line: presence.line, presence: { ...presence, name: presence.name ?? name } })
      }
    }
    return out
  }

  /**
   * Record the data format of every LATEST container on an open kehikko.
   *
   * Latest is the module's own checkout; when it is framed in a project, its
   * format is the one that project's data is now in.
   */
  recordLatest(open: ReadonlySet<number>, presences: readonly Presence[]): void {
    const byId = new Map(presences.map((p) => [p.id, p]))
    for (const canvas of listCanvases(this.#deps.db)) {
      if (!open.has(canvas.id)) continue
      const path = this.#projectPath(canvas)
      if (!path) continue
      for (const p of canvas.placements) {
        if (p.version) continue
        const module = byId.get(p.i)?.module
        if (module) recordDataVersion(path, p.i, module.dataVersion ?? 1)
      }
    }
  }
}
