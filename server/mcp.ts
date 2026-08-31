import type { Database } from 'bun:sqlite'

import { listCanvases, editCanvas, type Canvas } from './canvases.ts'
import { projectById } from './projects.ts'
import type { WhichKehikko } from './open.ts'

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
 * ## Two tools, and the list is short on purpose
 *
 * `read_canvas` and `select_modules`. Reading what is arranged, and setting the
 * module selection.
 *
 * What is deliberately absent is everything that REARRANGES: no adding a
 * container, no taking one off, no moving the epic, no switching kehikko, no
 * renaming. Each of those is a way for an agent to change what somebody is
 * looking at while they are looking at it, and the difference between them and
 * this one is that this one is the person's own question being answered — they
 * ticked a box to say "these ones", and the tool exists so an agent can read
 * the answer and, where they asked for it, write it. A tool that moved a
 * container would be the agent redecorating.
 *
 * The next tool anybody will want is a way to READ a module's own state or to
 * put a container on the canvas; both are named in the report rather than
 * written here, because a door is much easier to widen than to narrow.
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
 * The database, a way to say which kehikko is open, a way to wake the page, and
 * a way to find out which modules are actually answering. Passed as an object
 * so that every one of these is a thing a test can supply — the argument
 * checking and the kehikko lookup are the two halves most likely to be got
 * wrong, and neither should need a browser or a running module to exercise.
 */
export interface Door {
  db: Database
  /** Which kehikko a call that named none means. See `open.ts`. */
  which(): WhichKehikko
  /** Say that a kehikko has changed under the page. See `wake.ts`. */
  wake(kehikko: number): void
  /** Every registered module and whether it is answering, from a sweep. */
  seen(): Promise<Sighting[]>
}

const ok = (body: unknown): Reply => ({ status: 200, body })

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
 * Which kehikko a call is about, decided once for both tools.
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
    return lines.join('\n')
  }

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
        ? 'no registration — this container will come off the kehikko on the next sweep'
        : sighting.condition === 'ready'
          ? null
          : `not answering (${sighting.condition})`,
    ].filter((mark): mark is string => mark !== null)
    const name = sighting?.name && sighting.name !== p.i ? ` (${sighting.name})` : ''
    lines.push(`  ${p.i}${name}${marks.length ? ` — ${marks.join(', ')}` : ''}`)
  }
  return lines.join('\n')
}

/**
 * The two tools.
 *
 * Both take an optional `kehikko` and say, in every answer, which one they
 * acted on and how they decided — see `decide`.
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
        + 'targets, the project folder it is standing in, and the epic it is about. A kehikko is one person’s '
        + 'workspace — several programs side by side around one piece of work — so this is what somebody '
        + 'has in front of them right now. Read it before acting on "the selected module", and read it again if '
        + 'you have been working a while, because a person can tick and untick while you work.',
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
              + '"roadmap.notes"]. Every one has to be on this kehikko already; this tool does not put anything '
              + 'on a canvas. An empty list unpicks everything.',
          },
        },
        required: ['modules'],
      },
    },
  ]
}

/** The module ids out of an argument, bounded — or a sentence saying what was wrong with them. */
function modulesIn(value: unknown): { ok: true; ids: string[] } | { ok: false; why: string } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      why:
        'select_modules needs modules: a list of the module ids that should end up selected, e.g. modules: '
        + '["roadmap.journeys"]. Pass modules: [] to unpick everything. It replaces the selection rather than '
        + 'adding to it, so send every id you want selected, not only the new one.',
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

export async function call(
  name: string,
  args: Record<string, unknown>,
  door: Door,
): Promise<{ text: string; failed: boolean }> {
  const where = decide(door, args)
  if (!where.ok) return { text: where.why, failed: true }
  const canvas = where.canvas

  if (name === 'read_canvas') {
    return { text: canvasText(door.db, canvas, where.how, await door.seen()), failed: false }
  }

  const asked = modulesIn(args.modules)
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
        + `${canvas.id} (${canvas.name}), so nothing was selected — this tool does not put modules on a canvas, it `
        + `only picks out ones that are already there. What is on it: ${
          on.size ? [...on].join(', ') : 'nothing at all'
        }.`,
      failed: true,
    }
  }

  const wanted = new Set(asked.ids)
  const placements = canvas.placements.map((p) => ({ ...p, selected: wanted.has(p.i) }))
  const written = editCanvas(door.db, canvas.id, { placements })
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
        + 'around one project and one epic. This door reads what is arranged on one and sets which of those '
        + 'containers are picked out as targets. It cannot add, remove or move anything — the arrangement '
        + 'belongs to the person looking at it.',
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
    if (name !== 'read_canvas' && name !== 'select_modules') {
      const shown = name.length > 60 ? `${name.slice(0, 60)}…` : name
      return text(`no tool "${shown}" here. This door has read_canvas and select_modules.`, true)
    }
    try {
      const done = await call(name, args, door)
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
