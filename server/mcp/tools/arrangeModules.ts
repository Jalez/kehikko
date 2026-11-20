import { arrangedAs, geometryOf, NAMED_WIDTHS, sameGeometry, type ArrangeAsk, type NamedWidth } from '../../../src/host/arrange.ts'
import { COLUMNS } from '../../../src/host/canvases.ts'
import { FOLDED_ROWS } from '../../../src/host/columns.ts'
import { CANVAS_ROWS, MIN_W } from '../../../src/host/fit.ts'
import { ARRANGING_SAID } from '../../arranging.ts'
import { editCanvas, type Canvas } from '../../canvases.ts'
import { keep } from '../../kehikot.ts'
import { MAX_ID, MAX_MODULES, modulesIn } from '../bounds.ts'
import { canvasText } from '../canvasText.ts'
import type { Door } from '../door.ts'
import { kehikkoTool } from '../tool.ts'
import { AGENT, openFirst, SIGNED } from '../words.ts'

/** How many `arrange_modules` changes one conversation may make in a minute. */
export const ARRANGE_PER_MINUTE = 10
const ARRANGE_WINDOW_MS = 60_000

export const arrangeModules = kehikkoTool({
  name: 'arrange_modules',
  schema: {
    description:
      'Resize and move containers on THIS conversation’s own kehikko (the one my_place names), and show ones that '
      + 'are folded or tiles — the same corner and grip a person drags, by the same rules: the grid’s columns and '
      + 'rows, its clamps, the column paying for height, and its push-and-compact for whatever is in the way. Use '
      + 'it to give the module being worked on the room it needs, or to bring a module into view. Open is '
      + 'place_modules; fold and tile are fold_modules. Never another kehikko by its number: one named that is not '
      + 'this conversation’s own is refused, and so is a conversation with no kehikko of its own (set_my_place '
      + 'records one) — unless you pass project, which arranges the kehikko a page shows in that project. Only on a kehikko a page has open, so the person sees it happen, and never while the person is '
      + 'arranging it themselves — a container held by their hand, or what it left not yet stored — when it is '
      + 'refused: ask again once they let go. Removing a container is the person’s: nothing here takes one off. '
      + 'Every call that changes something is marked on the containers it changed as an agent’s doing, and the '
      + 'page offers Undo, which puts back the arrangement before exactly with one press — say what you did '
      + 'anyway. Paced: at most ' + String(ARRANGE_PER_MINUTE) + ' changes a minute for one conversation. read_canvas '
      + 'says every container’s column, row, width and height on a canvas of ' + String(COLUMNS) + ' columns and '
      + String(CANVAS_ROWS) + ' rows, so plan from it. The grid compacts upward, so a container asked below empty '
      + 'space rises to meet what is above it, as under a person’s drop; and a column is a fixed budget, so a '
      + 'taller container is drawn shorter when its column-mates are at their floors. The answer says where '
      + 'each container ended up.',
    annotations: { title: 'Resize, move and show containers', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description:
            'A project this host knows (its folder, name or id): arrange the kehikko a page shows there, whichever '
            + 'project this conversation is in. Left out: this conversation’s own kehikko.',
        },
        kehikko: {
          type: 'number',
          description:
            'Leave it out: this tool acts on this conversation’s own kehikko only. Given, it has to be that one’s id.',
        },
        containers: {
          type: 'array',
          description: 'What each container is to become, applied in order. Leave out what you do not want changed.',
          items: {
            type: 'object',
            properties: {
              module: { type: 'string', description: 'A module id on this kehikko, as read_canvas prints it, e.g. "kehikot.<name>".' },
              size: {
                type: 'string',
                enum: Object.keys(NAMED_WIDTHS),
                description: `A named width: ${Object.entries(NAMED_WIDTHS).map(([name, w]) => `${name} = ${w}`).join(', ')} of ${COLUMNS} columns. Not with columns.`,
              },
              columns: { type: 'number', description: `Width in grid columns, ${MIN_W} to ${COLUMNS}. Not with size.` },
              rows: { type: 'number', description: `Height in grid rows, ${FOLDED_ROWS + 1} to ${CANVAS_ROWS}. To fold, use fold_modules.` },
              column: { type: 'number', description: `Where its left edge goes, 0 to ${COLUMNS - 1}.` },
              row: { type: 'number', description: `Where its top edge goes, 0 to ${CANVAS_ROWS - 1}; the grid compacts upward.` },
            },
            required: ['module'],
          },
        },
        show: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Module ids to bring into view: a folded container is unfolded, a tile put back at the size and place it '
            + 'had. Done before containers, so a tile shown here can then be resized.',
        },
      },
      required: [],
    },
  },
  run: ({ door, canvas, how }, args) => arrangeOn(canvas, how, args, door),
})

