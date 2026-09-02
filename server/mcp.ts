import type { Database } from 'bun:sqlite'

import { listCanvases, editCanvas, type Canvas, type Placement } from './canvases.ts'
import { createEpic } from './holdings.ts'
import { keep } from './kehikot.ts'
import { projectById } from './projects.ts'
import type { WhichKehikko } from './open.ts'
import { place } from '../src/host/canvases.ts'
import { granted, SQUEEZED_ROWS, tops } from '../src/host/columns.ts'
import { CANVAS_ROWS } from '../src/host/fit.ts'

/**
 * The host's own door, which it did not have until now.
 *
 * Every module on this canvas can offer an agent a door of its own — that is
 * what `ToolsMark` and `server/tools.ts` are about. The host offered none, so
 * an agent could be told everything about the work and nothing about the
 * workspace: which programs are arranged in front of the person, which project
 * they are standing in, and — the thing that was actually asked for — which of
 * those containers they have pointed at.
 *
 * ## Four tools, and the list is still short on purpose
 *
 * `read_canvas` and `select_modules` were the first two: reading what is
 * arranged, and setting the module selection. `place_modules` and
 * `create_epic` came later, and they are the two that this file's own essay
 * used to argue against, so the argument is re-run here rather than deleted.
 *
 * ## "The arrangement belongs to the person looking at it" — what survives
 *
 * The first version of this door said that everything which REARRANGES was
 * deliberately absent: no adding a container, no taking one off, no moving
 * the epic, no switching kehikko, no renaming. The reason given was that each
 * of those is a way for an agent to change what somebody is looking at while
 * they are looking at it, and that a tool which moved a container would be the
 * agent redecorating.
 *
 * That reason is still right, and most of the list still stands. What it did
 * not distinguish is that the items on it are not the same kind of act:
 *
 *   - **Removing** a container destroys a placement a person made with a
 *     pointer — its position, its width, the height they dragged it to, its
 *     prompt, its filters, its pin. None of that comes back from a sentence.
 *   - **Moving or resizing** one takes rows and columns from its neighbours,
 *     which is the person's arrangement being re-argued by something with no
 *     eyes on it; `columns.ts` exists because even a person doing it needs
 *     rules.
 *   - **Switching the kehikko or the epic** changes what every module on the
 *     canvas is told it is about, under somebody who was in the middle of
 *     reading it.
 *   - **Renaming** is a label a person chose.
 *
 * Every one of those stays absent, for the reason the first essay gave.
 *
 * ## — and what is overturned
 *
 *   - **Putting a module on the canvas** is additive. It takes nothing from a
 *     placement that exists — `place` puts the new container beside the last
 *     one or on a row under everything, and never moves what is there. It is
 *     visible the moment it happens, because the page is woken and re-reads.
 *     And it is undone with one press on the container's own remove button,
 *     which is exactly the gesture the person would have used had they added
 *     it themselves. The owner's words were "add the suitable modules for a
 *     kehikko", and "suitable" is a judgement the AGENT is making; the tool's
 *     job is to place what it is told, refuse what it cannot place, and say
 *     clearly what happened.
 *   - **Creating an epic** is a file that did not exist, in a directory git
 *     is watching, and it changes nothing on any canvas: the dropdown gains a
 *     row and the kehikko goes on being about whatever it was about. It does
 *     NOT open the epic it made — that would be the switch the list above
 *     keeps — and the sentence it answers with says so, so an agent that wants
 *     the person to look at it knows to ask them.
 *
 * The line, then, is not "reads versus writes". It is: a tool here may ADD
 * something a person can see arrive and remove with one press, and may not
 * take away, move, or re-aim anything a person put where it is. Two tools sit
 * on the near side of that line and are here; the rest are on the far side and
 * are not.
 *
 * ## Where a placed container goes, and when it does not go at all
 *
 * The same rule the page's own add button uses — `place` in
 * `src/host/canvases.ts`: beside the last container if the bottom row has
 * room, else a new row under everything. One rule for both, so the agent's
 * container lands where the person's would have. But `place` asks for a fixed
 * ten rows wherever the arithmetic puts it, and the canvas is a fixed
 * twenty-eight-row budget: on a full column the PAGE would draw the new
 * container by taking rows from the ones above it — `granted` in `columns.ts`
 * — which is right for a person, who can see it happen, and is exactly the
 * taking-away this door does not do. So the arrangement is granted before
 * and after, and if placing would change any existing container's drawn
 * height or top edge, or leave the new one under the floor, it is refused
 * with a sentence — see `fittedIn`. What is written when it is allowed is
 * `place`'s rectangle with `h` cut to what the column grants, so that the
 * stored rectangle never claims more than will be drawn; the wish stays the
 * ten rows that were asked for, because a drawn height is never written into
 * a wish.
 *
 * ## The shape is `kehikko-checklist/doors.ts`'s
 *
 * Streamable HTTP, one request one answer, no session and no stream — nothing
 * here pushes. Every argument is bounded before it is looked at, every refusal
 * is a sentence saying what to do instead, and a refusal comes back as a tool
 * error the agent reads rather than as a transport failure it retries.
 */

