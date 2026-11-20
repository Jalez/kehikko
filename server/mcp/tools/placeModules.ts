import { COLUMNS, place } from '../../../src/host/canvases.ts'
import { granted, SQUEEZED_ROWS, tops } from '../../../src/host/columns.ts'
import { CANVAS_ROWS } from '../../../src/host/fit.ts'
import { editCanvas, listCanvases, type Canvas, type Placement } from '../../canvases.ts'
import { keep } from '../../kehikot.ts'
import { MAX_MODULES, modulesIn } from '../bounds.ts'
import { canvasText } from '../canvasText.ts'
import type { Door } from '../door.ts'
import { KEHIKKO_PROPERTY } from '../params.ts'
import { kehikkoTool } from '../tool.ts'

export const placeModules = kehikkoTool({
  name: 'place_modules',
  schema: {
    description:
      'Put modules on a kehikko, as containers, where the person’s own add button would put them: beside the '
      + 'last container if the bottom row has room, otherwise on a new row underneath. Nothing already there is '
      + 'moved, resized or removed — this only adds, and the person sees each container arrive and can take it '
      + 'off with one press. Which modules are SUITABLE is your judgement, not this tool’s: it places what it is '
      + 'told, refuses what it cannot place, and says what it did: where each container landed, as a column and row '
      + `of a grid ${COLUMNS} columns wide and ${CANVAS_ROWS} rows tall (it was 12 columns before; a half-width `
      + `container is ${COLUMNS / 2} wide). A module already on the kehikko is left alone `
      + 'and named as such; a module not registered on this computer is refused, whole, because a container for '
      + 'it would be drawn as missing and there is nothing to work in. There is deliberately no tool that takes a '
      + 'container off, moves one, or changes the space: those undo work somebody did with a pointer, and the '
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
            + 'and not on this kehikko", e.g. ["kehikot.<name>"]. In the order they should be added.',
        },
      },
      required: ['modules'],
    },
  },
  run: ({ door, canvas, how }, args) => placeOn(canvas, how, args, door),
})

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
  named: Canvas,
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
  /* Read again, after the sweep: what the person did while it was out is in
     this arrangement, and nothing is awaited between here and the write, so
     the list written is the one read here with the new containers added. */
  const canvas = listCanvases(door.db).find((c) => c.id === named.id)
  if (!canvas) {
    return { text: `kehikko ${named.id} was there a moment ago and is not now; nothing was placed.`, failed: true }
  }
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
        + `(${canvas.name}), ${how}. Nothing was changed.\n\n${canvasText({ db: door.db, canvas, how, seen })}`,
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
          + 'nothing was placed. Fold something with fold_modules, or ask the person to take something off, first.',
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
      `Placed on kehikko ${canvas.id} (${canvas.name}), ${how}: ${said} (of ${COLUMNS} columns and ${CANVAS_ROWS} rows).`
      + (already.length
        ? ` ${already.join(', ')} ${already.length === 1 ? 'was' : 'were'} already there and left alone.`
        : '')
      + ' Nothing else was moved.'
      + '\n\n'
      + canvasText({ db: door.db, canvas: written, how, seen, describing: new Set(adding) }),
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
 * rectangle never claims more than will be drawn. `wish` stays the twenty rows
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
