import { z } from 'zod'

import { standIn, type HeldSpace } from './spaces.ts'

/* A subject's space as the server sends it (`Subject.space`), absent from an older server. */
const spaceRow = z.object({ ids: z.array(z.string()).min(1).max(32), picked: z.array(z.string()).max(128).default([]) }).optional().catch(undefined)

/**
 * What a project is about, on the page's side: one epic, and the refs picked
 * out of it.
 *
 * ## Per project, and independent of the kehikko
 *
 * This used to be two fields of every kehikko, and the kehikko dropdown lists
 * every kehikko of the project — so picking a different layout quietly picked
 * a different epic, the one that kehikko happened to remember. The person's
 * report was exactly that: switching the kehikko switched the epic, and it
 * should not. The two are independent questions. The epic is what somebody is
 * working on; a kehikko is how the containers are arranged while they do.
 *
 * So the epic is held per PROJECT, keyed by project id, and the open kehikko
 * is not an argument to anything in this file. `subjectOf` takes a project and
 * nothing else; that it cannot be handed a kehikko is the guarantee.
 *
 * The selection lives beside the epic rather than on the kehikko, because a
 * ref is picked out OF an epic. Changing the epic clears it — `edited` below,
 * mirroring `setSubject` on the server, which is the owner of the rule.
 *
 * Between the two is `parts`: the ids of the parts of the epic the person has
 * pointed the project at, and empty for the whole epic. It is here, keyed by
 * project like the rest, for the reason the epic is — and `subjectOf` still
 * cannot be handed a kehikko, so a layout cannot come to carry a focus by
 * accident. It is cleared with the selection when the epic changes.
 *
 * And "All epics" (`scope: 'project'`): the project about every epic at once,
 * with no one epic and so no parts. Absent for one epic or none — the server's
 * `Subject.scope`, and the protocol's `context.scope` (2.9.0). It is kept
 * where the epic is kept, per project, for the epic's reason: switching kehikko
 * must not switch it.
 */

export interface ProjectSubject {
  epic: string | null
  /** `'project'` for "All epics"; absent for one epic, or none. */
  scope?: 'project'
  /** Part ids picked out of the epic. Empty is the whole epic. */
  parts: string[]
  selection: string[]
  /** The space when epic and parts cannot say it (deeper than a part); absent otherwise. See `src/host/spaces.ts`. */
  space?: HeldSpace
}

/** Every project's subject, by project id. */
export type Subjects = Record<number, ProjectSubject>

export const NOTHING: ProjectSubject = Object.freeze({ epic: null, parts: [], selection: [] }) as ProjectSubject

/**
 * The server's list, as a record by project id. Defaulted to empty so an older
 * server, which kept epics on its kehikot, still answers.
 */
export const subjectsSchema = z
  .array(
    z.object({
      project: z.number().int(),
      epic: z.string().nullable(),
      /* Absent from a server before "All epics", and for one epic. */
      scope: z.enum(['epic', 'project']).optional(),
      /* Defaulted, so a server from before parts answers "the whole epic". */
      parts: z.array(z.string()).max(64).default([]),
      selection: z.array(z.string()).max(64).default([]),
      space: spaceRow,
    }),
  )
  .default([])
  .transform((rows) => {
    const out: Subjects = {}
    for (const row of rows) out[row.project] = subjectFrom(row)
    return out
  })

/** One subject as the server spells it, with "All epics" holding no epic and no parts. */
function subjectFrom(row: { epic: string | null; scope?: 'epic' | 'project'; parts: string[]; selection: string[]; space?: HeldSpace }): ProjectSubject {
  if (row.scope === 'project') return { epic: null, scope: 'project', parts: [], selection: row.selection }
  const out: ProjectSubject = { epic: row.epic, parts: row.parts, selection: row.selection }
  if (row.space && row.space.ids[0] === row.epic) out.space = { ids: row.space.ids, picked: row.space.picked }
  return out
}

/** Whether a project is on "All epics". */
export function allEpics(subject: Pick<ProjectSubject, 'scope'>): boolean {
  return subject.scope === 'project'
}