/** A status and a document. Nothing here writes bytes; `server.ts` does that. */
export interface Reply {
  status: number
  /** `null` means "answer with no body", which is what a notification gets. */
  body: unknown
}

interface Rpc {
  id?: number | string
  method?: string
  params?: { name?: string; arguments?: Record<string, unknown> }
}

/** What one registered program is, as far as a sweep could tell. */
export interface Sighting {
  id: string
  name: string | null
  condition: string
}

/**
 * What the door needs from the rest of the host, handed in rather than reached for.
 *
 * The database, a way to say which kehikko is open, two ways to wake the
 * page, and a way to find out which modules are actually answering. Passed as
 * an object so that every one of these is a thing a test can supply — the
 * argument checking and the kehikko lookup are the two halves most likely to
 * be got wrong, and neither should need a browser or a running module to
 * exercise.
 */
export interface Door {
  db: Database
  /** Which kehikko a call that named none means. See `open.ts`. */
  which(): WhichKehikko
  /** Say that a kehikko has changed under the page. See `wake.ts`. */
  wake(kehikko: number): void
  /** Say that a project's epics are not what the page last read. See `wake.ts`. */
  epicsChanged(project: number): void
  /** Every registered module and whether it is answering, from a sweep. */
  seen(): Promise<Sighting[]>
}

const ok = (body: unknown): Reply => ({ status: 200, body })

export const TOOL_NAMES = ['read_canvas', 'select_modules', 'place_modules', 'create_epic'] as const
export type ToolName = (typeof TOOL_NAMES)[number]

/* ------------------------------------------------------------------ *
 * Everything that arrives, bounded before it is looked at
 *
 * This listens on loopback, which is a fence around the machine and not around
 * the programs on it. A string has a length before it has a meaning.
 * ------------------------------------------------------------------ */

/** As long as a module id may be — the same bound `moduleIn` uses in `server.ts`. */
const MAX_ID = 64
/** More containers than any canvas holds; `PLACEMENTS_MAX` in `canvases.ts` is 64. */
const MAX_MODULES = 64
/** A title is bounded at `TITLE_MAX` in `holdings.ts`; this is the bound on what is even read. */
const MAX_TEXT = 1024

/**
 * A kehikko id out of an argument, or `undefined` for "none was given".
 *
 * Deliberately strict about what an id is, for the reason `canvasId` in
 * `server.ts` is: `Number('1e3')` is 1000 and `Number(' 2 ')` is 2, so a
 * generous reading would let a string that is not a number at all address a
 * canvas. `null` here means "given, and not a kehikko id" — which is refused
 * rather than treated as absent, because an agent that sent `kehikko: "3"` and
 * silently got the open one instead would be acting on a canvas it did not name.
 */
function kehikkoIn(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  return null
}

/** Every kehikko this host holds, one per line, for a refusal somebody has to act on. */
function roster(db: Database): string {
  const canvases = listCanvases(db)
  if (!canvases.length) return 'This host holds no kehikot at all.'
  return (
    'The kehikot are:\n'
    + canvases
        .map((canvas) => {
          const project = canvas.project === null ? null : projectById(db, canvas.project)
          const where = project ? ` in ${project.name} (${project.path})` : ''
          return `  ${canvas.id}: ${canvas.name}${where}`
        })
        .join('\n')
  )
}

