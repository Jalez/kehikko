import {
  AGENT_DELIVERY,
  PLACE_TOKEN_ARG,
  adoptWays,
  agentDeliverResult,
  messageReadResult,
  messageSendResult,
  messageTools,
  notPlacedText,
  readMessagesText,
  sentText,
  serviceDescriptor,
  type MessageToolDefinition,
  type ServiceProvider,
} from 'kehikot-module-protocol'

import type { Here } from './doorPlaces.ts'
import type { MessageAsked } from './messageRoutes.ts'

/**
 * Messages between agent sessions on the host's own door (protocol 2.95.0): `send_message` and
 * `read_messages`, once, for every agent conversation whatever program it runs in.
 *
 * The host keeps the messages (`messageRoutes.ts`); this is the door's half. The caller is the
 * conversation its place token names — on the door's URL, or passed once as `placeToken` and bound
 * to the connection (`doorToken` in `doorPlaces.ts`) — and the message is sent and read exactly as
 * that token's module would through its server: same desk, same stamp, same caps. A connection with
 * no token is told in words why it cannot message and how a conversation is placed, in the words of
 * each module that delivers (`agent.delivery`'s `adopt`). The host names no module of its own.
 *
 * Delivery stays the module's: after a message is kept, the host knocks on each delivering module
 * with sessions in that project (`deliveryKnocker`), and the module hands its idle conversations what
 * waits for them.
 */

export const DOOR_MESSAGE_TOOLS = ['send_message', 'read_messages'] as const
export type DoorMessageTool = (typeof DOOR_MESSAGE_TOOLS)[number]

export const isDoorMessageTool = (name: string): name is DoorMessageTool => (DOOR_MESSAGE_TOOLS as readonly string[]).includes(name)

/** The tools as this door lists them: to every caller, whether or not it can use them yet. */
export function doorMessageTools(): MessageToolDefinition[] {
  return messageTools(false)
}

export interface DoorMessageDeps {
  /** The desk, as a module's server question reaches it (`messageRoutes.serverAnswer`). */
  serverAnswer(module: string, method: 'messages.send' | 'messages.read', params: Record<string, unknown>): Promise<MessageAsked>
  /** The modules providing `agent.delivery` that are in use here. */
  deliverers(): readonly ServiceProvider[]
}

export const DOOR_MESSAGE_SAYS = {
  badKey: 'That placeToken is not a key this host holds for any conversation (made up, mistyped, or taken back when the conversation was disconnected), so nothing was sent or read.',
} as const

/** A `to` whose place names a space and no epic gets the space's first id as its epic (protocol 2.92.0). */
function withEpicFromSpace(to: unknown): unknown {
  if (!to || typeof to !== 'object' || Array.isArray(to)) return to
  const place = (to as { place?: unknown }).place
  if (!place || typeof place !== 'object' || Array.isArray(place)) return to
  const { space, epic } = place as { space?: unknown; epic?: unknown }
  if (epic !== undefined || !Array.isArray(space) || typeof space[0] !== 'string') return to
  return { ...(to as Record<string, unknown>), place: { ...(place as Record<string, unknown>), epic: space[0] } }
}

/** Answer one of the door's message tools for the conversation `here` is. */
export async function answerDoorMessage(
  name: DoorMessageTool,
  args: Record<string, unknown>,
  here: Here | null | undefined,
  deps: DoorMessageDeps,
): Promise<{ text: string; failed: boolean }> {
  if (!here || here.via !== 'token' || !here.token || !here.module) {
    const ways = adoptWays(deps.deliverers().flatMap((one) => {
      const descriptor = serviceDescriptor(AGENT_DELIVERY, one.descriptor)
      return descriptor ? [descriptor] : []
    }))
    const bad = typeof args[PLACE_TOKEN_ARG] === 'string' ? `${DOOR_MESSAGE_SAYS.badKey} ` : ''
    return { text: `${bad}${notPlacedText(ways)}`, failed: true }
  }
  if (name === 'send_message') {
    const params: Record<string, unknown> = { token: here.token, body: args.body }
    if (args.to !== undefined) params.to = withEpicFromSpace(args.to)
    for (const key of ['thread', 'kind', 'choices', 'replyTo'] as const) if (args[key] !== undefined) params[key] = args[key]
    const sent = await deps.serverAnswer(here.module, 'messages.send', params)
    if (!sent.ok) return { text: `Not sent: ${sent.error}`, failed: true }
    const result = messageSendResult.parse(sent.data)
    return { text: sentText(result), failed: result.outcome !== 'sent' }
  }
  const params: Record<string, unknown> = { token: here.token }
  for (const key of ['unread', 'since', 'thread', 'limit'] as const) if (args[key] !== undefined) params[key] = args[key]
  const read = await deps.serverAnswer(here.module, 'messages.read', params)
  if (!read.ok) return { text: `Could not read messages: ${read.error}`, failed: true }
  return { text: readMessagesText(messageReadResult.parse(read.data)), failed: false }
}

export interface KnockerDeps {
  /** The modules providing `agent.delivery` that are in use here. */
  deliverers(): readonly ServiceProvider[]
  /** The modules that issued tokens in a project (by its id), most recent first. */
  issuersIn(project: number): readonly string[]
  /** The project's folder, by id. */
  pathOf(project: number): string | null
  /** A module's registered origin. */
  originOf(module: string): Promise<string | null>
  fetch?: typeof fetch
  now?: () => number
  setTimer?: (run: () => void, ms: number) => unknown
  log?: (line: string) => void
}

/** How often a project's delivering modules are knocked on at most, in ms. */
export const KNOCK_EVERY_MS = 1000

/**
 * The knock on `agent.delivery`'s `deliver` route after a message is kept in a project: each module
 * that delivers and issued tokens there is told `{ project }`, at most once a second per project
 * (what comes faster is one knock at the second's end). The module asks the host what each of its
 * sessions may read, so a knock grants nothing and names no message.
 */
export function deliveryKnocker(deps: KnockerDeps) {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms))
  const last = new Map<number, number>()
  const held = new Set<number>()

  async function send(project: number): Promise<number> {
    last.set(project, now())
    const path = deps.pathOf(project)
    if (!path) return 0
    const issuers = new Set(deps.issuersIn(project))
    let knocked = 0
    for (const provider of deps.deliverers()) {
      if (!issuers.has(provider.module)) continue
      const descriptor = serviceDescriptor(AGENT_DELIVERY, provider.descriptor)
      const origin = descriptor ? await deps.originOf(provider.module).catch(() => null) : null
      if (!descriptor || !origin) continue
      try {
        const response = await (deps.fetch ?? fetch)(new URL(descriptor.deliver, origin), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ project: path }),
          signal: AbortSignal.timeout(3000),
        })
        if (response.ok && agentDeliverResult.safeParse(await response.json().catch(() => null)).success) knocked++
      } catch (error) {
        deps.log?.(`delivery knock on ${provider.module} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return knocked
  }

  return {
    /** Messages changed in this project: knock now, or once when the second is up. */
    knock(project: number): void {
      const since = now() - (last.get(project) ?? -Infinity)
      if (since >= KNOCK_EVERY_MS) {
        void send(project)
        return
      }
      if (held.has(project)) return
      held.add(project)
      setTimer(() => {
        held.delete(project)
        void send(project)
      }, KNOCK_EVERY_MS - since)
    },
    /** For tests: knock at once and say on how many modules. */
    send,
  }
}
