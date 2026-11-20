import { settingsText } from '../../../src/host/moduleSettings.ts'
import { projectById } from '../../projects.ts'
import { MAX_ID } from '../bounds.ts'
import { KEHIKKO_PROPERTY } from '../params.ts'
import { kehikkoTool } from '../tool.ts'

export const moduleSettings = kehikkoTool({
  name: 'module_settings',
  schema: {
    description:
      'The settings of the modules in a kehikko’s project, as each module declares them (protocol 2.15.0): every '
      + 'setting’s label, key, type, value now, whether it is kept in the project or on this machine, and who may '
      + 'change it. Leave module out for every module that has settings; name one (its id, e.g. kehikot.<name>) for '
      + 'that one. Read-only: this host changes no setting. A setting marked "only the person" is changed by the '
      + 'person in Kehikot’s Settings or on the module’s page; any other is changed at the module’s own door '
      + '(POST /api/kehikot/settings on the module, { project, key, value }), never through this host.',
    annotations: { title: 'Modules’ settings', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        ...KEHIKKO_PROPERTY,
        module: { type: 'string', maxLength: MAX_ID, description: 'One module’s id. Left out: every module with settings.' },
      },
      required: [],
    },
  },
  async run({ door, canvas }, args) {
    if (!door.moduleSettings) return { text: 'This host does not read modules’ settings.', failed: true }
    if (args.module !== undefined && (typeof args.module !== 'string' || !args.module || args.module.length > MAX_ID)) {
      return { text: 'module is one module’s id, e.g. kehikot.<name>, or left out.', failed: true }
    }
    const project = canvas.project === null ? null : projectById(door.db, canvas.project)
    const path = project?.path ?? null
    const listed = await door.moduleSettings.list()
    const asked = typeof args.module === 'string' ? listed.filter((one) => one.id === args.module) : listed.filter((one) => one.fields.length > 0)
    if (typeof args.module === 'string' && !asked.length) return { text: `No module here is called ${args.module}. ${listed.length ? `The modules are ${listed.map((one) => one.id).join(', ')}.` : ''}`, failed: true }
    if (!asked.length) return { text: 'No module here declares settings.', failed: false }
    const said: string[] = []
    for (const one of asked) {
      if (!one.fields.length) said.push(`${one.name} (${one.id}) has no settings it shows.`)
      else if (!one.ready) said.push(`${one.name} (${one.id}) is not running, so its settings cannot be read now.`)
      else said.push(settingsText(await door.moduleSettings.read(one.id, path), path))
    }
    return { text: said.join('\n\n'), failed: false }
  },
})