/**
 * Which kehikko a call is about, decided once for every tool.
 *
 * Three ways it can go and all three are said out loud in the answer, because
 * "which canvas did that act on" is the question this whole door is most likely
 * to be got wrong about. A named kehikko that does not exist is refused with
 * the list; no name and no unambiguous open page is refused with the list; a
 * name that exists, or one open page, is an answer that says which it took and
 * why.
 */
function decide(
  door: Door,
  args: Record<string, unknown>,
): { ok: true; canvas: Canvas; how: string } | { ok: false; why: string } {
  const asked = kehikkoIn(args.kehikko)
  if (asked === null) {
    return {
      ok: false,
      why:
        'kehikko must be the whole number a kehikko is identified by, e.g. kehikko: 3 — not a string and not a '
        + `name. Leave it out to act on the one a page of this host has open.\n\n${roster(door.db)}`,
    }
  }

  const id = asked ?? null
  if (id === null) {
    const open = door.which()
    if (!open.ok) return { ok: false, why: `${open.why}\n\n${roster(door.db)}` }
    const canvas = listCanvases(door.db).find((c) => c.id === open.id)
    if (!canvas) {
      /* A page reporting a kehikko that has since been deleted, most likely in
         another window. Refused rather than falling back to some other kehikko,
         which would be the guess this whole file exists to avoid. */
      return {
        ok: false,
        why:
          `a page of this host says kehikko ${open.id} is open, but there is no kehikko with that id any more — `
          + `it was probably deleted in another window.\n\n${roster(door.db)}`,
      }
    }
    return { ok: true, canvas, how: 'the kehikko a page of this host has open' }
  }

  const canvas = listCanvases(door.db).find((c) => c.id === id)
  if (!canvas) {
    return { ok: false, why: `there is no kehikko with id ${id}.\n\n${roster(door.db)}` }
  }
  return { ok: true, canvas, how: 'the kehikko you named' }
}

/** What one canvas is, written out for an agent to read. */
function canvasText(db: Database, canvas: Canvas, how: string, seen: Sighting[]): string {
  const project = canvas.project === null ? null : projectById(db, canvas.project)
  const known = new Map(seen.map((sighting) => [sighting.id, sighting]))

  const lines: string[] = []
  lines.push(`kehikko ${canvas.id}: ${canvas.name} — ${how}.`)
  lines.push(
    project
      ? `project: ${project.name} at ${project.path}`
      : 'project: none. This kehikko is in no project, so modules on it are told no folder to work in.',
  )
  lines.push(
    canvas.epic
      ? `epic: ${canvas.epic}`
      : 'epic: none picked. Every epic-scoped module on this kehikko is told there is no epic.',
  )
  lines.push(
    canvas.selection.length
      ? `refs picked out here: ${canvas.selection.join(', ')}`
      : 'refs picked out here: none.',
  )
  lines.push('')

  if (!canvas.placements.length) {
    lines.push('There are no containers on this kehikko.')
  } else {
    /* Top to bottom, then left to right — the order the canvas is read in, which
       is the order a person describing it out loud would use. The same ordering
       `promptFor` uses in `src/host/canvases.ts`. */
    const here = [...canvas.placements].sort((a, b) => a.y - b.y || a.x - b.x)
    const picked = here.filter((p) => p.selected)
    lines.push(
      picked.length
        ? `selected containers (${picked.length} of ${here.length}): ${picked.map((p) => p.i).join(', ')}`
        : `selected containers: none of the ${here.length} here. Nobody has picked anything out on this kehikko.`,
    )
    lines.push('')
    lines.push('Every container on it, as it is arranged:')
    for (const p of here) {
      const sighting = known.get(p.i)
      const marks = [
        p.selected ? 'SELECTED' : null,
        p.pinned ? 'pinned' : null,
        p.collapsed ? 'folded to its header' : null,
        /* What the host last saw of the program, which is not the same question
           as what is arranged. A container for a module that is not running is a
           perfectly ordinary thing to have on a canvas, and an agent asked to
           work on one should know that is what it is. */
        sighting === undefined
          ? 'no registration on this computer — the container stays, drawn as missing, so the layout survives a machine that lacks the module'
          : sighting.condition === 'ready'
            ? null
            : `not answering (${sighting.condition})`,
      ].filter((mark): mark is string => mark !== null)
      const name = sighting?.name && sighting.name !== p.i ? ` (${sighting.name})` : ''
      lines.push(`  ${p.i}${name}${marks.length ? ` — ${marks.join(', ')}` : ''}`)
    }
  }

  /* And what is registered here and NOT on this kehikko, because that is the
     list `place_modules` takes from. An agent told only what is arranged would
     have to guess at module ids to add, and a guessed id is refused. */
  const on = new Set(canvas.placements.map((p) => p.i))
  const elsewhere = seen.filter((sighting) => !on.has(sighting.id))
  lines.push('')
  lines.push(
    elsewhere.length
      ? `registered on this computer and not on this kehikko (what place_modules can add): ${elsewhere
          .map((s) => (s.name && s.name !== s.id ? `${s.id} (${s.name})` : s.id))
          .join(', ')}`
      : 'every module registered on this computer is already on this kehikko.',
  )
  return lines.join('\n')
}

