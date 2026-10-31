import {
  LIMITS,
  METHODS,
  SERVER_ASK_PATH,
  SERVER_METHODS,
  SERVER_PASS_PATH,
  needsProject,
  serverAskSchema,
  serverPassResult,
  type ServerAskRefusal,
  type ServerAskResult,
} from 'kehikot-module-protocol'

import { hold } from '../src/host/grants.ts'
import type { Answer } from './answers.ts'
import type { MessageAsked } from './messageRoutes.ts'
import { tag, untraced } from './traffic.ts'

/**
 * A module's SERVER asking this host a question (protocol 2.19.0): `POST /host/server-ask`.
 *
 * The page's questions come through the frame and `/host/call`; a module's server has no frame, and
 * its MCP door needs the same tracker reading to answer an agent with no page open. This route
 * answers it what the page would be answered, from the same reading, held to the same grant.
 *
 * ## Who is asking
 *
 * The question names a module and carries a pass the module's server minted for it. Before
 * anything else is looked at, the host asks the module at its REGISTERED origin — the registry's
 * address, never one in the question — whether it minted that pass (`SERVER_PASS_PATH`, answered by
 * the protocol's doors, spent by the asking). Only the process serving there can say yes, so a
 * program that merely names a module gets nothing.
 *
 * ## What it may ask
 *
 * `SERVER_METHODS` only — reads that need no frame — each held to the manifest the last sweep read
 * (`hold`, the same rule `/host/call` and the canvas use), about a project this host holds. The
 * answer is `answer()` in `answers.ts`, the page's own decision table, so the two cannot differ. It
 * reads the stored reading: a question costs no tracker request a page's question would not.
 */

export interface ServerAskDeps {
  /** Whether a module is registered here (the last sweep's `callers`). */
  known(module: string): boolean
  /** The module's registered origin, or null. */
  originOf(module: string): Promise<string | null>
  /** Whether its manifest, as the last sweep read it, asks for the capability. */
  may(module: string, capability: string): boolean
  /** A call answered though undeclared (`ANSWERED_UNDECLARED`), for one line in the log. */
  undeclared?(module: string, method: string, capability: string): void
  /** The project this host holds at that folder, or null. Never the unpicked home fallback. */
  projectAt(folder: string): string | null
  /** The page's answer to the call, in that project — or in none, for a question about this computer (`traffic.*`, 2.20.0). */
  answer(module: string, method: string, params: unknown, root: string | null): Answer
  /**
   * `messages.send` and `messages.read` (protocol 2.41.0), answered for the session the call's token
   * names (`messageRoutes.ts`): the project is the token's, so these name none. Absent: refused.
   */
  messages?(module: string, method: string, params: unknown): Promise<MessageAsked>
  /** Injected by tests. */
  fetch?: typeof fetch
}

/** How long a module gets to say whether it minted a pass. */
const VOUCH_MS = LIMITS.HOST_ASK_MS
const BODY_MAX = 64 * 1024

