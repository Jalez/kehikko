import { activityRowsFor, earlierLines } from '../../inboxText.ts'
import { canvasText } from '../canvasText.ts'
import { KEHIKKO_PROPERTY } from '../params.ts'
import { kehikkoTool } from '../tool.ts'

export const readCanvas = kehikkoTool({
  name: 'read_canvas',
  schema: {
    description:
      'What is arranged on a kehikko: which containers are on it, which of them have been picked out as targets, '
      + 'the project folder it is standing in, and the space it is about, with the project’s whole tree of spaces '
      + 'and each space’s path of ids (what set_my_place, jump and edit_space take) — and which registered modules '
      + 'are NOT on it, which is what place_modules can add — and how its modules affect each other (who follows '
      + 'whose passage, who shows whose pages, whose tools an agent session is handed), each connection on or '
      + 'switched off by the person for this kehikko. Only the person switches them. Each container says its scope '
      + '— what its content belongs to: This computer, Project, Space, Sub-space or Kehikko — and whether the '
      + 'person changed it from the module’s default; only the person changes a scope. A kehikko is one person’s '
      + 'workspace — several programs side by side around one piece of work — so this is what somebody has in '
      + 'front of them right now. Read it before acting on "the selected module", and read it again if you have '
      + 'been working a while, because a person can tick and untick while you work.',
    inputSchema: { type: 'object', properties: { ...KEHIKKO_PROPERTY }, required: [] },
  },
  async run({ door, canvas, how, placed }) {
    const at = placed()
    return {
      text: canvasText({
        db: door.db,
        canvas,
        how,
        seen: await door.seen(),
        declared: door.headers ? door.headers.on(canvas.id) : undefined,
        describing: 'all',
        activity: door.inbox && canvas.project !== null ? activityRowsFor(door.inbox, door.db, canvas.project) : undefined,
        earlier: door.inbox && canvas.project !== null ? earlierLines(door.inbox, door.db, canvas.project, 5, Date.now()) : undefined,
        placed: at,
        location: door.headers?.location?.(canvas.id),
        address: door.headers?.address?.(canvas.id),
        footed: door.headers?.footers?.(canvas.id),
      }),
      failed: false,
    }
  },
})