/**
 * The four tools.
 *
 * Every one takes an optional `kehikko` and says, in every answer, which one
 * it acted on and how it decided — see `decide`. `create_epic` takes it too,
 * even though an epic is a file in a project rather than anything on a canvas,
 * because a kehikko is how this door names a project: a kehikko is in exactly
 * one, and asking for a project id would be a second vocabulary for an agent
 * that has just read the first.
 */
function tools() {
  const KEHIKKO_PROPERTY = {
    kehikko: {
      type: 'number',
      description:
        'Which kehikko (canvas) this is about, as the whole number read_canvas prints. Leave it out to act on '
        + 'the one a page of this host currently has open — which only works when exactly one page has one open, '
        + 'because two browser windows on two kehikot make "the open one" name two screens. Every answer says '
        + 'which kehikko it acted on.',
    },
  } as const

  return [
    {
      name: 'read_canvas',
      description:
        'What is arranged on a kehikko: which containers are on it, which of them have been picked out as '
        + 'targets, the project folder it is standing in, and the epic it is about — and which registered modules '
        + 'are NOT on it, which is what place_modules can add. A kehikko is one person’s workspace — several '
        + 'programs side by side around one piece of work — so this is what somebody has in front of them right '
        + 'now. Read it before acting on "the selected module", and read it again if you have been working a '
        + 'while, because a person can tick and untick while you work.',
      inputSchema: { type: 'object', properties: { ...KEHIKKO_PROPERTY }, required: [] },
    },
    {
      name: 'select_modules',
      description:
        'Pick containers out on a kehikko as the ones being targeted, replacing whatever was picked out before. '
        + 'Pass every module id that should end up selected; pass an empty list to unpick everything. This is the '
        + 'same tick a person makes in a container’s header, and they can see it happen — the ring around '
        + 'a selected container appears on their screen without them refreshing anything. It changes nothing about '
        + 'the modules themselves: no program is told, started, stopped, moved or asked anything. It is a note '
        + 'about which of them is meant.',
      inputSchema: {
        type: 'object',
        properties: {
          ...KEHIKKO_PROPERTY,
          modules: {
            type: 'array',
            items: { type: 'string' },
            description:
              'The module ids to select, exactly as read_canvas prints them, e.g. ["roadmap.journeys", '
              + '"roadmap.notes"]. Every one has to be on this kehikko already; use place_modules to put one '
              + 'there first. An empty list unpicks everything.',
          },
        },
        required: ['modules'],
      },
    },
    {
      name: 'place_modules',
      description:
        'Put modules on a kehikko, as containers, where the person’s own add button would put them: beside the '
        + 'last container if the bottom row has room, otherwise on a new row underneath. Nothing already there is '
        + 'moved, resized or removed — this only adds, and the person sees each container arrive and can take it '
        + 'off with one press. Which modules are SUITABLE is your judgement, not this tool’s: it places what it is '
        + 'told, refuses what it cannot place, and says what it did. A module already on the kehikko is left alone '
        + 'and named as such; a module not registered on this computer is refused, whole, because a container for '
        + 'it would be drawn as missing and there is nothing to work in. There is deliberately no tool that takes a '
        + 'container off, moves one, or changes the epic: those undo work somebody did with a pointer, and the '
        + 'arrangement is theirs.',
      inputSchema: {
        type: 'object',
        properties: {
          ...KEHIKKO_PROPERTY,
          modules: {
            type: 'array',
            items: { type: 'string' },
            description:
              'The module ids to place, exactly as read_canvas prints them under "registered on this computer '
              + 'and not on this kehikko", e.g. ["roadmap.notes"]. In the order they should be added.',
          },
        },
        required: ['modules'],
      },
    },
    {
      name: 'create_epic',
      description:
        'Make a new epic in the project a kehikko is standing in: one file, data/epics/<slug>.json, with the '
        + 'slug, the title and today’s date, and nothing else invented — steps and prose come later, through the '
        + 'roadmap. The slug is derived from the title (lowercase, dashes) unless you give one. The person sees the '
        + 'epic appear in their dropdown at once. It does NOT open the epic on the kehikko: which epic somebody is '
        + 'looking at is theirs to change, so if you want them to look at it, say so to them. A slug that is '
        + 'already an epic here is refused, never overwritten. A project with no data/epics gets the directory made.',
      inputSchema: {
        type: 'object',
        properties: {
          ...KEHIKKO_PROPERTY,
          title: {
            type: 'string',
            description: 'What the epic is called: one line, at most 200 characters.',
          },
          slug: {
            type: 'string',
            description:
              'What the epic is filed under, if not the one derived from the title: lowercase letters, digits and '
              + 'dashes, at most 80, starting with a letter or a digit. This is its identity — every module keys '
              + 'its own material by it — and it cannot be changed afterwards, so choose it as a name and not a '
              + 'sentence.',
          },
        },
        required: ['title'],
      },
    },
  ]
}

