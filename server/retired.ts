import { existsSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import { editCanvas, listCanvases, type PlacementInput } from './canvases.ts'
import type { Retired } from './official.ts'
import { idOfFile } from './registrations.ts'

/**
 * A module the official list retired, still on this machine, and Uninstall.
 *
 * The list (`modules.json`'s `retired`, read by `officialSource.ts`) says which modules are
 * deprecated. Nothing is ever removed by itself: a person installed it, or put their own checkout
 * there, and containers on their kehikot may hold it. Every registered module the list retires
 * carries a note on its presence (`noteOf`) — wherever its directory is — which the modules menu
 * draws as a "Deprecated" badge, with "Replaced by <successor>." when the list names one.
 *
 * `uninstall`, on a press and for ANY registered module, takes it off this computer:
 *  - its containers come off every kehikko (`editCanvas`, then the kehikko is told to re-read);
 *  - its process, if this host holds one, is stopped;
 *  - its registration file is deleted;
 *  - a copy under `installed/<id>/` (what this host installed) is deleted. A registration that
 *    names another directory is somebody's own checkout: it is unregistered and the folder left whole.
 *
 * Nothing under a project's `.kehikot/<module>/` is touched: what the module kept stays.
 * The host names no module here; every id and word arrives from the list or the registry.
 */
export interface RetireDeps {
  db: Database
  retired: () => readonly Retired[]
  /** `installed/`, where this host puts what it installs. */
  root: string
  /** Where registrations are. */
  registry: string
  registered: () => Promise<{ id: string; dir?: string | undefined }[]>
  stop: (id: string) => void
  /** Write a project's kehikot file after its arrangement changed. */
  keep: (project: number | null) => void
  woke: (kehikko: number) => void
  registryChanged: () => void
  log: (line: string) => void
}

/** The host speaks as itself, under the name it goes by. */
export const BY = { module: 'kehikko', name: 'Kehikot' } as const

/** What a presence says of a retired module: the list's words, and the successor when it names one. */
export interface RetiredNote {
  says: string
  successor?: { id: string; name: string }
}

/** The note for a module, or nothing when the list does not retire it. `nameOf` is the successor's name, when known. */
export function noteOf(retired: readonly Retired[], id: string, nameOf: (id: string) => string | null): RetiredNote | null {
  const entry = retired.find((one) => one.id === id)
  if (!entry) return null
  const name = entry.replacedBy ? nameOf(entry.replacedBy) : null
  return { says: entry.says, ...(entry.replacedBy && name ? { successor: { id: entry.replacedBy, name } } : {}) }
}

const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Whether a registration's directory is somebody's own checkout rather than the copy under `installed/<id>/`. No directory is not a copy of ours. */
export function isOwnCheckout(dir: string | undefined, copy: string): boolean {
  return dir === undefined || real(dir) !== real(copy)
}

export function retireDesk(deps: RetireDeps) {
  function files(id: string): string[] {
    try {
      return readdirSync(deps.registry)
        .filter((file) => /\.(json|ya?ml)$/i.test(file) && idOfFile(file) === id)
        .map((file) => join(deps.registry, file))
    } catch {
      return []
    }
  }

  /** Take a module off this computer, on the person's press. Its data in projects stays. */
  async function uninstall(id: string): Promise<{ ok: true; removed: string; own: boolean } | { ok: false; why: string; status: number }> {
    if (!/^[a-z0-9][\w.-]{0,63}$/i.test(id)) return { ok: false, why: 'An uninstall names one module.', status: 400 }
    const copy = join(deps.root, id)
    const registration = (await deps.registered()).find((r) => r.id === id)
    const registrations = files(id)
    const copied = existsSync(copy)
    if (!registration && registrations.length === 0 && !copied) return { ok: false, why: `${id} is not on this computer.`, status: 404 }
    const own = registration !== undefined && isOwnCheckout(registration.dir, copy)

    for (const canvas of listCanvases(deps.db).filter((c) => c.placements.some((p) => p.i === id))) {
      editCanvas(deps.db, canvas.id, { placements: canvas.placements.filter((p) => p.i !== id) as PlacementInput[] })
      deps.keep(canvas.project)
      deps.woke(canvas.id)
    }
    deps.stop(id)
    for (const file of registrations) rmSync(file, { force: true })
    if (copied) rmSync(copy, { recursive: true, force: true })
    deps.registryChanged()
    deps.log(`kehikko: ${id} was uninstalled on a press: its containers and registration${own ? '' : ' and installed copy'} are gone; project data${own ? ' and its own folder' : ''} is kept`)
    return { ok: true, removed: id, own }
  }

  return { uninstall }
}
