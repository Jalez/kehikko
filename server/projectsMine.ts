import { existsSync } from 'node:fs'

import { LIMITS, moduleDir, type PickedProject } from 'kehikot-module-protocol'

import { pickedFrom } from '../src/host/projects.ts'
import { isReadOnlyRoot } from './projectRoot.ts'
import type { Project } from './projects.ts'

/**
 * `projects.mine` (protocol 2.76.0): the person's projects in which the ASKING module keeps its own
 * folder (`<project>/.kehikot/<module>/`), in the order the person keeps them.
 *
 * A module's server asks it at start, so that what it runs for a project — a conversation a message
 * is to be typed into — is picked up after a restart before anybody opens that project again. The
 * answer is never the person's whole list: only folders the module itself wrote into, so a module
 * learns nothing about the disk it did not already hold. A project whose folder is gone, or the
 * unpicked home folder nothing is written under, is never named.
 */
export function projectsMine(projects: readonly Project[], module: string, has: (dir: string) => boolean = existsSync): PickedProject[] {
  const out: PickedProject[] = []
  for (const project of projects) {
    if (project.missing || project.home || isReadOnlyRoot(project.path)) continue
    let dir: string | null
    try {
      dir = moduleDir(project.path, module)
    } catch {
      return []
    }
    if (!dir || !has(dir)) continue
    out.push(pickedFrom(project))
    if (out.length >= LIMITS.PROJECTS_KNOWN) break
  }
  return out
}