/** The module ids out of an argument, bounded — or a sentence saying what was wrong with them. */
function modulesIn(
  value: unknown,
  tool: 'select_modules' | 'place_modules',
): { ok: true; ids: string[] } | { ok: false; why: string } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      why:
        tool === 'select_modules'
          ? 'select_modules needs modules: a list of the module ids that should end up selected, e.g. modules: '
            + '["roadmap.journeys"]. Pass modules: [] to unpick everything. It replaces the selection rather than '
            + 'adding to it, so send every id you want selected, not only the new one.'
          : 'place_modules needs modules: a list of the module ids to put on the kehikko, e.g. modules: '
            + '["roadmap.notes"] — as read_canvas prints them under "registered on this computer and not on this '
            + 'kehikko".',
    }
  }
  if (value.length > MAX_MODULES) {
    return { ok: false, why: `no kehikko holds more than ${MAX_MODULES} containers, so that list cannot be right.` }
  }
  const ids: string[] = []
  for (const one of value) {
    if (typeof one !== 'string' || !one.trim() || one.length > MAX_ID) {
      return {
        ok: false,
        why:
          'every entry in modules has to be a module id as read_canvas prints it — a non-empty string of at most '
          + `${MAX_ID} characters. One of them was not.`,
      }
    }
    const id = one.trim()
    /* A duplicate is not a second selection of the same container; it is the
       same one, and letting it through would make "how many are selected" a
       number that disagrees with what is on screen. The same rule `refsIn`
       applies to refs, for the same reason. */
    if (!ids.includes(id)) ids.push(id)
  }
  return { ok: true, ids }
}

/** A line of text out of an argument, bounded before `holdings.ts` looks at it. `undefined` for "not given". */
function textIn(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length > MAX_TEXT) return null
  return value
}

