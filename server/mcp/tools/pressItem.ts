import { LIMITS } from 'kehikot-module-protocol'

import { agentFooterPressable, agentFooterRefusal } from '../../../src/host/footer.ts'
import { agentPressable, agentRefusal, type Pressing } from '../../../src/host/header.ts'
import { listCanvases, type Canvas } from '../../canvases.ts'
import { MAX_ID } from '../bounds.ts'
import type { Door } from '../door.ts'
import { KEHIKKO_PROPERTY } from '../params.ts'
import { kehikkoTool } from '../tool.ts'
import { openFirst } from '../words.ts'

export const pressItem = kehikkoTool({
  name: 'press_item',
  schema: {
    description:
      'Press one item of a module’s header — a view switch, a toggle, a jump or a run the module put in its '
      + 'container’s View, Go or Run menu, or in its footer row — as a person would. read_canvas lists every container’s '
      + 'items under it, and says of each whether an agent may press it. Only those: an item the module has not '
      + 'marked for agents is the person’s, a run that takes a second press to confirm is always the person’s, and '
      + 'an item that names a tool is refused with that tool’s name, because the module’s own MCP door already does '
      + 'the same thing and that is the way to do it. The press is made by a page of this host that has the '
      + 'kehikko open, so one nobody has open is refused. value is the option’s id for a switch or a go item, true '
      + 'or false for a toggle (the state wanted — pressing one that is already there changes nothing), and left '
      + 'out for a run. The answer is whether the module TOOK the press, not whether what it started has '
      + 'finished: a run reports through its item, so read_canvas again to see it running, failed, or what it came '
      + 'to. The container says on screen that an agent pressed it. Nothing about the arrangement changes: no '
      + 'container is moved, resized, folded, selected, added or removed.',
    annotations: {
      title: 'Press a header item',
      /* It changes state inside a module — a view, a setting, a run started. */
      readOnlyHint: false,
      /* And nothing an agent may press destroys anything: a run that needs
         confirming is exactly the kind this tool always refuses. */
      destructiveHint: false,
      /* A switch or a toggle pressed twice is one change; a run pressed twice is two runs. */
      idempotentHint: false,
      /* It reaches a module on this machine and nothing beyond it. */
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        ...KEHIKKO_PROPERTY,
        module: {
          type: 'string',
          description: 'The module id of a container on this kehikko, as read_canvas prints it, e.g. "kehikot.<name>".',
        },
        item: {
          type: 'string',
          description: 'The item’s id, as read_canvas prints it at the start of its line, e.g. "<item-id>".',
        },
        value: {
          type: ['string', 'boolean'],
          description:
            'For a switch or a go item, the id of the option; for a toggle, true to turn it on or false to turn '
            + 'it off. Leave it out for a run.',
        },
        text: {
          type: 'string',
          description:
            'For a field in a footer, the text to submit, as if the person typed it and pressed Enter. Leave it out '
            + 'for every other item.',
        },
      },
      required: ['module', 'item'],
    },
  },
  run: ({ door, canvas, how }, args) => pressOn(canvas, how, args, door),
})

/**
 * `press_item`: one item of one module's header, pressed through the page.
 *
 * Every refusal is decided here, before anything is sent, from what the page
 * posted — and each names what exists, so the next call can be the right one.
 * What is sent is an item id and a value; the page looks the item up in what
 * the frame declared to it and judges it again (`orderedRef` in `App.tsx`).
 */
