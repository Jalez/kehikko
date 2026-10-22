import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { LIMITS, MODULE_ID, PART_ID, type FilterChoice } from 'kehikot-module-protocol'
import { z } from 'zod'

import type { Canvas, Subject } from './canvases.ts'
import { hostPath } from './hostData.ts'
import { makeUnderRoot } from './projectRoot.ts'
import { partIdsIn } from '../src/host/parts.ts'

/**
 * A person's own view of a project: `<project>/.kehikot/host/view.json`.
 *
 * ## Why it is a second file
 *
 * `kehikot.json` is the copy that travels (`kehikot.ts`): commit it, and
 * everybody who pulls the project gets the same kehikot. It used to carry
 * everything about them, including what ONE person was looking at — the epic
 * they had open, the refs they picked, which containers they had folded,
 * ticked or filtered. Shared through git, that was one person's afternoon
 * written over everybody else's on every pull, and a fold was a line in a
 * diff. So the file is split along that line:
 *
 *   - `kehikot.json` — the LAYOUT: which kehikot, their names, and every
 *     container's module, rectangle, wish, grow, pin, prompt, interval and
 *     version. Shared.
 *   - `view.json` — the VIEW: the epic, "All epics", the picked parts and refs
 *     (the project's `Subject`), and per container `collapsed`, `selected` and
 *     `filters`. This person's, on this computer; the host's folder's
 *     `.gitignore` names it, so it is not committed.
 *
 * The list of which field is on which side is `PORTABLE_PLACEMENT_FIELDS` /
 * `PERSONAL_PLACEMENT_FIELDS` in `kehikot.ts`, checked at compile time.
 *
 * ## The shape
 *
 * ```json
 * {
 *   "version": 1,
 *   "epic": "modes-are-modules",
 *   "selection": [],
 *   "kehikot": {
 *     "ec29f1c0": {"kehikot.journeys":{"collapsed":true}}
 *   }
 * }
 * ```
 *
 * `scope` and `parts` at the top only when set, like `kehikot.json` did. Under
 * `kehikot`, one line per kehikko (by its `key`), and in it only the
 * containers that are not at rest — folded, ticked or filtered — with only the
 * fields that are not at rest. A container not named is open, not picked and
 * unfiltered.
 *
 * ## Lenient, unlike `kehikot.json`
 *
 * Nobody merges this file and only this host writes it, so a field it does not
 * know is dropped rather than refused, and a file that will not read at all is
 * as good as none: the database's copy is written over it. Losing which
 * containers were folded is not losing work.
 */

const FILE_NAME = 'view'
const VERSION = 1

/** What one container looks like to this person. */
export interface ContainerView {
  collapsed: boolean
  selected: boolean
  filters: FilterChoice
}

/** A project's view: what it is about, and how each container on each kehikko (by key, then module) is looked at. */
export interface View {
  subject: Subject
  kehikot: Map<string, Map<string, ContainerView>>
}

export const AT_REST: ContainerView = { collapsed: false, selected: false, filters: {} }

const filtersSchema = z
  .record(
    z.string().min(1).max(LIMITS.FILTER_ID),
    z.union([
      z.string().min(1).max(LIMITS.FILTER_TEXT),
      z.array(z.string().min(1).max(LIMITS.FILTER_ID)).max(LIMITS.FILTER_OPTIONS),
    ]),
  )
  .catch({})

const containerSchema = z.object({
  collapsed: z.boolean().catch(false).default(false),
  selected: z.boolean().catch(false).default(false),
  filters: filtersSchema.default({}),
})

const fileSchema = z.object({
  version: z.literal(VERSION),
  epic: z.string().trim().min(1).max(80).nullable().catch(null).default(null),
  scope: z.enum(['epic', 'project']).catch('epic').default('epic'),
  parts: z.array(z.string().regex(PART_ID)).max(LIMITS.PARTS).catch([]).default([]),
  selection: z.array(z.string().min(1).max(LIMITS.REF)).max(LIMITS.REFS).catch([]).default([]),
  kehikot: z
    .record(z.string().min(1).max(32), z.record(z.string().regex(MODULE_ID), containerSchema).catch({}))
    .default({}),
})

/** The view file for a project, or null when there is no project path. */
export function viewFile(projectPath: string | null | undefined): string | null {
  return hostPath(projectPath, `${FILE_NAME}.json`)
}

function atRest(view: ContainerView): boolean {
  return !view.collapsed && !view.selected && Object.keys(view.filters).length === 0
}

/** Only the fields that are not at rest, in a fixed order. */
function trimmed(view: ContainerView): Partial<ContainerView> {
  return {
    ...(view.collapsed ? { collapsed: true } : {}),
    ...(view.selected ? { selected: true } : {}),
    ...(Object.keys(view.filters).length ? { filters: view.filters } : {}),
  }
}