export async function call(
  name: ToolName,
  args: Record<string, unknown>,
  door: Door,
): Promise<{ text: string; failed: boolean }> {
  const where = decide(door, args)
  if (!where.ok) return { text: where.why, failed: true }
  const canvas = where.canvas

  if (name === 'read_canvas') {
    return { text: canvasText(door.db, canvas, where.how, await door.seen()), failed: false }
  }
  if (name === 'create_epic') return createEpicAt(canvas, args, door)
  if (name === 'place_modules') return placeOn(canvas, where.how, args, door)

  const asked = modulesIn(args.modules, 'select_modules')
  if (!asked.ok) return { text: asked.why, failed: true }

  const on = new Set(canvas.placements.map((p) => p.i))
  const strangers = asked.ids.filter((id) => !on.has(id))
  if (strangers.length) {
    /* Refused whole rather than selecting the ones it recognised. A partial
       success here is an agent believing it selected three containers when it
       selected two, and the third is exactly the one it would go on to act
       against. The sentence names what IS on the kehikko, so the correction is
       one call away. */
    return {
      text:
        `${strangers.join(', ')} ${strangers.length === 1 ? 'is not a container' : 'are not containers'} on kehikko `
        + `${canvas.id} (${canvas.name}), so nothing was selected — this tool only picks out containers that are `
        + `already there; place_modules is what puts one on. What is on it: ${
          on.size ? [...on].join(', ') : 'nothing at all'
        }.`,
      failed: true,
    }
  }

  const wanted = new Set(asked.ids)
  const placements = canvas.placements.map((p) => ({ ...p, selected: wanted.has(p.i) }))
  const written = editCanvas(door.db, canvas.id, { placements })
  /* A selection is part of the arrangement and the arrangement's record is the
     project's file — see `kehikot.ts`. Written here, by the door that changed
     it, the way the HTTP routes each write after their own change. */
  if (written) keep(door.db, written.project)
  if (!written) {
    return { text: `kehikko ${canvas.id} was there a moment ago and is not now; nothing was selected.`, failed: true }
  }

  /* The page hears about it and re-reads. Written first, woken after: a page
     that re-read on the strength of a wake sent before the write would read the
     old arrangement and show it, and nothing would wake it a second time. */
  door.wake(canvas.id)

  return {
    text:
      (asked.ids.length
        ? `Selected on kehikko ${canvas.id} (${canvas.name}), ${where.how}: ${asked.ids.join(', ')}.`
        : `Nothing is selected on kehikko ${canvas.id} (${canvas.name}) any more, ${where.how}.`)
      + '\n\n'
      + canvasText(door.db, written, where.how, await door.seen()),
    failed: false,
  }
}

/**
 * `place_modules`: containers added, the arrangement otherwise untouched.
 *
 * Refused whole when any id is not registered on this computer, for the reason
 * `select_modules` refuses whole for a stranger: a partial success is an agent
 * believing it placed three modules when it placed two. Refused whole, too,
 * when there is no room for one of them — a canvas with two containers added
 * and a third refused is a canvas the agent has to re-read to understand, and
 * the point of an answer is that it should not have to.
 *
 * Already-there is not a refusal. It is the same container, and "put it on"
 * about a container that is on is a request already satisfied. Said in the
 * answer so the agent knows nothing moved.
 */
