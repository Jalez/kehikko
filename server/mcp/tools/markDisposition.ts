import { DISPOSITIONS, LIMITS, methodParams } from 'kehikot-module-protocol'

import type { Canvas } from '../../canvases.ts'
import { setDisposition } from '../../dispositions.ts'
import { projectById } from '../../projects.ts'
import type { Door } from '../door.ts'
import { KEHIKKO_PROPERTY } from '../params.ts'
import { kehikkoTool } from '../tool.ts'
import { AGENT, missingSaid, roster } from '../words.ts'

export const markDisposition = kehikkoTool({
  name: 'mark_disposition',
  schema: {
    description:
      'Say why a closed reference closed — done, wont-do, duplicate or superseded — in the project a kehikko is '
      + 'standing in, the same mark a person makes from a module. A tracker’s "closed" covers all four, and every '
      + 'module showing the ref reads this mark over whatever the tracker implies: a module that counts steps '
      + 'stops counting a won’t-do step as delivered, a module that lists refs can hide it. One mark per ref; a new one replaces the old. Pass '
      + 'value: null to take a mark back. It is signed as yours (agent, through MCP) with the time, and the person '
      + 'sees it at once. Mark what you know — a ref you closed as done, a duplicate you found — not a guess.',
    inputSchema: {
      type: 'object',
      properties: {
        ...KEHIKKO_PROPERTY,
        ref: {
          type: 'string',
          description: 'The reference, as modules spell it, e.g. "#2274" or "gh:owner/repo#2274".',
        },
        value: {
          type: ['string', 'null'],
          enum: [...DISPOSITIONS, null],
          description: 'done, wont-do, duplicate or superseded; null removes the mark.',
        },
        target: {
          type: 'string',
          description:
            'For duplicate, the ref it duplicates; for superseded, the ref that replaced it. Refused for done and '
            + 'wont-do.',
        },
        note: {
          type: 'string',
          description: `Optional, one line of why, at most ${LIMITS.SUMMARY} characters.`,
        },
      },
      required: ['ref', 'value'],
    },
  },
  run: ({ door, canvas }, args) => markAt(canvas, args, door),
})

/**
 * A disposition, from an agent.
 *
 * On the near side of the door's line (the essay in `server/mcp.ts`): a mark changes no arrangement, adds a
 * row a person sees arrive, and is taken back with one press — or by this tool
 * with `value: null`. The arguments go through the protocol's own schema for
 * `disposition.set`, so an agent and a module are refused for the same things
 * in the same words, and the write is the same function the frames reach.
 */
function markAt(
  canvas: Canvas,
  args: Record<string, unknown>,
  door: Door,
): { text: string; failed: boolean } {
  const project = canvas.project === null ? null : projectById(door.db, canvas.project)
  if (!project) {
    return {
      text:
        `kehikko ${canvas.id} (${canvas.name}) is in no project, so there is nowhere to keep a disposition. `
        + `Pass project (a project’s folder, name or id) to act on any project this host knows.\n\n${roster(door.db)}`,
      failed: true,
    }
  }
  if (project.missing) return { text: missingSaid(project), failed: true }

  /* `value` is required here even though the schema would read a missing one
     as an error anyway: the sentence for it should say that null is how a
     mark is taken back, which zod's would not. */
  if (!Object.hasOwn(args, 'value')) {
    return {
      text: `mark_disposition needs value: one of ${DISPOSITIONS.join(', ')}, or null to take the mark back.`,
      failed: true,
    }
  }
  const parsed = methodParams['disposition.set'].safeParse({
    ref: args.ref,
    value: args.value,
    ...(args.target === undefined || args.target === null ? {} : { target: args.target }),
    ...(args.note === undefined || args.note === null ? {} : { note: args.note }),
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? issue.path.join('.') : 'the mark'
    return { text: `nothing was marked — ${where}: ${issue?.message ?? 'not a disposition'}.`, failed: true }
  }

  const done = setDisposition(project.path, parsed.data, AGENT)
  if (!done.ok) return { text: done.why, failed: true }
  if (done.changed) door.dispositionsChanged(project.id)

  const ref = parsed.data.ref
  const said = done.mark
    ? `${ref} is marked ${done.mark.value}${done.mark.target ? ` (${done.mark.target})` : ''} in ${project.name}`
    : `${ref} has no mark in ${project.name}`
  return {
    text:
      `${said}${done.changed ? '' : ' — it already said that, so nothing was written'}. `
      + `${done.marks.length} ref${done.marks.length === 1 ? ' is' : 's are'} marked in this project`
      + (done.marks.length
        ? `: ${done.marks.map((m) => `${m.ref} ${m.value}${m.target ? ` → ${m.target}` : ''}`).join(', ')}.`
        : '.'),
    failed: false,
  }
}
