import { describe, expect, test } from 'bun:test'
import { SERVER_ASK_PATH, SERVER_PASS_PATH, AGENT_TASKS } from 'kehikot-module-protocol'
import { mintServerPass, serverPassReply } from 'kehikot-module-protocol/serve'

import { ACCEPTED_KEPT_MS, AcceptedTasks, reportSaid, startAgentSession } from '../server/agentSession.ts'
import { serverAskDesk } from '../server/serverAsk.ts'
import { handedSaid } from '../src/host/agentHandoff.ts'

/**
 * Protocol 2.99.0: an agent module ACCEPTS a task at once (`started` + `pending`) and boots its program
 * after. The host treats the acceptance as success ("is starting it in its container"), keeps the task,
 * and puts a later failure the module reports (`tasks.report`) in the Inbox in words. Before, every
 * module booted first and the host's wait ran out: "did not answer within 8 s", while the conversation
 * started anyway.
 */

const MODULE = 'kehikot.agent'
const ORIGIN = 'http://127.0.0.1:4711'
const provider = { module: MODULE, name: 'Agent', placed: null, descriptor: { name: 'Agent', program: 'Agent CLI', start: '/api/tasks/start', view: '/app?session={session}' } }
const providers = (service: string) => (service === AGENT_TASKS ? [provider] : [])
const answering = (body: unknown, delayMs = 0) =>
  (async (_url: string, init?: RequestInit) => {
    await new Promise((done, fail) => {
      const timer = setTimeout(done, delayMs)
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        fail(new Error('aborted'))
      })
    })
    return Response.json(body)
  }) as unknown as typeof fetch

describe('an acceptance is a start', () => {
  test('pending: success, said as starting, and kept for its report', async () => {
    const accepted = new AcceptedTasks()
    const got = await startAgentSession({ providers, originOf: async () => ORIGIN, accepted, fetch: answering({ outcome: 'started', session: 'h-1', pending: true }) }, { module: MODULE, root: '/p', prompt: 'p', title: 'Place #12 in a space' })
    expect(got).toEqual({ ok: true, module: MODULE, name: 'Agent', session: 'h-1', pending: true })
    expect(accepted.take(MODULE, 'h-1')).toMatchObject({ name: 'Agent', root: '/p', title: 'Place #12 in a space' })
    expect(handedSaid('Agent', true)).toBe('Agent is starting it in its container.')
    expect(handedSaid('Agent')).toBe('Agent is on it in its container.')
  })

  test('a module built before 2.99.0 still answers once running: started, not kept', async () => {
    const accepted = new AcceptedTasks()
    const got = await startAgentSession({ providers, originOf: async () => ORIGIN, accepted, fetch: answering({ outcome: 'started', session: 's-1' }) }, { module: MODULE, root: '/p', prompt: 'p', title: 't' })
    expect(got).toEqual({ ok: true, module: MODULE, name: 'Agent', session: 's-1', pending: false })
    expect(accepted.take(MODULE, 's-1')).toBeNull()
  })

  test('one that boots before answering still runs out the wait, in words', async () => {
    const got = await startAgentSession({ providers, originOf: async () => ORIGIN, fetch: answering({ outcome: 'started', session: 's' }, 300) }, { module: MODULE, root: '/p', prompt: 'p', title: 't', ms: 100 })
    expect(got).toEqual({ ok: false, why: 'Agent didn’t start a session: it did not answer within 0 s.' })
  })
})

describe('what became of an accepted task', () => {
  test('a failure is said naming the module and the task; a start says nothing', () => {
    const task = { name: 'Agent', title: 'Place #12 in a space' }
    expect(reportSaid(task, { session: 'h', outcome: 'failed', conversation: null, why: 'Agent CLI is not signed in.' })).toBe('Agent couldn’t start “Place #12 in a space”: Agent CLI is not signed in.')
    expect(reportSaid(task, { session: 'h', outcome: 'failed', conversation: null, why: '' })).toBe('Agent couldn’t start “Place #12 in a space”: it gave no reason.')
    expect(reportSaid(task, { session: 'h', outcome: 'started', conversation: 'c', why: '' })).toBeNull()
  })

  test('taken once, only from the module it was handed to, and forgotten after an hour', () => {
    let now = 0
    const accepted = new AcceptedTasks(() => now)
    accepted.accepted({ module: MODULE, name: 'Agent', session: 'h', root: '/p', title: 't' })
    expect(accepted.take('kehikot.other', 'h')).toBeNull()
    expect(accepted.take(MODULE, 'h')).not.toBeNull()
    expect(accepted.take(MODULE, 'h')).toBeNull()
    accepted.accepted({ module: MODULE, name: 'Agent', session: 'h2', root: '/p', title: 't' })
    now = ACCEPTED_KEPT_MS + 1
    expect(accepted.take(MODULE, 'h2')).toBeNull()
  })
})

describe('the module’s server reports, and a manifest read late is read again', () => {
  const desk = (deps: { may: (module: string, capability: string) => boolean; reread?: (module: string) => Promise<boolean>; told: unknown[] }) =>
    serverAskDesk({
      known: (id) => id === MODULE,
      originOf: async () => ORIGIN,
      may: deps.may,
      reread: deps.reread,
      projectAt: () => null,
      answer: () => ({ ok: true, data: { projects: [] } }) as never,
      tasks: (module, report) => {
        deps.told.push({ module, report })
        return { outcome: 'told', why: '' }
      },
      fetch: (async (input: string | URL) => {
        const url = new URL(String(input))
        const said = serverPassReply('GET', url.pathname, url.searchParams)!
        return Response.json(said.body, { status: said.status })
      }) as unknown as typeof fetch,
    })
  const asked = (method: string, params: unknown) =>
    new Request(`http://127.0.0.1:4180${SERVER_ASK_PATH}`, { method: 'POST', body: JSON.stringify({ module: MODULE, pass: mintServerPass(), method, params }) })

  test('tasks.report reaches the host under activity:report', async () => {
    const told: unknown[] = []
    const route = desk({ may: (_m, capability) => capability === 'activity:report', told }).route
    const got = await route(asked('tasks.report', { session: 'h', outcome: 'failed', why: 'no' }), new URL(`http://127.0.0.1:4180${SERVER_ASK_PATH}`))
    expect(await got!.json()).toEqual({ ok: true, data: { outcome: 'told', why: '' } })
    expect(told).toEqual([{ module: MODULE, report: { session: 'h', outcome: 'failed', conversation: null, why: 'no' } }])
    expect(SERVER_PASS_PATH).toBeTruthy()
  })

  test('a module that asks before its manifest was read is read again, then answered', async () => {
    let declares: string[] = []
    const route = desk({
      may: (_m, capability) => declares.includes(capability),
      reread: async () => {
        declares = ['agents:message']
        return true
      },
      told: [],
    }).route
    const got = (await (await route(asked('projects.mine', {}), new URL(`http://127.0.0.1:4180${SERVER_ASK_PATH}`)))!.json()) as { ok: boolean }
    expect(got.ok).toBe(true)
  })

  test('without a reread, the refusal stands', async () => {
    const route = desk({ may: () => false, told: [] }).route
    const got = (await (await route(asked('projects.mine', {}), new URL(`http://127.0.0.1:4180${SERVER_ASK_PATH}`)))!.json()) as { ok: boolean; refused?: string }
    expect(got).toMatchObject({ ok: false, refused: 'grant' })
  })
})
