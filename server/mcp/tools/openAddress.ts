import { addressRefusal, LIMITS } from 'kehikot-module-protocol'

import type { Canvas } from '../../canvases.ts'
import type { Door } from '../door.ts'
import { KEHIKKO_PROPERTY } from '../params.ts'
import { kehikkoTool } from '../tool.ts'
import { openFirst } from '../words.ts'

export const openAddress = kehikkoTool({
  name: 'open_address',
  schema: {
    description:
      'Show a web page in the module on this kehikko that shows pages: a design document, a deployed '
      + 'preview, a dashboard, a pipeline log — anything that is not an issue or a merge request, which are opened '
      + 'by picking them. The address is https:, or http: to this machine (localhost, 127.0.0.1, [::1]); never '
      + 'another scheme, and never one with a user name or password in it. It is opened ONLY inside the canvas: '
      + 'with no module that shows pages on the kehikko it is refused, and nothing is opened in the person’s own '
      + 'browser — place a module that shows pages with place_modules first, or give the person the address. The page that has '
      + 'the kehikko open does it, so one nobody has open is refused. The person sees it arrive, and read_canvas '
      + 'says the last address. Nothing about the arrangement changes.',
    annotations: {
      title: 'Show a web page on the canvas',
      readOnlyHint: false,
      destructiveHint: false,
      /* The same address twice is two requests to open it. */
      idempotentHint: false,
      /* The Browser loads the page from wherever it is. */
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        ...KEHIKKO_PROPERTY,
        url: {
          type: 'string',
          description: 'The address, e.g. "https://example.com/design" or "http://localhost:5173/".',
        },
        title: {
          type: 'string',
          description: 'What to call the page, when you know, e.g. "Design document". Optional.',
        },
      },
      required: ['url'],
    },
  },
  run: ({ door, canvas, how }, args) => openAddressOn(canvas, how, args, door),
})

/**
 * `open_address`: a web page shown in the module on the kehikko that shows
 * pages, through the page that has the kehikko open (protocol 2.16.0).
 *
 * Held tighter than a module's `address.open`: an agent's address goes only
 * into a container that shows pages. With none the page refuses it and offers
 * the person nothing, so no agent can open a page outside the canvas or put a
 * question in front of the person by itself. See `src/host/address.ts`.
 */
async function openAddressOn(
  canvas: Canvas,
  how: string,
  args: Record<string, unknown>,
  door: Door,
): Promise<{ text: string; failed: boolean }> {
  const refuse = (text: string) => ({ text: `${text} Nothing was opened.`, failed: true })
  if (typeof args.url !== 'string') return refuse('open_address needs url: an https: address, or http: to this machine.')
  const refusal = addressRefusal(args.url)
  if (refusal !== null) return refuse(refusal)
  let title: string | undefined
  if (args.title !== undefined) {
    if (typeof args.title !== 'string' || !args.title.trim() || args.title.length > LIMITS.TITLE) {
      return refuse(`title, when given, is the page's name in at most ${LIMITS.TITLE} characters.`)
    }
    title = args.title.trim()
  }
  if (!door.headers?.openAddress) return refuse('This host does not show web addresses.')
  const came = await door.headers.openAddress(canvas.id, args.url, title)
  if (!came) {
    return refuse(
      `kehikko ${canvas.id} (${canvas.name}) is not open on a page of this host that is listening, and an address is `
        + `shown by the page that has the kehikko open. ${openFirst(door, canvas)} Or try again in a moment.`,
    )
  }
  if (!came.ok) return { text: `Not opened: ${came.why}`, failed: true }
  return {
    text: `Showed ${args.url} on kehikko ${canvas.id} (${canvas.name}), ${how}: ${came.why || 'the module that shows pages has it.'}`,
    failed: false,
  }
}