async function placeOn(
  canvas: Canvas,
  how: string,
  args: Record<string, unknown>,
  door: Door,
): Promise<{ text: string; failed: boolean }> {
  const asked = modulesIn(args.modules, 'place_modules')
  if (!asked.ok) return { text: asked.why, failed: true }
  if (!asked.ids.length) {
    return { text: 'place_modules was given an empty list, so there is nothing to place.', failed: true }
  }

  const seen = await door.seen()
  const registered = new Map(seen.map((sighting) => [sighting.id, sighting]))
  const strangers = asked.ids.filter((id) => !registered.has(id))
  if (strangers.length) {
    /* Not placed, rather than placed as a missing container. `Missing.tsx`
       exists for a canvas that TRAVELLED to a machine without the module — a
       layout somebody built, kept whole. An agent naming a module this
       machine has never heard of is more likely a typo than a plan, and a
       dashed rectangle saying "missing" is not a module anybody can work in. */
    const offer = [...registered.keys()].filter((id) => !canvas.placements.some((p) => p.i === id))
    return {
      text:
        `${strangers.join(', ')} ${strangers.length === 1 ? 'is not a module' : 'are not modules'} registered on `
        + `this computer, so nothing was placed — a container for it would be drawn as missing, with nothing to `
        + `work in. Registered here and not yet on kehikko ${canvas.id} (${canvas.name}): ${
          offer.length ? offer.join(', ') : 'nothing; every registered module is already on it'
        }.`,
      failed: true,
    }
  }

  const already = asked.ids.filter((id) => canvas.placements.some((p) => p.i === id))
  const adding = asked.ids.filter((id) => !already.includes(id))
  if (!adding.length) {
    return {
      text:
        `${already.join(', ')} ${already.length === 1 ? 'is' : 'are'} already on kehikko ${canvas.id} `
        + `(${canvas.name}), ${how}. Nothing was changed.\n\n${canvasText(door.db, canvas, how, seen)}`,
      failed: false,
    }
  }
  if (canvas.placements.length + adding.length > MAX_MODULES) {
    return {
      text: `kehikko ${canvas.id} holds ${canvas.placements.length} containers and no kehikko holds more than ${MAX_MODULES}; nothing was placed.`,
      failed: true,
    }
  }

  /* One at a time, each landing where `place` puts it given the ones before,
     and each cut to what its column can grant before the next is placed —
     because the next one's row is decided by where this one ENDS, and that
     has to be the drawn end rather than the wished one. */
  let placements: Placement[] = canvas.placements
  const landed: { id: string; x: number; y: number; w: number; h: number }[] = []
  for (const id of adding) {
    const fitted = fittedIn(placements, place(placements, id), id)
    if (!fitted) {
      return {
        text:
          `there is no room on kehikko ${canvas.id} (${canvas.name}) for ${id} without taking rows from a `
          + `container somebody arranged, or squeezing it under ${SQUEEZED_ROWS} rows, and this tool does neither. `
          + `${landed.length ? `${landed.map((l) => l.id).join(', ')} would have fitted, but ` : ''}`
          + 'nothing was placed. Ask the person to fold or take something off first.',
        failed: true,
      }
    }
    placements = fitted
    const it = fitted.find((p) => p.i === id)!
    landed.push({ id, x: it.x, y: it.y, w: it.w, h: it.h })
  }

  const written = editCanvas(door.db, canvas.id, { placements })
  if (written) keep(door.db, written.project)
  if (!written) {
    return { text: `kehikko ${canvas.id} was there a moment ago and is not now; nothing was placed.`, failed: true }
  }
  door.wake(canvas.id)

  const said = landed.map((l) => `${l.id} at column ${l.x}, row ${l.y}, ${l.w} wide and ${l.h} tall`).join('; ')
  return {
    text:
      `Placed on kehikko ${canvas.id} (${canvas.name}), ${how}: ${said}.`
      + (already.length
        ? ` ${already.join(', ')} ${already.length === 1 ? 'was' : 'were'} already there and left alone.`
        : '')
      + ' Nothing else was moved.'
      + '\n\n'
      + canvasText(door.db, written, how, seen),
    failed: false,
  }
}

/**
 * The new container's `h` made what the column will actually draw — or
 * `null`, when placing it would cost somebody else rows.
 *
 * ## Squeezing nobody is the rule, and it is the line from the essay applied
 *
 * `granted` will always find an answer: a column that is full gives the new
 * container the floor by taking rows from the containers above it. That is
 * right for a person, who can see what they are doing and drags things back.
 * It is exactly wrong for this door, because the rows taken are somebody's
 * arrangement — the height they dragged a container to — and "may not take
 * away or move anything a person put where it is" is the whole of what
 * separates this tool from the ones that are not here. So the arrangement is
 * granted before and after, and if any existing container's drawn height or
 * top edge differs, the placement is refused with a sentence rather than
 * made. The same refusal covers the new container getting less than the
 * floor and a canvas whose floors alone do not fit.
 *
 * ## What is stored, once it is allowed
 *
 * `x`, `w` and `y` from `place` — the page's own rule, so the record is the
 * one the page would have written — and `h` from `granted`, so the stored
 * rectangle never claims more than will be drawn. `wish` stays the ten rows
 * `place` gave it: that is what was asked for, and `columns.ts` is explicit
 * that a drawn height must never be written into a wish.
 */
