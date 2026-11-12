import type { Database } from 'bun:sqlite'

import { containersOf } from '../src/host/layouts.ts'
import { copiedPlacements, takeIn, type CopyTake, type ElsewhereKehikko, type ElsewhereProject } from '../src/host/fromProject.ts'
import { projectVisitKey } from '../src/host/pickerOrder.ts'
import { createCanvas, editCanvas, listCanvases, type Canvas } from './canvases.ts'
import { editKehikkoSettings, readKehikkoSettings } from './kehikkoSettings.ts'
import { listKehikkoSkills, saveKehikkoSkill } from './kehikkoSkills.ts'
import { keep, shared } from './kehikot.ts'
import { readVisits } from './pickerOrder.ts'
import { listProjects, projectById } from './projects.ts'

/**
 * A kehikko made from one in another project: what the New kehikko dialog lists under "From another
 * project" (`elsewhere`) and what its Create and the door's `create_kehikko` with `from` do
 * (`copyKehikko`). The rules — what is copied and what is not — are `src/host/fromProject.ts`.
 *
 * Everything read here is the frame's (`frame.sqlite`: the kehikot, their settings, the visits) and
 * the source kehikko's skill files; nothing of the other project's data is read, and nothing is
 * written into it. What is written is the new kehikko (its row and, through `keep`, the project's
 * `kehikot.json`), its skills in this project, and its primary agent in the frame.
 */

function kehikkoOf(db: Database, canvas: Canvas, path: string | null): ElsewhereKehikko {
  const settings = canvas.project === null ? null : readKehikkoSettings(db, canvas.project, canvas.key)
  const on = new Set(canvas.placements.map((p) => p.i))
  return {
    id: canvas.id,
    key: canvas.key,
    name: canvas.name,
    /* As a layout has them: unfolded, so the picture is the arrangement and not one person's folds. */
    containers: containersOf(shared(canvas.placements)),
    folded: canvas.placements.filter((p) => p.collapsed || p.tiled).length,
    skills: path ? listKehikkoSkills(path, canvas.key).map((one) => one.name) : [],
    primary: settings?.primary && on.has(settings.primary) ? settings.primary : null,
    connections: canvas.connections.off.length > 0 || canvas.connections.only.length > 0,
  }
}

/** Every project but `except`, recent first, each with its kehikot in their order. */
export function elsewhere(db: Database, except: number | null): ElsewhereProject[] {
  const visits = readVisits(db).projects
  const canvases = listCanvases(db)
  return listProjects(db)
    .filter((one) => one.id !== except)
    .map((one) => ({
      id: one.id,
      name: one.name,
      path: one.path,
      visited: visits[projectVisitKey(one.id)] ?? null,
      missing: one.missing === true,
      kehikot: canvases.filter((c) => c.project === one.id).map((c) => kehikkoOf(db, c, one.missing ? null : one.path)),
    }))
    .sort((a, b) => (b.visited ?? 0) - (a.visited ?? 0) || a.name.localeCompare(b.name))
}

export interface Copied {
  ok: true
  canvas: Canvas
  /** The source, for a sentence. */
  from: { name: string; project: string }
  /** Which groups came with it, as copied — a group ticked but empty is false. */
  took: CopyTake
  skills: string[]
  primary: string | null
  /** A skill that would not copy, and why, said rather than thrown. */
  trouble: string[]
}

/**
 * Make a kehikko in project `into` from kehikko `from`, with the groups `take` ticks. `name` empty is
 * the source's name. Refused with a sentence when either end is not there; nothing is written then.
 */
export function copyKehikko(
  db: Database,
  ask: { from?: unknown; into?: unknown; name?: unknown; take?: unknown },
): Copied | { ok: false; why: string; status: number } {
  const source = listCanvases(db).find((one) => one.id === ask.from)
  if (!source) return { ok: false, why: 'There is no kehikko with that id to copy.', status: 404 }
  const into = typeof ask.into === 'number' ? projectById(db, ask.into) : null
  if (!into) return { ok: false, why: 'There is no project with that id to make the kehikko in.', status: 404 }
  if (into.missing) return { ok: false, why: `${into.name}’s folder is not there, so no kehikko was made in it.`, status: 409 }
  const take = takeIn(ask.take)
  const fromProject = source.project === null ? null : projectById(db, source.project)
  const fromPath = fromProject && !fromProject.missing ? fromProject.path : null
  const name = typeof ask.name === 'string' && ask.name.trim() ? ask.name : source.name

  const made = createCanvas(db, name, into.id)
  const placements = copiedPlacements(source.placements)
  const canvas = editCanvas(db, made.id, { placements, ...(take.general ? { connections: source.connections } : {}) }) ?? made

  const trouble: string[] = []
  const skills: string[] = []
  if (take.skills && fromPath) {
    for (const one of listKehikkoSkills(fromPath, source.key)) {
      const saved = saveKehikkoSkill(into.path, canvas.key, { name: one.name, description: one.description, body: one.body })
      if (saved.ok) skills.push(one.name)
      else trouble.push(`The skill ${one.name} was not copied: ${saved.why}`)
    }
  }

  let primary: string | null = null
  if (take.agents && source.project !== null) {
    const was = readKehikkoSettings(db, source.project, source.key).primary
    if (was && placements.some((p) => p.i === was)) {
      const set = editKehikkoSettings(db, into.id, canvas.key, { primary: was }, [was])
      if (set.ok) primary = was
    }
  }

  keep(db, into.id)
  return {
    ok: true,
    canvas,
    from: { name: source.name, project: fromProject?.name ?? 'no project' },
    took: { general: take.general, skills: skills.length > 0, agents: primary !== null },
    skills,
    primary,
    trouble,
  }
}

/** What was made, in a sentence for the page and the door. `names` says a module id as its name. */
export function copiedSaid(copied: Copied, notInstalled: readonly string[], names: ReadonlyMap<string, string> = new Map()): string {
  const { canvas, from } = copied
  const count = canvas.placements.length
  const parts = [
    `Made ${canvas.name} from ${from.name} in ${from.project}: ${count} ${count === 1 ? 'container' : 'containers'} where they were`,
    copied.took.general ? 'its connection choices' : null,
    copied.skills.length ? `${copied.skills.length === 1 ? 'its skill' : 'its skills'} ${copied.skills.join(', ')}` : null,
    copied.primary ? `${names.get(copied.primary) ?? copied.primary} as its primary agent` : null,
  ].filter((one): one is string => one !== null)
  const lines = [`${parts.join(', ')}.`]
  if (notInstalled.length) {
    lines.push(`Not installed here: ${notInstalled.join(', ')}. Their containers are on it, waiting to be installed from Kehikko modules.`)
  }
  lines.push(...copied.trouble)
  return lines.join(' ')
}
