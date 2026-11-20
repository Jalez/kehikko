import { readLogs, readLogsText } from '../../readLogs.ts'
import { doorTool } from '../tool.ts'

export const readLogsTool = doorTool({
  name: 'read_logs',
  schema: {
    description:
      'Read Kehikot’s own logs on this machine, to find out afterwards why something happened. which "host" is the '
      + 'host’s log: what it printed, its errors, and a line at every start with its versions, pid and port. "page" is '
      + 'the canvas page’s: its console warnings and errors, and the decisions it made — whether frames got their '
      + 'stable /m/<id>/ addresses and how long that check took, which address each module’s frame was given and '
      + 'why, a module reported silent or followed to a new address, a project or kehikko switch, a module start '
      + 'or restart pressed. "module" is one module’s own output (with module). since is an ISO time or a span back '
      + 'from now (30s, 15m, 2h, 1d); grep is plain text, matched without regard to case; lines is how many of the '
      + 'last matching lines (1 to 400, default 100). Secrets are scrubbed. Read-only: nothing here writes, '
      + 'clears or deletes a log.',
    annotations: { title: 'Read the logs', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        which: { type: 'string', enum: ['host', 'page', 'module'], description: 'Which log. Default "host".' },
        module: { type: 'string', description: 'With which "module": the module’s id as read_canvas prints it, e.g. "kehikot.<name>".' },
        since: { type: 'string', description: 'Only lines from this time on: an ISO time, or 30s, 15m, 2h, 1d back from now.' },
        grep: { type: 'string', description: 'Only lines containing this text (case does not matter). At most 200 characters.' },
        lines: { type: 'number', description: 'How many of the last matching lines, 1 to 400. Default 100.' },
      },
      required: [],
    },
  },
  /* About this machine, so it names no kehikko. Read-only (`readLogs.ts`). */
  run: (_call, args) => readLogsText(readLogs(args)),
})
