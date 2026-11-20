import { isSkillName } from 'kehikot-module-protocol'

import { kehikkoSkillsText, listKehikkoSkills } from '../../kehikkoSkills.ts'
import { projectById } from '../../projects.ts'
import { KEHIKKO_PROPERTY } from '../params.ts'
import { kehikkoTool } from '../tool.ts'

export const kehikkoSkills = kehikkoTool({
  name: 'kehikko_skills',
  schema: {
    description:
      'The skills the person wrote for a kehikko (protocol 2.53.0): instructions for every agent session on it, '
      + 'whichever module runs the session and whatever space it works in. Without name: each skill’s name and its '
      + 'one-line description, which says when to use it. With name: that skill’s whole text (its SKILL.md), to '
      + 'follow as a skill when it fits the task — the way to read one this conversation did not load because the '
      + 'person added or changed it after the conversation started. Read-only: only the person adds, changes or '
      + 'removes a kehikko’s skills, from the kehikko menu; no tool does.',
    annotations: { title: 'This kehikko’s skills', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        ...KEHIKKO_PROPERTY,
        name: { type: 'string', maxLength: 40, description: 'One skill’s name, for its whole text. Left out: the list.' },
      },
      required: [],
    },
  },
  run({ door, canvas }, args) {
    if (args.name !== undefined && (typeof args.name !== 'string' || !isSkillName(args.name))) {
      return { text: 'name is one skill’s name, as the list prints it (lowercase words joined by dashes), or left out.', failed: true }
    }
    const project = canvas.project === null ? null : projectById(door.db, canvas.project)
    return kehikkoSkillsText(canvas, listKehikkoSkills(project?.path ?? null, canvas.key), args.name as string | undefined)
  },
})