/**
 * `arrange_modules`: containers resized, moved and shown on the conversation's own kehikko, by the
 * rules a person's drag is made by (`arrangedAs` in `src/host/arrange.ts`).
 *
 * The person asked for it (agents should "open and resize different modules at will in their
 * kehikko"), and it is held to the bounds the fold's argument set, one tighter:
 *
 *  - **Only the conversation's own kehikko.** `here.canvas`, the one `my_place` names. Another
 *    one named is refused, and so is a conversation with none: an agent rearranging a kehikko it
 *    does not belong to is rearranging somebody else's screen.
 *  - **Seen.** Only on a kehikko a page has open, as a fold.
 *  - **Never under the person's hand.** While a page says the person is dragging or resizing on
 *    it, or what they left is not stored yet (`server/arranging.ts`), it is refused.
 *  - **Signed, and undone with one press.** The wake carries every container's place before and
 *    after (`ArrangeNote`); the page marks the containers changed and offers Undo, which puts back
 *    the arrangement before exactly (`undoneTo`).
 *  - **Paced.** At most `ARRANGE_PER_MINUTE` changes a minute per conversation.
 *  - **Nothing removed.** Every container in is a container out, and the call has no way to say
 *    otherwise; `remove` is refused by name.
 */
async function arrangeOn(
  canvas: Canvas,
  how: string,
  args: Record<string, unknown>,
  door: Door,
): Promise<{ text: string; failed: boolean }> {
  const refuse = (text: string) => ({ text: `${text} Nothing was changed.`, failed: true })
  if (args.remove !== undefined) {
    return refuse('arrange_modules does not remove containers: taking one off is the person’s, with the container’s own remove button.')
  }

  /* What was asked, bounded before it is looked at. */
  const asks: ArrangeAsk[] = []
  const said: string[] = []
  if (args.containers !== undefined) {
    if (!Array.isArray(args.containers) || args.containers.length > MAX_MODULES) {
      return refuse(`containers is a list of at most ${MAX_MODULES} entries, each { module, size?, columns?, rows?, column?, row? }.`)
    }
    const whole = (value: unknown, least: number, most: number): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value >= least && value <= most
    for (const entry of args.containers) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return refuse('every entry in containers is an object: { module, size?, columns?, rows?, column?, row? }.')
      }
      const one = entry as Record<string, unknown>
      if (typeof one.module !== 'string' || !one.module.trim() || one.module.length > MAX_ID) {
        return refuse('every entry in containers names module: a module id as read_canvas prints it, e.g. "kehikot.<name>".')
      }
      const ask: ArrangeAsk = { i: one.module.trim() }
      if (one.size !== undefined && one.columns !== undefined) return refuse(`${ask.i}: give size or columns, not both.`)
      if (one.size !== undefined) {
        if (typeof one.size !== 'string' || !(one.size in NAMED_WIDTHS)) {
          return refuse(`${ask.i}: size is one of ${Object.keys(NAMED_WIDTHS).join(', ')}.`)
        }
        ask.w = NAMED_WIDTHS[one.size as NamedWidth]
      }
      if (one.columns !== undefined) {
        if (!whole(one.columns, MIN_W, COLUMNS)) return refuse(`${ask.i}: columns is a whole number from ${MIN_W} to ${COLUMNS}.`)
        ask.w = one.columns
      }
      if (one.rows !== undefined) {
        if (!whole(one.rows, FOLDED_ROWS + 1, CANVAS_ROWS)) {
          return refuse(`${ask.i}: rows is a whole number from ${FOLDED_ROWS + 1} to ${CANVAS_ROWS}; to fold a container, use fold_modules.`)
        }
        ask.h = one.rows
      }
      if (one.column !== undefined) {
        if (!whole(one.column, 0, COLUMNS - 1)) return refuse(`${ask.i}: column is a whole number from 0 to ${COLUMNS - 1}.`)
        ask.x = one.column
      }
      if (one.row !== undefined) {
        if (!whole(one.row, 0, CANVAS_ROWS - 1)) return refuse(`${ask.i}: row is a whole number from 0 to ${CANVAS_ROWS - 1}.`)
        ask.y = one.row
      }
      if (ask.w === undefined && ask.h === undefined && ask.x === undefined && ask.y === undefined) {
        return refuse(`${ask.i}: say what it is to become — size or columns, rows, column or row.`)
      }
      asks.push(ask)
    }
  }
  let show: string[] = []
  if (args.show !== undefined && args.show !== null) {
    const ids = modulesIn(args.show, 'fold_modules', 'show')
    if (!ids.ok) return refuse(ids.why)
    show = [...new Set(ids.ids)]
  }
  if (!asks.length && !show.length) {
    return refuse('arrange_modules needs containers (what each is to become) or show (what to bring into view), or both.')
  }

  /* Only the conversation's own kehikko — or the one a page shows in a project the call named. */
  const here = door.here ?? null
  const projectNamed = args.project !== undefined && args.project !== null
  if (!projectNamed && !here?.canvas) {
    return refuse(
      `arrange_modules acts only on this conversation’s own kehikko, and this conversation has none recorded${
        here ? ` (its place in ${here.project.name} names no kehikko there now)` : ''
      }. my_place says what it has; set_my_place records one; pass project to arrange the kehikko a page shows in a project — or ask the person to arrange kehikko ${canvas.id} (${canvas.name}).`,
    )
  }
  if (!projectNamed && here?.canvas && here.canvas.id !== canvas.id) {
    return refuse(
      `kehikko ${canvas.id} (${canvas.name}) is not this conversation’s own: that is kehikko ${here.canvas.id} (${here.canvas.name}). `
      + 'arrange_modules never rearranges another kehikko by its number — leave kehikko out to act on its own, or pass project to arrange the one a page shows in that project.',
    )
  }

  /* Seen, as a fold is. */
  const which = door.which()
  const watched = door.watched ? door.watched() : which.ok ? [which.id] : []
  if (!watched.includes(canvas.id)) {
    return refuse(
      `kehikko ${canvas.id} (${canvas.name}) is not open on any page of this host, so nobody would see it change or `
      + `have Undo to press. ${openFirst(door, canvas)} Or leave the arrangement as it is.`,
    )
  }
  if (door.arranging?.(canvas.id)) {
    return refuse(`${ARRANGING_SAID}. Their hand comes first: ask again once they have let go, and read_canvas first, because what you planned from has changed.`)
  }

  const on = new Map(canvas.placements.map((p) => [p.i, p]))
  const named = [...new Set([...asks.map((a) => a.i), ...show])]
  const strangers = named.filter((id) => !on.has(id))
  if (strangers.length) {
    return refuse(
      `${strangers.join(', ')} ${strangers.length === 1 ? 'is not a container' : 'are not containers'} on kehikko ${canvas.id} `
      + `(${canvas.name}); place_modules puts one on. What is on it: ${on.size ? [...on.keys()].join(', ') : 'nothing at all'}.`,
    )
  }
  const tiles = asks.filter((a) => (a.w !== undefined || a.h !== undefined) && on.get(a.i)?.tiled && !show.includes(a.i)).map((a) => a.i)
  if (tiles.length) {
    return refuse(
      `${tiles.join(', ')} ${tiles.length === 1 ? 'is a tile' : 'are tiles'}, which a person cannot resize either — the page draws a tile without a corner. `
      + 'Put it in show as well, and it is put back at its size and place first and then resized.',
    )
  }

  /* Paced, per conversation. */
  const now = door.now ? door.now() : Date.now()
  /* The paces the server keeps for every request (`paces.ts`); none handed in, none outlives this call. */
  const recent = door.arranges ?? new Map<string, number[]>()
  const caller = here ? `${here.via}:${here.token ?? door.session ?? here.conversation ?? here.key ?? 'unnamed'}` : `session:${door.session ?? 'unnamed'}`
  const made = (recent.get(caller) ?? []).filter((at) => now - at < ARRANGE_WINDOW_MS)
  recent.set(caller, made)
  if (made.length >= ARRANGE_PER_MINUTE) {
    const wait = Math.ceil((ARRANGE_WINDOW_MS - (now - made[0]!)) / 1000)
    return refuse(
      `This conversation has changed the arrangement ${made.length} times in the last minute, and ${ARRANGE_PER_MINUTE} is as many as a person can follow. `
      + `Ask again in ${wait} s — and make fewer, larger changes: one call can arrange several containers.`,
    )
  }

  /* Nothing is awaited between reading the arrangement and writing it, as in `foldOn`. */
  const before = canvas.placements
  const after = arrangedAs(before, asks, show)
  const was = new Map(before.map((p) => [p.i, geometryOf(p)]))
  const moved = after.filter((p) => !sameGeometry([geometryOf(p)], [was.get(p.i)!]))
  if (!moved.length) {
    return {
      text: `Everything on kehikko ${canvas.id} (${canvas.name}), ${how}, was already as asked. Nothing was changed.\n\n${canvasText({ db: door.db, canvas, how, seen: await door.seen() })}`,
      failed: false,
    }
  }
  const written = editCanvas(door.db, canvas.id, { placements: after })
  if (written) keep(door.db, written.project)
  if (!written) return refuse(`kehikko ${canvas.id} was there a moment ago and is not now.`)
  made.push(now)
  const asked = new Set(named)
  const changed = moved.filter((p) => asked.has(p.i)).map((p) => p.i)
  const pushed = moved.filter((p) => !asked.has(p.i))
  door.wake(canvas.id, undefined, {
    by: SIGNED,
    changed: changed.length ? changed : moved.map((p) => p.i),
    before: before.map(geometryOf),
    after: written.placements.map(geometryOf),
  })

  const where = (p: { x: number; y: number; w: number; h: number; collapsed: boolean; tiled?: boolean }) =>
    `column ${p.x}, row ${p.y}, ${p.w} wide and ${p.h} tall${p.collapsed ? ', folded' : p.tiled ? ', a tile' : ''}`
  for (const ask of asks) {
    const got = after.find((p) => p.i === ask.i)!
    const short: string[] = []
    if (ask.w !== undefined && got.w !== ask.w) short.push(`${ask.w} wide asked, ${got.w} is what fits from column ${got.x}`)
    if (ask.h !== undefined && got.h !== ask.h) short.push(`${ask.h} tall asked, its column grants ${got.h}`)
    if (ask.y !== undefined && got.y !== ask.y) short.push(`row ${ask.y} asked, the grid compacts it to row ${got.y}`)
    if (ask.x !== undefined && got.x !== ask.x) short.push(`column ${ask.x} asked, it fits at column ${got.x}`)
    said.push(`${ask.i} is at ${where(got)}${short.length ? ` (${short.join('; ')})` : ''}.`)
  }
  for (const id of show) {
    if (asks.some((a) => a.i === id)) continue
    const got = after.find((p) => p.i === id)!
    const had = was.get(id)!
    said.push(had.collapsed || had.tiled ? `${id} is shown, at ${where(got)}.` : `${id} was already in view.`)
  }
  const back = moved
    .filter((p) => asked.has(p.i))
    .map((p) => {
      const old = was.get(p.i)!
      return `{ module: ${JSON.stringify(p.i)}, columns: ${old.w}, rows: ${old.wish}, column: ${old.x}, row: ${old.y} }`
    })
  return {
    text:
      `Arranged kehikko ${canvas.id} (${canvas.name}), ${how}, of ${COLUMNS} columns and ${CANVAS_ROWS} rows: ${said.join(' ')}`
      + (pushed.length ? ` Moved by the grid to make room, as under a person’s drag: ${pushed.map((p) => `${p.i} to ${where(p)}`).join('; ')}.` : '')
      + ' Nothing was removed and no module was told.'
      + ` On the page the containers changed are marked "arranged by ${SIGNED}", with Undo, which puts back the arrangement before exactly with one press; say what you did anyway (${AGENT}).`
      + (back.length ? ` To put it back yourself, close to how it was: arrange_modules with containers: [${back.join(', ')}] — only if the person has not arranged it since; read_canvas says how it is now.` : '')
      + `\n\n${canvasText({ db: door.db, canvas: written, how, seen: await door.seen() })}`,
    failed: false,
  }
}
