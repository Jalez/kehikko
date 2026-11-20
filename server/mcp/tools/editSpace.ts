import { methodParams, spaceAt, spaceSaid } from 'kehikot-module-protocol'

import { editIn } from '../../../src/host/parts.ts'
import { readSubject, setSubject, spaceOfSubject, type Canvas } from '../../canvases.ts'
import { createEpic, editParts } from '../../holdings.ts'
import { keep } from '../../kehikot.ts'
import { projectById } from '../../projects.ts'
import { editSpaces, spaceEditIn } from '../../spaces.ts'
import { MAX_TEXT, textIn } from '../bounds.ts'
import type { Door } from '../door.ts'
import { KEHIKKO_PROPERTY } from '../params.ts'
import { kehikkoTool } from '../tool.ts'
import { missingSaid, quoted, roster, spacesText } from '../words.ts'

export const editSpace = kehikkoTool({
  name: 'edit_space',
  schema: {
    description:
      'Make ONE edit to the tree of spaces of the project a kehikko is standing in: create a space, rename one, '
      + 'move one, or remove one — at any depth. This is the tool for spaces; create_epic and set_parts are older '
      + 'names for the same edits at the top two levels. A space can hold spaces to any depth; each has its own '
      + 'kehikot like any other. A space is named by its path of ids from the top, e.g. ["auth", "login", '
      + '"errors"], which read_canvas prints (epic and part are the older names of a top-level space and its '
      + 'direct sub-spaces, with the same ids). create: { parent: [] for a top-level space or the path of the space to '
      + 'make it in, name, after? }. rename: { path, name }. move: { path, after?, parent? } — after: the id it '
      + 'goes right after among its siblings, null for first; parent moves a space deeper than the second level '
      + 'under another such space. remove: { path, confirm } — without confirm: true the answer only says what '
      + 'would go; ask the person first. It never changes which space somebody is looking at. Pass project to edit '
      + 'the spaces of any project this host knows, with no page open; never write .kehikot/host/spaces.json or '
      + '.kehikot/host/epics/*.json by hand.',
    inputSchema: {
      type: 'object',
      properties: {
        ...KEHIKKO_PROPERTY,
        create: {
          type: 'object',
          properties: { parent: { type: 'array', items: { type: 'string' } }, name: { type: 'string' }, after: { type: ['string', 'null'] } },
          required: ['name'],
        },
        rename: { type: 'object', properties: { path: { type: 'array', items: { type: 'string' } }, name: { type: 'string' } }, required: ['path', 'name'] },
        move: {
          type: 'object',
          properties: { path: { type: 'array', items: { type: 'string' } }, after: { type: ['string', 'null'] }, parent: { type: 'array', items: { type: 'string' } } },
          required: ['path'],
        },
        remove: { type: 'object', properties: { path: { type: 'array', items: { type: 'string' } }, confirm: { type: 'boolean' } }, required: ['path'] },
      },
      required: [],
    },
  },
  run: ({ door, canvas }, args) => editSpaceAt(canvas, args, door),
})

export const createEpicTool = kehikkoTool({
  name: 'create_epic',
  schema: {
    description:
      'Create a top-level space in the project a kehikko is standing in (older name: an epic; edit_space with '
      + 'create: { parent: [], name } is preferred and does the same). One file, .kehikot/host/epics/<id>.json, '
      + 'with the id, the title and today’s date, and nothing else invented — steps and prose come later, through '
      + 'the host. The id is derived from the title (lowercase, dashes) unless you give one as slug. The person '
      + 'sees the space appear in their picker at once. It does NOT open the space on the kehikko: which space '
      + 'somebody is looking at is theirs to change, so if you want them to look at it, say so to them. An id that '
      + 'is already a top-level space here is refused, never overwritten. A project with no .kehikot/host/epics '
      + 'gets the directory made. Pass project to make it in any project this host knows; never write the file by hand.',
    inputSchema: {
      type: 'object',
      properties: {
        ...KEHIKKO_PROPERTY,
        title: {
          type: 'string',
          description: 'What the space is called: one line, at most 200 characters.',
        },
        slug: {
          type: 'string',
          description:
            'The top-level space’s id (older name: its slug), if not the one derived from the title: lowercase letters, digits and '
            + 'dashes, at most 80, starting with a letter or a digit. This is its identity — every module keys '
            + 'its own material by it — and it cannot be changed afterwards, so choose it as a name and not a '
            + 'sentence.',
        },
      },
      required: ['title'],
    },
  },
  run: ({ door, canvas }, args) => createEpicAt(canvas, args, door),
})