async function pressOn(
  canvas: Canvas,
  how: string,
  args: Record<string, unknown>,
  door: Door,
): Promise<{ text: string; failed: boolean }> {
  const refuse = (text: string) => ({ text: `${text} Nothing was pressed.`, failed: true })
  const short = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_ID

  if (!short(args.module) || !short(args.item)) {
    return refuse(
      'press_item needs module and item: the module id of a container and the id of one of its header items, both as '
        + 'read_canvas prints them, e.g. module: "kehikot.<name>", item: "<item-id>".',
    )
  }
  if (args.value !== undefined && typeof args.value !== 'boolean' && !short(args.value)) {
    return refuse(
      'value, when given, is the id of an option (for a switch or a go item) or true or false (for a toggle). Leave it '
        + 'out for a run.',
    )
  }
  if (args.text !== undefined && (typeof args.text !== 'string' || args.text.length > LIMITS.FOOTER_INPUT)) {
    return refuse(`text, when given, is the text to submit in a footer field, at most ${LIMITS.FOOTER_INPUT} characters. Leave it out for every other item.`)
  }
  const module = args.module.trim()
  const press: Pressing = {
    item: args.item.trim(),
    ...(args.value === undefined ? {} : { value: args.value }),
    ...(typeof args.text === 'string' ? { text: args.text } : {}),
  }
  if (!door.headers) return refuse('This host does not press header items.')

  const on = canvas.placements.map((p) => p.i)
  if (!on.includes(module)) {
    return refuse(
      `${module} is not a container on kehikko ${canvas.id} (${canvas.name}). What is on it: ${
        on.length ? on.join(', ') : 'nothing at all'
      }.`,
    )
  }

  const declared = door.headers.on(canvas.id)
  if (!declared) {
    const which = door.which()
    const watched = door.watched ? door.watched() : which.ok ? [which.id] : []
    const names = new Map(listCanvases(door.db).map((c) => [c.id, c.name]))
    /* A page can have said it has this kehikko open and still not be one
       that can press: its stream closed, or it has not yet said what its
       modules declared. Said as that, not as "open somewhere". */
    if (watched.includes(canvas.id)) {
      return refuse(
        `A page of this host reported kehikko ${canvas.id} (${canvas.name}) open, and it is not listening now or has `
          + 'not yet said what its modules declared — a header item is pressed by the page that is showing the '
          + 'module, and nothing else can reach its frame. If the canvas is on screen, try again in a moment; if it '
          + 'is not, ask the person to open it.',
      )
    }
    return refuse(
      `kehikko ${canvas.id} (${canvas.name}) is not open on any page of this host, and a header item is pressed by `
        + `the page that is showing the module — nothing else can reach its frame. ${openFirst(door, canvas)} ${
          watched.length
            ? `Open on a page right now: ${watched.map((id) => `${id} (${names.get(id) ?? 'deleted'})`).join(', ')}.`
            : 'No page of this host has any kehikko open right now.'
        }`,
    )
  }

  const items = declared.get(module) ?? []
  /* Protocol 2.38.0: an item not in the header may be in the footer, pressed by the same id. The header wins
     an id both declare, as it always has. */
  const footed = door.headers.footers?.(canvas.id) ?? null
  const footer = footed?.get(module) ?? []
  const inFooter = !items.some((one) => one.id === press.item) && footer.some((one) => one.id === press.item)
  if (!items.length && !footer.length) {
    const others = on.filter((id) => agentPressable(declared.get(id) ?? []).length || agentFooterPressable(footed?.get(id) ?? []).length)
    return refuse(
      `${module} has declared no header or footer items, so there is nothing of its to press. ${
        others.length
          ? `Containers on kehikko ${canvas.id} with something an agent may press: ${others.join(', ')}.`
          : `No container on kehikko ${canvas.id} has an item an agent may press.`
      }`,
    )
  }

  const refusal = inFooter ? agentFooterRefusal(footer, press, module) : agentRefusal(items, press, module)
  if (refusal) return refuse(refusal)
  if (inFooter) press.place = 'footer'

  const came = await door.headers.press(canvas.id, module, press)
  if (!came) {
    return refuse(
      `The page that had kehikko ${canvas.id} (${canvas.name}) open is not listening any more, so there is nothing `
        + 'to make the press.',
    )
  }
  if (!came.ok) return { text: `Not pressed: ${came.why}`, failed: true }

  const item = inFooter ? footer.find((one) => one.id === press.item) : items.find((one) => one.id === press.item)
  return {
    text:
      `${press.text === undefined ? 'Pressed' : 'Submitted'} ${press.item}${press.value === undefined ? '' : ` (${JSON.stringify(press.value)})`}${press.text === undefined ? '' : ` with ${JSON.stringify(press.text)}`} in ${module} on `
      + `kehikko ${canvas.id} (${canvas.name}), ${how}, and the module took it.`
      + (item?.kind === 'run'
        ? ' Taken is not finished: a run says how it is going through its own item, so read_canvas again to see it '
          + 'running, failed, or what it came to.'
        : ' read_canvas shows how the item stands now.')
      + ' The container says on the page that an agent pressed it; say what you did anyway. Nothing about the '
      + 'arrangement was changed.',
    failed: false,
  }
}