function fittedIn(before: readonly Placement[], after: Placement[], id: string): Placement[] | null {
  const heightsBefore = granted(before)
  const topsBefore = tops(before)
  const heightsAfter = granted(after)
  const topsAfter = tops(after)
  for (const p of before) {
    if (heightsAfter.get(p.i) !== heightsBefore.get(p.i) || topsAfter.get(p.i) !== topsBefore.get(p.i)) return null
  }
  const h = heightsAfter.get(id)
  const top = topsAfter.get(id)
  if (h === undefined || top === undefined) return null
  if (h < SQUEEZED_ROWS || top + h > CANVAS_ROWS) return null
  return after.map((p) => (p.i === id ? { ...p, h } : p))
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
        `kehikko ${canvas.id} (${canvas.name}) is in no project, so there is no folder to make an epic in. `
        + `Name a kehikko that is in one.\n\n${roster(door.db)}`,
      failed: true,
    }
  }

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

  return {
    text:
      `Created ${made.epic.slug} ("${made.epic.title}") in ${project.name} — ${made.file}`
      + (made.madeDirectory ? ', and made data/epics there, which did not exist' : '')
      + `. It is in the dropdown now. Kehikko ${canvas.id} (${canvas.name}) is still about ${
        canvas.epic ? canvas.epic : 'no epic'
      }: this tool does not switch what somebody is looking at. If they should open it, ask them.`,
    failed: false,
  }
}

/**
 * One JSON-RPC request at the door.
 *
 * `initialize`, `tools/list`, `tools/call`, notifications answered with nothing,
 * and anything else refused as an unknown method. The same four `doors.ts` has,
 * because an agent's client expects exactly them.
 */
export async function mcp(rpc: Rpc, door: Door, about: { name: string; version: string }): Promise<Reply> {
  const reply = (result: unknown) => ok({ jsonrpc: '2.0', id: rpc.id ?? null, result })
  const text = (s: string, isError = false) =>
    reply({ content: [{ type: 'text', text: s }], ...(isError ? { isError } : {}) })

  if (rpc.method === 'initialize') {
    return reply({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: about,
      instructions:
        'The host somebody’s modules are arranged in. A kehikko is one canvas: several programs side by side '
        + 'around one project and one epic. This door reads what is arranged on one, sets which of those '
        + 'containers are picked out as targets, puts modules on a kehikko as new containers, and creates epics in '
        + 'the project a kehikko stands in. It can ADD; it cannot remove, move or resize a container, switch the '
        + 'kehikko, or change which epic is open — the arrangement belongs to the person looking at it, and what '
        + 'this door adds is what they can see arrive and take off with one press.',
    })
  }
  /* A notification carries no id and is answered with nothing. */
  if (typeof rpc.method === 'string' && rpc.method.startsWith('notifications/')) {
    return { status: 202, body: null }
  }
  if (rpc.method === 'tools/list') return reply({ tools: tools() })

  if (rpc.method === 'tools/call') {
    const name = String(rpc.params?.name ?? '')
    const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>
    if (!(TOOL_NAMES as readonly string[]).includes(name)) {
      const shown = name.length > 60 ? `${name.slice(0, 60)}…` : name
      return text(`no tool "${shown}" here. This door has ${TOOL_NAMES.join(', ')}.`, true)
    }
    try {
      const done = await call(name as ToolName, args, door)
      return text(done.text, done.failed)
    } catch (e) {
      /* A refusal is an answer and the sentence is the useful half, so it comes
         back as a tool error the agent reads rather than a transport failure it
         retries. */
      return text(e instanceof Error ? e.message : String(e), true)
    }
  }

  return {
    status: 404,
    body: { jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32601, message: String(rpc.method) } },
  }
}
