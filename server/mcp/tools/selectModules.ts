import { editCanvas, type Canvas } from '../../canvases.ts'
import { keep } from '../../kehikot.ts'
import { modulesIn } from '../bounds.ts'
import { canvasText } from '../canvasText.ts'
import type { Door, Placed } from '../door.ts'
import { KEHIKKO_PROPERTY } from '../params.ts'
import { kehikkoTool } from '../tool.ts'

export const selectModules = kehikkoTool({
  name: 'select_modules',
  schema: {
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
            'The module ids to select, exactly as read_canvas prints them, e.g. ["kehikot.<name>", '
            + '"kehikot.<other>"]. Every one has to be on this kehikko already; use place_modules to put one '
            + 'there first. An empty list unpicks everything.',
        },
      },
      required: ['modules'],
    },
  },
  run: ({ door, canvas, how, placed }, args) => selectOn(canvas, how, args, door, placed()),
})

/**
 * `select_modules`: the containers picked out on a kehikko, replacing what was picked before — the
 * same tick a person makes in a container’s header. Nothing about the modules themselves changes.
 */
async function selectOn(
  canvas: Canvas,
  how: string,
  args: Record<string, unknown>,
  door: Door,
  placed: Placed | undefined,
): Promise<{ text: string; failed: boolean }> {
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
        ? `Selected on kehikko ${canvas.id} (${canvas.name}), ${how}: ${asked.ids.join(', ')}.`
        : `Nothing is selected on kehikko ${canvas.id} (${canvas.name}) any more, ${how}.`)
      + '\n\n'
      + canvasText({ db: door.db, canvas: written, how, seen: await door.seen(), placed }),
    failed: false,
  }
}