/** What a project is about. A project nobody has picked for is about nothing. */
export function subjectOf(subjects: Subjects, project: number | null): ProjectSubject {
  if (project === null) return NOTHING
  return subjects[project] ?? NOTHING
}

export interface SubjectEdit {
  /** `'project'` is "All epics" and clears the epic; naming an epic, or none, without one is `'epic'`. */
  scope?: 'epic' | 'project'
  epic?: string | null
  parts?: string[]
  selection?: string[]
  /** Stand in this space (its path of ids, and children picked in it): sets epic and parts, and wins over them. */
  space?: { ids: string[]; picked?: string[] } | null
}

/**
 * A subject after an edit, by the server's rule: a DIFFERENT epic clears the
 * selection unless the same edit says what it is to be, and the same epic
 * again keeps what was picked. The parts follow the selection exactly, and no
 * epic has no parts.
 */
export function edited(was: ProjectSubject, edit: SubjectEdit): ProjectSubject {
  let keep: HeldSpace | undefined
  if (edit.space !== undefined) {
    const stood = edit.space ? standIn(edit.space.ids, edit.space.picked ?? []) : { epic: null, parts: [] as string[] }
    edit = { ...edit, scope: edit.scope ?? 'epic', epic: stood.epic, parts: stood.parts }
    keep = 'space' in stood ? stood.space : undefined
  } else if (edit.epic === undefined && edit.parts === undefined && edit.scope === undefined) {
    keep = was.space
  }
  const scope = scopeAfter(was, edit)
  const epic = scope === 'project' ? null : edit.epic !== undefined ? edit.epic : was.epic
  const moved = movesEpic(was, edit)
  const selection = edit.selection !== undefined ? [...edit.selection] : moved ? [] : was.selection
  const parts = epic === null ? [] : edit.parts !== undefined ? [...edit.parts] : moved ? [] : was.parts
  if (scope === 'project') return { epic, scope, parts, selection }
  return keep && keep.ids[0] === epic ? { epic, parts, selection, space: keep } : { epic, parts, selection }
}

/**
 * Whether an edit moves a project to a different epic, or between one epic
 * and "All epics": what clears the selection, and what every module redraws
 * for. Picking parts within the same epic does neither.
 */
export function movesEpic(was: Pick<ProjectSubject, 'epic' | 'scope'>, edit: SubjectEdit): boolean {
  if (edit.space !== undefined) {
    const epic = edit.space ? (standIn(edit.space.ids, edit.space.picked ?? []).epic) : null
    return epic !== was.epic || (was.scope ?? 'epic') !== (edit.scope ?? 'epic')
  }
  const scope = scopeAfter(was, edit)
  const epic = scope === 'project' ? null : edit.epic !== undefined ? edit.epic : was.epic
  return epic !== was.epic || scope !== (was.scope ?? 'epic')
}

/**
 * The scope after an edit, by the server's rule (`scopeAfter` in
 * `server/canvases.ts`): what the edit says; else one epic when it names an
 * epic or none; else what it was.
 */
export function scopeAfter(was: Pick<ProjectSubject, 'scope'>, edit: SubjectEdit): 'epic' | 'project' {
  if (edit.scope === 'project' || edit.scope === 'epic') return edit.scope
  if (edit.epic !== undefined) return 'epic'
  return was.scope ?? 'epic'
}

/** The record with one project's subject edited, and the others untouched. */
export function withEdit(subjects: Subjects, project: number, edit: SubjectEdit): Subjects {
  return { ...subjects, [project]: edited(subjectOf(subjects, project), edit) }
}

/** Write one project's subject. The server answers with what it now is. */
export async function editSubject(project: number, edit: SubjectEdit): Promise<ProjectSubject> {
  const response = await fetch('/host/subject', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project, ...edit }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null
    throw new Error(typeof body?.error === 'string' ? body.error : `the host's server answered ${response.status}`)
  }
  const parsed = z
    .object({
      subject: z.object({
        epic: z.string().nullable(),
        scope: z.enum(['epic', 'project']).optional(),
        parts: z.array(z.string()).default([]),
        selection: z.array(z.string()),
        space: spaceRow,
      }),
    })
    .parse(await response.json())
  return subjectFrom(parsed.subject)
}
