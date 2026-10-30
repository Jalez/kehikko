import { existsSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'

import { editCanvas, listCanvases, type PlacementInput } from './canvases.ts'
import type { Inbox } from './inbox.ts'
import type { Retired } from './official.ts'
import { idOfFile } from './registrations.ts'

/**
 * A module the official list retired is taken off this machine.
 *
 * The list (`modules.json`'s `retired`, read by `officialSource.ts`) says which. For each one
 * that is still here, in any of three ways — a container on a kehikko, a registration, an
 * installed copy — this does, in order:
 *
 *  - its containers come off every kehikko, by the same `editCanvas` a person's own change
 *    uses, and the kehikko is told to re-read;
 *  - its process, if this host holds one, is stopped (`stop`, the nursery's, by handle);
 *  - its registration file and its copy under `installed/<id>/` are deleted — and only those:
 *    a registration that names another directory is somebody's own checkout, and a module so
 *    kept is left entirely alone (a developer's working copy is not retired by a list);
 *  - every project's Inbox is told once, by the host: "<name> was retired from the module
 *    list and removed: <says>".
 *
 * Nothing under a project's `.kehikot/<module>/` is touched: what the module kept stays.
 * The host names no module here; every id and word arrives from the list.
 */
export interface RetireDeps {
  db: Database
  inbox: Inbox
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
  projects: () => { id: number }[]
  changed: (project: number, rev: number) => void
  registryChanged: () => void
  log: (line: string) => void
}

/** The host speaks as itself, under the name it goes by. */
export const BY = { module: 'kehikko', name: 'Kehikot' } as const

const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export function retireDesk(deps: RetireDeps) {
  let running: Promise<number> | null = null

  function files(id: string): string[] {
    try {
      return readdirSync(deps.registry)
        .filter((file) => /\.(json|ya?ml)$/i.test(file) && idOfFile(file) === id)
        .map((file) => join(deps.registry, file))
    } catch {
      return []
    }
  }

  async function one(entry: Retired): Promise<boolean> {
    const copy = join(deps.root, entry.id)
    const registration = (await deps.registered()).find((r) => r.id === entry.id)
    if (registration?.dir !== undefined && real(registration.dir) !== real(copy)) return false

    const placed = listCanvases(deps.db).filter((canvas) => canvas.placements.some((p) => p.i === entry.id))
    const registrations = files(entry.id)
    const copied = existsSync(copy)
    if (placed.length === 0 && registrations.length === 0 && !copied) return false

    for (const canvas of placed) {
      editCanvas(deps.db, canvas.id, { placements: canvas.placements.filter((p) => p.i !== entry.id) as PlacementInput[] })
      deps.keep(canvas.project)
      deps.woke(canvas.id)
    }
    deps.stop(entry.id)
    for (const file of registrations) rmSync(file, { force: true })
    if (copied) rmSync(copy, { recursive: true, force: true })

    const message = `${entry.name} was retired from the module list and removed: ${entry.says}`
    for (const project of deps.projects()) {
      const out = deps.inbox.notice(project.id, BY.module, BY.name, { epic: '', message, level: 'done', refs: [] })
      deps.changed(project.id, out.rev)
    }
    deps.registryChanged()
    deps.log(`kehikko: ${entry.id} was retired from the module list: its containers, registration and installed copy are removed; project data is kept`)
    return true
  }

  /** Remove what the list retired and is still here. Never throws; resolves with how many it removed. */
  function sweep(): Promise<number> {
    if (running) return running
    running = (async () => {
      let removed = 0
      for (const entry of deps.retired()) {
        try {
          if (await one(entry)) removed += 1
        } catch (error) {
          deps.log(`kehikko: retiring ${entry.id} did not finish: ${(error as Error).message}`)
        }
      }
      return removed
    })().finally(() => {
      running = null
    })
    return running
  }

  return { sweep }
}