const reply = (body: ServerAskResult | { ok: false; error: string }, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

const refused = (refused: ServerAskRefusal, error: string, reason: 'failed' | 'unknown-module' = 'failed'): Response =>
  reply({ ok: false, reason, error: error.slice(0, LIMITS.REASON), refused })

/** The sentences a module's author reads. */
export const SERVER_ASK_SAYS = {
  module: 'This host has no module registered under that id, so it answers nothing for it.',
  pass:
    'The module at its registered address did not vouch for this question’s pass: it is not the process serving there, or it runs a protocol before 2.19.0, which has no pass door. Nothing was answered.',
  project: 'This host holds no project at that folder, so there is no reading to answer from.',
} as const

export function serverAskDesk(deps: ServerAskDeps) {
  /** Whether the module at its registered origin minted this pass. Fails closed. */
  async function vouched(module: string, pass: string): Promise<boolean> {
    const origin = await deps.originOf(module).catch(() => null)
    if (!origin) return false
    const control = new AbortController()
    const timer = setTimeout(() => control.abort(), VOUCH_MS)
    try {
      const response = await (deps.fetch ?? fetch)(`${origin}${SERVER_PASS_PATH}?pass=${encodeURIComponent(pass)}`, { signal: control.signal })
      if (!response.ok) return false
      const said = serverPassResult.safeParse(await response.json())
      return said.success && said.data.minted
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  async function route(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname !== SERVER_ASK_PATH) return null
    if (request.method !== 'POST') return reply({ ok: false, error: `${SERVER_ASK_PATH} takes POST.` }, 405)
    const text = await request.text().catch(() => '')
    if (!text || text.length > BODY_MAX) return reply({ ok: false, error: 'A question is a JSON object: module, pass, project, method, params.' }, 400)
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return reply({ ok: false, error: 'A question is a JSON object: module, pass, project, method, params.' }, 400)
    }
    /* A method this host does not know at all is newer than it (protocol
       2.22.0): a call it is too old for, not a malformed question. One it
       knows and answers only to a page (`parts.set`) stays a 400 below. Said
       before the pass is checked: it names nothing about the module or a
       project. */
    const named = typeof raw === 'object' && raw !== null ? (raw as { method?: unknown }).method : undefined
    if (typeof named === 'string' && named.length <= LIMITS.METHOD && !Object.hasOwn(METHODS, named) && !(SERVER_METHODS as readonly string[]).includes(named)) {
      return reply({
        ok: false,
        reason: 'unknown-method',
        declined: 'host-too-old',
        error: 'This host’s server does not answer that method. A newer Kehikot may.',
      })
    }
    const asked = serverAskSchema.safeParse(raw)
    if (!asked.success) {
      const issue = asked.error.issues[0]
      return reply({ ok: false, error: `Not a question this host takes: ${issue?.path.join('.') || 'body'} — ${issue?.message ?? 'malformed'}.` }, 400)
    }
    const { module, pass, project, method, params } = asked.data
    /* Who asked, for the record of traffic; reading and noting traffic is not itself recorded (a loop). */
    const plumbing = method.startsWith('traffic.')
    tag(request, { by: module, via: 'server', reason: method, ...(plumbing ? { skip: true } : {}) })

    if (!deps.known(module)) return refused('module', SERVER_ASK_SAYS.module, 'unknown-module')
    /* First the pass: nothing about a module's grants or a project is said to a program that is not it. */
    if (!(await (plumbing ? untraced(() => vouched(module, pass)) : vouched(module, pass)))) return refused('pass', SERVER_ASK_SAYS.pass)
    const held = hold(method, (capability) => deps.may(module, capability))
    if (held.held) return refused('grant', held.why)
    if ('undeclared' in held) deps.undeclared?.(module, method, held.undeclared)
    /* Messages (protocol 2.41.0): the session, and so the project, is the one the token names. A
       token this host does not hold is refused as a project it does not hold: another host may. */
    if (method === 'messages.send' || method === 'messages.read') {
      if (!deps.messages) return reply({ ok: false, reason: 'failed', error: 'This host keeps no messages.' })
      const said = await deps.messages(module, method, params)
      if (said.ok) return reply({ ok: true, data: said.data })
      if ('refused' in said) return refused('project', said.error)
      return reply({ ok: false, reason: 'failed', error: said.error.slice(0, LIMITS.REASON) })
    }
    /* A question about this computer names no project (protocol 2.20.0); the schema holds the rest to one. */
    const root = needsProject(method) ? deps.projectAt(project ?? '') : null
    if (needsProject(method) && !root) return refused('project', SERVER_ASK_SAYS.project)

    const said = deps.answer(module, method, params, root)
    return reply(said.ok ? { ok: true, data: said.data } : { ok: false, reason: said.reason, error: said.error.slice(0, LIMITS.REASON) })
  }

  return { route }
}