export const setParts = kehikkoTool({
  name: 'set_parts',
  schema: {
    description:
      'Make ONE edit to the direct sub-spaces of a top-level space (older name: the parts of an epic) in the '
      + 'project a kehikko is standing in: add one, rename one, move one, or remove one. edit_space is preferred: '
      + 'it does the same at any depth, by path. A sub-space belongs to its space — an id, a name and a place in '
      + 'an order — and every module on the kehikko narrows to the ones a person picks. They are kept in the '
      + 'top-level space’s own file and this is the same writer the person’s picker in the bar uses; they see the '
      + 'change at once. Name exactly one of add, rename, move, remove. The id of a new sub-space is made here '
      + 'from its name and never changes: rename changes the name only, move the order only. remove takes it out '
      + 'of the list and touches nothing else — what modules filed under its id stays theirs. It does not pick or '
      + 'unpick one: what somebody is looking at is theirs. The answer is the whole list as it then stands. '
      + 'read_canvas prints the ids. Pass project to edit any project this host knows; never edit the file by hand.',
    inputSchema: {
      type: 'object',
      properties: {
        ...KEHIKKO_PROPERTY,
        epic: {
          type: 'string',
          description: 'Older name, still accepted: the top-level space’s id (an epic’s slug). Leave it out for the top-level space this conversation or the project is in, which read_canvas prints.',
        },
        add: {
          type: 'object',
          description: 'A new sub-space. after: the id it goes right after; null for first; left out for last.',
          properties: { name: { type: 'string' }, after: { type: ['string', 'null'] } },
          required: ['name'],
        },
        rename: {
          type: 'object',
          description: 'Another name for the sub-space with this id. Its id and its place stay.',
          properties: { id: { type: 'string' }, name: { type: 'string' } },
          required: ['id', 'name'],
        },
        move: {
          type: 'object',
          description: 'Put the sub-space with this id right after another: after is that id, null for first, left out for last.',
          properties: { id: { type: 'string' }, after: { type: ['string', 'null'] } },
          required: ['id'],
        },
        remove: {
          type: 'object',
          description: 'Take the sub-space with this id out of the list.',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      required: [],
    },
    annotations: {
      title: 'Edit a space’s sub-spaces',
      /* It writes one field of the epic's file. */
      readOnlyHint: false,
      /* One tool, four edits, and a hint cannot vary by argument: `remove`
         takes an entry out and `rename` writes over a name, so the tool as
         a whole is not additive-only and says so. What it cannot do is
         lose anybody's material — a removed part's holdings stay with the
         modules, and adding it again under the same name gives the same id. */
      destructiveHint: true,
      /* `add` twice is two parts. */
      idempotentHint: false,
      /* A file in the project, on this machine. */
      openWorldHint: false,
    },
  },
  run: ({ door, canvas }, args) => setPartsAt(canvas, args, door),
})

/**
 * `edit_space`: one edit of the project's tree of spaces, through the one writer (`editSpaces`), as the
 * person's space picker makes it. A project standing in a space that is removed moves up to what holds it.
 */
function editSpaceAt(canvas: Canvas, args: Record<string, unknown>, door: Door): { text: string; failed: boolean } {
  const project = canvas.project === null ? null : projectById(door.db, canvas.project)
  if (!project) return { text: `kehikko ${canvas.id} (${canvas.name}) is in no project, so it has no spaces. Pass project (a project’s folder, name or id) to edit the spaces of any project this host knows.\n\n${roster(door.db)}`, failed: true }
  if (project.missing) return { text: missingSaid(project), failed: true }
  const edit = spaceEditIn(args)
  if (!edit) return { text: 'nothing was changed — name exactly one of create: { parent, name, after? }, rename: { path, name }, move: { path, after?, parent? }, remove: { path, confirm }.', failed: true }
  const done = editSpaces(project.path, edit)
  if (done.outcome === 'confirm') return { text: done.why, failed: false }
  if (done.outcome !== 'changed') return { text: done.outcome === 'unchanged' ? 'Already so; nothing was changed.' : `nothing was changed — ${done.why}`, failed: done.outcome !== 'unchanged' }
  if ('remove' in edit) {
    const now = readSubject(door.db, project.id)
    const here = now ? spaceOfSubject(now) : null
    const gone = edit.remove.path
    if (here && gone.every((id, at) => here.ids[at] === id)) {
      const up = gone.slice(0, -1)
      setSubject(door.db, project.id, up.length ? { space: { ids: up } } : { epic: null })
      keep(door.db, project.id)
    }
  }
  door.epicsChanged(project.id)
  const top = 'create' in edit ? (done.path ?? edit.create.parent)[0] : ('rename' in edit ? edit.rename.path : 'move' in edit ? edit.move.path : edit.remove.path)[0]
  if (top) door.epicWritten?.(project.id, top)
  const said = done.path ? spaceAt(done.tree, done.path) : null
  return {
    text: `${'remove' in edit ? `Removed ${edit.remove.path.join('/')}` : `Done: ${said ? `${spaceSaid(said)} (${done.path!.join('/')})` : done.path?.join('/')}`}. The spaces of ${project.name} now:\n${spacesText(done.tree)}`,
    failed: false,
  }
}

/**
 * `create_epic`: a file in the project this kehikko stands in, and nothing on
 * the canvas changed.
 *
 * All of the checking is `createEpic`'s in `holdings.ts` — the same function
 * the page's `+` reaches through `POST /host/epics` — and this end only turns
 * a kehikko into a folder and bounds what it hands over.
 */
function createEpicAt(
  canvas: Canvas,
  args: Record<string, unknown>,
  door: Door,
): { text: string; failed: boolean } {
  const project = canvas.project === null ? null : projectById(door.db, canvas.project)
  if (!project) {
    return {
      text:
        `kehikko ${canvas.id} (${canvas.name}) is in no project, so there is no folder to make a space in. `
        + `Pass project (a project’s folder, name or id) to act on any project this host knows.\n\n${roster(door.db)}`,
      failed: true,
    }
  }
  if (project.missing) return { text: missingSaid(project), failed: true }

  const title = textIn(args.title)
  if (title === null || title === undefined) {
    return {
      text: `create_epic needs title: one line of text, at most ${MAX_TEXT} characters, e.g. title: "The page is components".`,
      failed: true,
    }
  }
  const slug = textIn(args.slug)
  if (slug === null) {
    return { text: 'slug, when given, is a string of lowercase letters, digits and dashes.', failed: true }
  }

  const made = createEpic(project.path, { title, slug })
  if (!made.ok) return { text: made.why, failed: true }

  /* The page re-reads its dropdown. NOT `door.wake(canvas.id)`: the kehikko has
     not changed, and a wake that said it had would have the page re-read an
     arrangement that is exactly what it already shows. */
  door.epicsChanged(project.id)
  door.epicWritten?.(project.id, made.epic.slug)

  return {
    text:
      `Created the top-level space ${made.epic.slug} ("${made.epic.title}") in ${project.name} — ${made.file}`
      + (made.madeDirectory ? ', and made .kehikot/host/epics there, which did not exist' : '')
      + `. It is in the picker now. ${project.name} is still in ${
        readSubject(door.db, project.id)?.epic ? `the space ${readSubject(door.db, project.id)?.epic}` : 'no space'
      }: this tool does not switch what somebody is looking at. If they should open it, ask them.`,
    failed: false,
  }
}

/**
 * `set_parts`: one edit of an epic's list of parts, in the project this
 * kehikko stands in.
 *
 * The arguments go through the protocol's own schema for `parts.set`, and the
 * write is `editParts` in `holdings.ts` — the function the picker in the bar
 * and a module's `parts.set` reach — so an agent, a module and a person are
 * refused for the same things and a new part gets the same id whoever asked.
 * Nothing on the canvas changes and nothing is picked.
 */
function setPartsAt(
  canvas: Canvas,
  args: Record<string, unknown>,
  door: Door,
): { text: string; failed: boolean } {
  const project = canvas.project === null ? null : projectById(door.db, canvas.project)
  if (!project) {
    return {
      text:
        `kehikko ${canvas.id} (${canvas.name}) is in no project, so there is no space whose sub-spaces could be edited. `
        + `Pass project (a project’s folder, name or id) to act on any project this host knows.\n\n${roster(door.db)}`,
      failed: true,
    }
  }
  if (project.missing) return { text: missingSaid(project), failed: true }
  const here = door.here && door.here.project.id === project.id ? door.here : null
  const unnamed = args.epic === undefined || args.epic === null
  const epic = !unnamed ? args.epic : here ? here.epic : readSubject(door.db, project.id)?.epic
  /* A conversation with no place (one that kept no session) editing "the epic" edits the one on screen, and is told so. */
  const note = unnamed && !here && door.here === null ? UNPLACED_PARTS : ''
  if (typeof epic !== 'string' || !epic) {
    return {
      text: here
        ? 'This conversation belongs to no space, so set_parts needs epic: the id of one of the project’s top-level spaces. edit_space edits a space at any depth by its path.'
        : `${project.name} is in ${readSubject(door.db, project.id)?.scope === 'project' ? 'all spaces, not one' : 'no space'}, so set_parts needs epic: the id of one of its top-level spaces. edit_space edits a space at any depth by its path.`,
      failed: true,
    }
  }
  const given = Object.fromEntries(
    (['add', 'rename', 'move', 'remove'] as const).filter((key) => args[key] !== undefined && args[key] !== null).map((key) => [key, args[key]]),
  )
  const parsed = methodParams['parts.set'].safeParse({ epic, ...given })
  const edit = parsed.success ? editIn(parsed.data) : null
  if (!parsed.success || !edit) {
    const issue = parsed.success ? undefined : parsed.error.issues[0]
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : ''
    return {
      text:
        `nothing was changed — ${where}${issue?.message ?? 'name exactly one of add, rename, move or remove'}. `
        + 'set_parts takes one of add: { name, after? }, rename: { id, name }, move: { id, after? }, remove: { id }.',
      failed: true,
    }
  }

  const done = editParts(project.path, parsed.data.epic, edit)
  if (done.written) door.epicWritten?.(project.id, parsed.data.epic)

  const { outcome, parts, id, why } = done.result
  const list = parts.length ? parts.map((part) => `${part.id} — ${quoted(part.name)}`).join('; ') : 'none'
  const now = `The direct sub-spaces of ${parsed.data.epic} (id — name), in order: ${list}.`
  if (outcome === 'declined') return { text: `nothing was changed — ${why}`, failed: true }
  if (outcome === 'no-such-part') {
    return { text: `nothing was changed — an id or an after names no sub-space of ${parsed.data.epic}. ${now}`, failed: true }
  }
  const did =
    outcome === 'unchanged'
      ? 'It already was as asked, so nothing was written.'
      : 'add' in edit
        ? `Added ${id}.`
        : 'rename' in edit
          ? `Renamed ${id}; its id did not change.`
          : 'move' in edit
            ? `Moved ${id}.`
            : `Removed ${id} from the list; what modules hold under that id was not touched.`
  return { text: `${did} ${now}${note ? `\n\n${note}` : ''}`, failed: false }
}

const UNPLACED_PARTS =
  'This conversation is not recorded under any place, so set_parts fell back to the space open on screen — the '
  + 'person’s current view, not a record. If that is not this conversation’s space, name its top-level space as epic in the call.'
