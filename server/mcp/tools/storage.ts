import { storageText } from '../../../src/host/storage.ts'
import { doorTool } from '../tool.ts'

export const storage = doorTool({
  name: 'storage',
  schema: {
    description:
      'How much room Kehikot data takes on this machine: for every project this host knows, the size of its '
      + '.kehikot/ folder and of each module’s folder in it (named by module), the file count, the largest files and '
      + 'when it last changed; the total per module across all projects (e.g. "<module>: 2.4 MB across 3 projects"); '
      + 'and Kehikot’s own machine data — its database, installed modules, prepared versions, the browser profile '
      + 'modules share and the logs. A project whose folder is gone is named and not measured. Measuring is bounded in '
      + 'time and size, and a number it did not finish says "at least". Read-only: nothing here deletes anything — '
      + 'clearing a module’s data is that module’s own job. fresh: true measures again instead of answering from '
      + 'the last half minute.',
    annotations: { title: 'Storage overview', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { fresh: { type: 'boolean', description: 'Measure again rather than use a report from the last 30 seconds.' } },
      required: [],
    },
  },
  /* About the machine and every project, so it names no kehikko. */
  async run({ door }, args) {
    if (!door.storage) return { text: 'This host does not measure storage.', failed: true }
    if (args.fresh !== undefined && typeof args.fresh !== 'boolean') return { text: 'storage takes fresh: true or false.', failed: true }
    return { text: storageText(await door.storage(args.fresh === true)), failed: false }
  },
})
