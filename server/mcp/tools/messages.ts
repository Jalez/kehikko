import { answerDoorMessage, doorMessageTools } from '../../doorMessages.ts'
import { doorTool } from '../tool.ts'

/**
 * Messages between agent sessions (protocol 2.95.0): `send_message` and `read_messages`, here, for
 * every conversation, as the protocol words them (`doorMessages.ts`). The conversation is its
 * token's, however it started; with none, the answer says why and what to do.
 */
export const messageTools = doorMessageTools().map(({ name, ...schema }) =>
  doorTool({
    name,
    schema,
    run({ door }, args) {
      if (!door.messaging) return { text: 'Messages are not kept by this host just now. Nothing was sent or read.', failed: true }
      return answerDoorMessage(name, args, door.here, door.messaging)
    },
  }),
)
