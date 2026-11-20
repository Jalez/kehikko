import { readInboxText } from '../../inboxText.ts'
import { KEHIKKO_PROPERTY } from '../params.ts'
import { kehikkoTool } from '../tool.ts'

export const readInbox = kehikkoTool({
  name: 'read_inbox',
  schema: {
    description:
      'The host’s one inbox for a kehikko’s project: what the modules say needs the person (most pressing '
      + 'first: urgent, then the longest waiting), what is working, what has finished and not been seen, and '
      + 'what happened earlier. Each line says who said it before it says what — the name is the host’s, the '
      + 'words in quotes are the module’s. scope "here" (the default) is this kehikko plus whatever does not say '
      + 'which kehikko it belongs to; "everywhere" is the whole project, which is how to see what is going on '
      + 'in other kehikot and spaces. earlier is how many earlier lines to list (0 to 100, default 10). '
      + 'A line whose module named the case says "(event <id>: \"<what the module calls it>\")", e.g. a finished '
      + 'session that was research. A line whose module the person turned "Use inbox" off for says "(muted by the '
      + 'person)": it is kept, and the person is not shown it, sounded or counted for it. Read-only: nothing an agent '
      + 'can do marks anything seen, puts it away or mutes a module — that is the person’s.',
    annotations: { title: 'Read the inbox', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        ...KEHIKKO_PROPERTY,
        scope: {
          type: 'string',
          enum: ['here', 'everywhere'],
          description: '"here" is this kehikko (and what names no kehikko); "everywhere" is the whole project.',
        },
        earlier: {
          type: 'number',
          description: 'How many lines of what happened earlier to list, 0 to 100. Default 10.',
        },
      },
      required: [],
    },
  },
  run({ door, canvas, how }, args) {
    if (!door.inbox) return { text: 'This host does not hold an inbox.', failed: true }
    const scope = args.scope === undefined ? 'here' : args.scope
    if (scope !== 'here' && scope !== 'everywhere') {
      return { text: 'read_inbox takes scope: "here" (this kehikko) or "everywhere" (the whole project).', failed: true }
    }
    const asked = args.earlier === undefined ? 10 : args.earlier
    if (typeof asked !== 'number' || !Number.isInteger(asked) || asked < 0 || asked > 100) {
      return { text: 'read_inbox takes earlier: a whole number from 0 to 100 — how many earlier lines to list.', failed: true }
    }
    return { text: readInboxText(door.inbox, door.db, canvas, how, { scope, earlier: asked }), failed: false }
  },
})
