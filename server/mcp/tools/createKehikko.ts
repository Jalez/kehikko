import { nameOf } from '../../../src/host/layouts.ts'
import { createCanvas, listCanvases, type Canvas } from '../../canvases.ts'
import { copiedSaid, copyKehikko } from '../../fromProject.ts'
import { keep } from '../../kehikot.ts'
import { projectById } from '../../projects.ts'
import { MAX_TEXT, textIn } from '../bounds.ts'
import type { Door } from '../door.ts'
import { KEHIKKO_PROPERTY } from '../params.ts'
import { kehikkoTool } from '../tool.ts'
import { projectIn } from '../where.ts'
import { missingSaid, PROJECT_HINT, same } from '../words.ts'

export const createKehikko = kehikkoTool({
  name: 'create_kehikko',
  schema: {
    description:
      'Make a new kehikko in a project — empty, or started from a kehikko of another project (or this one) with '
      + 'from. A copy takes the arrangement whole: which modules, where and how big, and which containers are '
      + 'folded or tiles; and, unless take says otherwise, the kehikko’s connection choices (general), the skills '
      + 'the person wrote for it (skills) and its primary agent (agents). Nothing about the other project comes '
      + 'with it: no picked-out or pinned containers, no filters or version pins, no module’s own state (a '
      + 'document, a session, a branch) and no space or selection — those are the project’s. A module this '
      + 'computer lacks keeps its container, drawn with the install card, and the answer names it. The person’s '
      + 'view does not move: jump there when they ask to see it.',
    inputSchema: {
      type: 'object',
      properties: {
        project: KEHIKKO_PROPERTY.project,
        name: { type: 'string', description: 'What the new kehikko is called. Left out: the copied kehikko’s name, or "kehikko".' },
        from: {
          type: 'object',
          description: 'The kehikko to start from. Left out: an empty kehikko.',
          properties: {
            project: {
              type: 'string',
              description: 'The project it is in: its folder, name or id, as read_canvas and my_place print them. Left out: the project the new kehikko is made in.',
            },
            kehikko: {
              type: ['string', 'number'],
              description: 'Which of that project’s kehikot: its key, its exact name, or its id as read_canvas prints it.',
            },
          },
          required: ['kehikko'],
        },
        take: {
          type: 'object',
          description: 'Which of the kehikko’s own settings come with a copy; each is true when left out.',
          properties: {
            general: { type: 'boolean', description: 'Its connection choices between its modules.' },
            skills: { type: 'boolean', description: 'The skills the person wrote for it.' },
            agents: { type: 'boolean', description: 'Its primary agent, when that module is on it.' },
          },
        },
      },
    },
  },
  run: ({ door, canvas }, args) => createKehikkoAt(canvas, args, door),
})

/**
 * `create_kehikko`: a new kehikko in the project a call is about — empty, or copied from another
 * kehikko with `from` (`copyKehikko` in `server/fromProject.ts`, the writer the New kehikko dialog's
 * "From another project" uses; the rules are `src/host/fromProject.ts`). It only ADDS: a kehikko the
 * person sees in their menu and deletes with one press. The view does not move.
 */
async function createKehikkoAt(at: Canvas, args: Record<string, unknown>, door: Door): Promise<{ text: string; failed: boolean }> {
  const into = at.project === null ? null : projectById(door.db, at.project)
  if (!into) return { text: `That kehikko stands in no project, so there is nowhere to make one. ${PROJECT_HINT}`, failed: true }
  if (into.missing) return { text: missingSaid(into), failed: true }
  const name = textIn(args.name)
  if (name === null || (typeof name === 'string' && name.trim().length > 60)) {
    return { text: 'name, when given, is what the kehikko is called: a line of at most 60 characters. Nothing was made.', failed: true }
  }
  if (args.take !== undefined && (args.take === null || typeof args.take !== 'object' || Array.isArray(args.take))) {
    return { text: 'take, when given, is { general?, skills?, agents? }, each true or false. Nothing was made.', failed: true }
  }
  const seen = await door.seen()
  const names = new Map(seen.map((one) => [one.id, one.name ?? one.id]))

  if (args.from === undefined || args.from === null) {
    const made = createCanvas(door.db, name?.trim() || 'kehikko', into.id)
    keep(door.db, into.id)
    door.wake(made.id)
    return {
      text: `Made an empty kehikko, ${made.name} (kehikko ${made.id}, key ${made.key}), in ${into.name} (${into.path}). The person’s view did not move; jump with project and kehikko "${made.key}" when they ask to see it.`,
      failed: false,
    }
  }
  if (typeof args.from !== 'object' || Array.isArray(args.from)) {
    return { text: 'from is { project?, kehikko }: the kehikko to start from, and the project it is in. Nothing was made.', failed: true }
  }
  const from = args.from as Record<string, unknown>
  let source = into
  if (from.project !== undefined && from.project !== null) {
    const found = projectIn(door.db, from.project)
    if (!found.ok) return { text: found.why, failed: true }
    if (found.project.missing) return { text: missingSaid(found.project), failed: true }
    source = found.project
  }
  const theirs = listCanvases(door.db).filter((c) => c.project === source.id)
  const listed = theirs.length
    ? `${source.name}’s kehikot: ${theirs.map((c) => `${c.id}: ${JSON.stringify(c.name)} (key ${c.key})`).join(', ')}.`
    : `${source.name} has no kehikot.`
  const asked = from.kehikko
  let picked: Canvas | undefined
  if (typeof asked === 'number') picked = theirs.find((c) => c.id === asked)
  else if (typeof asked === 'string' && asked.trim() && asked.length <= MAX_TEXT) {
    const word = asked.trim()
    const byName = theirs.filter((c) => same(c.name, word))
    picked = theirs.find((c) => c.key === word) ?? (byName.length === 1 ? byName[0] : undefined)
    if (!picked && byName.length > 1) return { text: `More than one kehikko in ${source.name} is called ${word}; name it by its key. ${listed} Nothing was made.`, failed: true }
  } else {
    return { text: `from.kehikko is the kehikko to start from: its key, its exact name or its id. ${listed} Nothing was made.`, failed: true }
  }
  if (!picked) return { text: `${source.name} has no kehikko ${JSON.stringify(asked)}. ${listed} Nothing was made.`, failed: true }

  const copied = copyKehikko(door.db, { from: picked.id, into: into.id, name: name ?? '', take: args.take })
  if (!copied.ok) return { text: `${copied.why} Nothing was made.`, failed: true }
  door.wake(copied.canvas.id)
  const lacking = copied.canvas.placements.filter((p) => !names.has(p.i)).map((p) => nameOf(p.i))
  return {
    text:
      `${copiedSaid(copied, lacking, names)} It is kehikko ${copied.canvas.id} (key ${copied.canvas.key}) in ${into.name} (${into.path}). `
      + `The person’s view did not move; jump with project and kehikko "${copied.canvas.key}" when they ask to see it.`,
    failed: false,
  }
}
