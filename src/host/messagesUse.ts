import { METHODS } from 'kehikot-module-protocol'

/**
 * "Messages to agents": the person's switch, per module and per project, for whether the module's
 * OWN messages reach the agent sessions there (`server/messageMutes.ts`). Kept by the server in
 * `frame.sqlite`; set only by a press in the page (`POST /host/messages/mute`, `PAGE_ONLY`).
 *
 * Off, the host declines that module's own messages (a notice to a session, a page's post, news to
 * every session at a place) and keeps nothing. It never touches the person's own messages sent
 * through a module, nor a session's messages to other sessions. It is never silent: the Container
 * menu's row says "muted", and a module's message in the Inbox's messages offers the switch.
 */

/** The Container menu row's words. */
export const MESSAGES_USE = 'Messages to agents'

/** The row's tooltip while the module's messages are taken. */
export const messagesOnTitle = (name: string): string =>
  `messages ${name} sends of its own reach the agent sessions in this project — untick to take none of them`

/** The row's tooltip while they are muted. */
export const messagesOffTitle = (name: string): string =>
  `${name} is muted: none of its own messages reach the agent sessions in this project — tick to take them again`

/** The offer on a module's own message, and the way back. */
export const muteWords = (name: string): string => `Mute messages from ${name}`
export const unmuteWords = (name: string): string => `Unmute messages from ${name}`

/** The methods a module's own messages go through: a module whose manifest asks for one's capability has the row. */
const SENDING = ['messages.post', 'messages.notify', 'messages.tell'] as const

/**
 * Whether a container's Container menu has the "Messages to agents" row: a module whose manifest
 * asks for a capability its own messages go through (`METHODS`), or one that is muted now, so the
 * way back is where the way in was.
 */
export function offersMessagesUse(manifest: { declares: { uses?: readonly string[] } } | undefined | null, muted: boolean): boolean {
  if (muted) return true
  const uses = manifest?.declares.uses ?? []
  const table = METHODS as Record<string, string>
  return SENDING.some((method) => Object.hasOwn(table, method) && uses.includes(table[method]!))
}
