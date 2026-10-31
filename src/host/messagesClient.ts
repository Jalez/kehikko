import type { AgentMessage } from 'kehikot-module-protocol'

/**
 * The page's side of the messages between agent sessions (protocol 2.41.0,
 * `server/messageRoutes.ts`): read the project's, newest first, and clear them
 * on the person's press. Every call answers `null` when the server could not be
 * reached or refused. Nothing here sends: messages are an agent session's.
 */

export interface MessagesRead {
  count: number
  messages: AgentMessage[]
}

export async function fetchMessages(project: number, limit?: number): Promise<MessagesRead | null> {
  try {
    const response = await fetch(`/host/messages?project=${project}${limit === undefined ? '' : `&limit=${limit}`}`)
    if (!response.ok) return null
    const got = (await response.json()) as { ok?: unknown; count?: unknown; messages?: unknown }
    return got.ok === true && Array.isArray(got.messages) && typeof got.count === 'number' ? { count: got.count, messages: got.messages as AgentMessage[] } : null
  } catch {
    return null
  }
}

export async function clearMessages(project: number): Promise<boolean> {
  try {
    const response = await fetch('/host/messages/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project }) })
    return response.ok
  } catch {
    return false
  }
}

/**
 * The host said a project's messages changed (`{ messages: N }` on `/host/watch`): the view
 * reads again. A window event, like the updates' one, so nothing above the view holds them.
 */
const MESSAGES_CHANGED = 'kehikot:messages-changed'
export function announceMessagesChanged(project: number): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<{ project: number }>(MESSAGES_CHANGED, { detail: { project } }))
}
export function onMessagesChanged(then: (project: number) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const heard = (event: Event) => {
    const project = (event as CustomEvent<{ project?: unknown }>).detail?.project
    if (typeof project === 'number') then(project)
  }
  window.addEventListener(MESSAGES_CHANGED, heard)
  return () => window.removeEventListener(MESSAGES_CHANGED, heard)
}

/** Who a message is for, in the person's words. Generic: a module is named by what the host knows it as. */
export function toWords(to: AgentMessage['to'], nameOf: (module: string) => string = (module) => module): string {
  if (to.session) return `one ${nameOf(to.session.module)} session (${to.session.session.slice(0, 12)})`
  if (to.module) return `every ${nameOf(to.module)} session`
  if (to.place) return [to.place.epic ? `epic ${to.place.epic}` : '', to.place.kehikko ? `kehikko ${to.place.kehikko}` : ''].filter(Boolean).join(' on ')
  return 'everyone in the project'
}

/** Where the sender was, in a few words. */
export function fromWords(message: AgentMessage): string {
  const place = message.from.place
  return [place.epic ? `epic ${place.epic}` : 'no epic', place.kehikko ? `kehikko ${place.kehikko}` : ''].filter(Boolean).join(' on ')
}
