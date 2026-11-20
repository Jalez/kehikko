import { LIMITS } from 'kehikot-module-protocol'

import type { Canvas } from '../../canvases.ts'
import type { Door } from '../door.ts'
import { KEHIKKO_PROPERTY } from '../params.ts'
import { kehikkoTool } from '../tool.ts'

export const proposeAdoption = kehikkoTool({
  name: 'propose_adoption',
  schema: {
    description:
      'Propose which space a tracker item no space names belongs to (by its top-level space, and optionally its '
      + 'direct sub-spaces — epic and parts are the older names these arguments keep), and which earlier '
      + 'conversations worked on it — when Kehikot started you to adopt one: find the spaces with read_canvas, the '
      + 'item with read_inbox or read_tracker, and the conversations in your own session history. It ONLY proposes: the person sees it in Kehikot and confirms '
      + 'with one press, or changes it. Nothing is written until they do, and this tool never adopts.',
    inputSchema: {
      type: 'object',
      properties: {
        ...KEHIKKO_PROPERTY,
        ref: { type: 'string', description: 'The item\'s ref, exactly as your prompt spells it.' },
        epic: { type: 'string', description: 'The top-level space’s id (older name: the epic’s slug), as read_canvas prints it.' },
        parts: { type: 'array', items: { type: 'string' }, description: 'Ids of its direct sub-spaces (older name: parts), as read_canvas prints them. Optional.' },
        conversations: { type: 'array', items: { type: 'string' }, description: 'Session ids of the earlier conversations that worked on it. Optional.' },
        why: { type: 'string', description: `One or two sentences the person reads, at most ${LIMITS.REASON} characters.` },
      },
      required: ['ref', 'epic', 'why'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  run: ({ door, canvas }, args) => proposeAt(canvas, args, door),
})

/**
 * `propose_adoption`: an agent's proposal for a tracker item no epic names. Fills the person's dialog;
 * adopts nothing. The person's press in the page adopts (`inbox.adopt`), and no tool reaches it.
 */
function proposeAt(canvas: Canvas, args: Record<string, unknown>, door: Door): { text: string; failed: boolean } {
  if (!door.adoption) return { text: 'This host takes no adoption proposals.', failed: true }
  if (canvas.project === null) return { text: `kehikko ${canvas.id} (${canvas.name}) is in no project. Pass project (a project’s folder, name or id) to act on any project this host knows.`, failed: true }
  const slug = /^[a-z0-9-]{1,80}$/
  const ref = typeof args.ref === 'string' && args.ref.length <= 400 ? args.ref.trim() : ''
  const epic = typeof args.epic === 'string' && slug.test(args.epic) ? args.epic : ''
  const why = typeof args.why === 'string' ? args.why.trim().slice(0, LIMITS.REASON) : ''
  const list = (value: unknown, test: (one: string) => boolean): string[] | null =>
    value === undefined ? [] : Array.isArray(value) && value.length <= 20 && value.every((one) => typeof one === 'string' && test(one)) ? (value as string[]) : null
  const parts = list(args.parts, (one) => slug.test(one))
  const conversations = list(args.conversations, (one) => one.length > 0 && one.length <= 128)
  if (!ref || !epic || !why || parts === null || conversations === null) {
    return { text: 'propose_adoption needs ref, epic (the top-level space’s id) and why (and optionally parts — its direct sub-spaces — and conversations), as your prompt spells them.', failed: true }
  }
  const out = door.adoption.propose(canvas.project, ref, { epic, parts, conversations, why })
  return out.ok ? { text: out.said, failed: false } : { text: out.why, failed: true }
}
