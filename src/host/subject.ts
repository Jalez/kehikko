import { z } from 'zod'

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
 */

export interface ProjectSubject {
  epic: string | null
  selection: string[]
}

/** Every project's subject, by project id. */
export type Subjects = Record<number, ProjectSubject>

export const NOTHING: ProjectSubject = Object.freeze({ epic: null, selection: [] }) as ProjectSubject

/**
 * The server's list, as a record by project id. Defaulted to empty so an older
 * server, which kept epics on its kehikot, still answers.
 */
export const subjectsSchema = z
  .array(
    z.object({
      project: z.number().int(),
      epic: z.string().nullable(),
      selection: z.array(z.string()).max(64).default([]),
    }),
  )
  .default([])
  .transform((rows) => {
    const out: Subjects = {}
    for (const row of rows) out[row.project] = { epic: row.epic, selection: row.selection }
    return out
  })

/** What a project is about. A project nobody has picked for is about nothing. */
export function subjectOf(subjects: Subjects, project: number | null): ProjectSubject {
  if (project === null) return NOTHING
  return subjects[project] ?? NOTHING
}

export interface SubjectEdit {
  epic?: string | null
  selection?: string[]
}

/**
 * A subject after an edit, by the server's rule: a DIFFERENT epic clears the
 * selection unless the same edit says what it is to be, and the same epic
 * again keeps what was picked.
 */
export function edited(was: ProjectSubject, edit: SubjectEdit): ProjectSubject {
  const epic = edit.epic !== undefined ? edit.epic : was.epic
  const selection =
    edit.selection !== undefined ? [...edit.selection] : epic !== was.epic ? [] : was.selection
  return { epic, selection }
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
    .object({ subject: z.object({ epic: z.string().nullable(), selection: z.array(z.string()) }) })
    .parse(await response.json())
  return parsed.subject
}