/** The view these kehikot and this subject make: the personal half of every placement. */
export function viewOf(canvases: readonly Canvas[], subject: Subject): View {
  const kehikot = new Map<string, Map<string, ContainerView>>()
  for (const canvas of canvases) {
    const containers = new Map<string, ContainerView>()
    for (const p of canvas.placements) {
      containers.set(p.i, { collapsed: p.collapsed, selected: p.selected, filters: p.filters })
    }
    kehikot.set(canvas.key, containers)
  }
  return { subject, kehikot }
}

/**
 * The text of the view file — the same bytes for the same view. Kehikot in the
 * order given, containers in module order, and nothing at rest written.
 */
export function serializeView(view: View): string {
  const { subject } = view
  const lines = [
    '{',
    `  "version": ${VERSION},`,
    `  "epic": ${JSON.stringify(subject.epic)},`,
    ...(subject.scope === 'project' ? ['  "scope": "project",'] : []),
    ...(subject.parts.length ? [`  "parts": ${JSON.stringify(subject.parts)},`] : []),
    `  "selection": ${JSON.stringify(subject.selection)},`,
  ]
  const kehikot = [...view.kehikot]
    .map(([key, containers]) => {
      const moved = [...containers]
        .filter(([, one]) => !atRest(one))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return [key, Object.fromEntries(moved.map(([module, one]) => [module, trimmed(one)]))] as const
    })
    .filter(([, containers]) => Object.keys(containers).length > 0)
  if (kehikot.length === 0) {
    lines.push('  "kehikot": {}')
  } else {
    lines.push('  "kehikot": {')
    kehikot.forEach(([key, containers], index) => {
      lines.push(`    ${JSON.stringify(key)}: ${JSON.stringify(containers)}${index < kehikot.length - 1 ? ',' : ''}`)
    })
    lines.push('  }')
  }
  lines.push('}')
  return `${lines.join('\n')}\n`
}

/** The view file's text read, or null when it is not a view this host can use. */
export function parseView(text: string): View | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const read = fileSchema.safeParse(raw)
  if (!read.success) return null
  const d = read.data
  const subject: Subject =
    d.scope === 'project'
      ? { epic: null, scope: 'project', parts: [], selection: d.selection }
      : { epic: d.epic, parts: d.epic === null ? [] : partIdsIn(d.parts), selection: d.selection }
  const kehikot = new Map<string, Map<string, ContainerView>>()
  for (const [key, containers] of Object.entries(d.kehikot)) {
    kehikot.set(key, new Map(Object.entries(containers).map(([module, one]) => [module, one as ContainerView])))
  }
  return { subject, kehikot }
}

/** A project's view file, read; null when it is not there or will not read. */
export function readView(projectPath: string): View | null {
  const file = viewFile(projectPath)
  if (file === null) return null
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  return parseView(text)
}

/** How one container is looked at in a view: at rest when the view does not name it. */
export function containerView(view: View, key: string, module: string): ContainerView {
  return view.kehikot.get(key)?.get(module) ?? AT_REST
}

const IGNORE = `# What this person is looking at — the open epic, picked parts and refs,
# folded, ticked and filtered containers. Theirs, not the project's: the
# layout everybody shares is kehikot.json beside it.
${FILE_NAME}.json
${FILE_NAME}.json.tmp
`

/**
 * Write a project's view file when it would change, and make sure the host
 * folder's `.gitignore` names it — appended to, never rewritten, like the
 * tracker reading's line (`server/trackers/reading.ts`). Returns whether the
 * file was written.
 */
export function writeView(projectPath: string, view: View): boolean {
  const file = viewFile(projectPath)
  if (file === null) return false
  const text = serializeView(view)
  let before: string | null = null
  try {
    before = readFileSync(file, 'utf8')
  } catch {
    /* Not there yet. */
  }
  if (before === text) return false
  if (!makeUnderRoot(projectPath, dirname(file))) return false
  ignored(dirname(file))
  writeFileSync(`${file}.tmp`, text)
  renameSync(`${file}.tmp`, file)
  return true
}

/** The host folder's `.gitignore` names the view file. A courtesy: a folder that refuses it still gets the view. */
export function ignored(folder: string): void {
  const ignore = join(folder, '.gitignore')
  try {
    if (!existsSync(ignore)) writeFileSync(ignore, IGNORE)
    else {
      const was = readFileSync(ignore, 'utf8')
      if (!was.split('\n').includes(`${FILE_NAME}.json`)) writeFileSync(ignore, `${was.replace(/\n?$/, '\n')}${IGNORE}`)
    }
  } catch {
    /* A read-only folder is not a reason to lose the view. */
  }
}
