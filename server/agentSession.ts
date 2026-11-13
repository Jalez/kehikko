import { AGENT_TASKS, LIMITS, agentTaskStartResult, providerOf, HOST_CALLER, SERVICE_CALLER_HEADER, SERVICE_PASS_HEADER, type ServiceProvider, type TasksReportParams } from 'kehikot-module-protocol'
import { mintServerPass } from 'kehikot-module-protocol/serve'

/**
 * Hand something to an agent: start a NEW session in an agent module with a short prompt, as if the
 * person pressed "New session" in its container and typed it. The one host step every "hand this to
 * an agent" action takes (adopting a tracker item is the first, `adoption.ts`); the page puts the
 * module's container on the kehikko and in view (`src/host/agentHandoff.ts`).
 *
 * One call to the module's `agent.tasks` start (protocol 2.88.0), held to `AGENT_START_MS`, answered
 * with the session or why not — in the module's own words where it gave some, naming it always. The
 * prompt is short: the agent finds what it needs with the tools it already has. Nothing here scans,
 * builds a brief, polls or runs in the background.
 *
 * ## Accepted, then started (protocol 2.99.0)
 *
 * A module answers `start` at once — `started` with `pending: true`, an acceptance — and boots its
 * program afterwards: before 2.99.0 every module booted first, a program slow to boot ran past this
 * host's wait, and the person was told the agent did not answer while the conversation started
 * anyway. An acceptance is success here (`pending` in the answer, which the page says as "is starting
 * it"). The task is kept (`AcceptedTasks`) so that what the module later reports with `tasks.report`
 * is answered: a failure goes in the person's Inbox in words, naming the module and the task. The wait
 * stays for a module built before 2.99.0, which still answers only once its conversation runs.
 */

export interface AgentSessionDeps {
  /** The modules providing a service now, for a project folder. */
  providers(service: string, root: string): ServiceProvider[]
  /** A module's registered origin. */
  originOf(module: string): Promise<string | null>
  /** Where an accepted task is kept until its module reports on it (protocol 2.99.0). */
  accepted?: AcceptedTasks
  fetch?: typeof fetch
}

/** How long an agent module has to say it started the session. Under the page's own wait (10 s). */
export const AGENT_START_MS = 8000

/** The longest prompt handed over: a few lines, never a dump. */
export const AGENT_PROMPT_MOST = 2000

export type AgentStarted = { ok: true; module: string; name: string; session: string; pending: boolean } | { ok: false; why: string; noAgent?: true }

/** A task a module accepted (protocol 2.99.0), kept until it reports what became of it. */
export interface AcceptedTask {
  module: string
  /** The module's registered name, as the person reads it. */
  name: string
  session: string
  /** The project folder it was started in. */
  root: string
  title: string
  at: number
}

/** How long an accepted task's report is waited for: a program that has not booted in this long has failed anyway. */
export const ACCEPTED_KEPT_MS = 60 * 60 * 1000

/** What became of an accepted task, as the host says it to the person, or null when there is nothing to say. */
export function reportSaid(task: Pick<AcceptedTask, 'name' | 'title'>, report: TasksReportParams): string | null {
  if (report.outcome !== 'failed') return null
  const why = report.why.trim().replace(/\.$/, '') || 'it gave no reason'
  return `${task.name} couldn’t start “${task.title}”: ${why}.`.slice(0, LIMITS.REASON)
}

/**
 * The tasks agent modules accepted and have not yet said became of (protocol 2.99.0), in memory: a
 * report is about a start minutes ago, and a restart of the host ends the wait for one. A report is
 * taken once, from the module the task was handed to, and only for a task this host handed it.
 */
export class AcceptedTasks {
  readonly #tasks = new Map<string, AcceptedTask>()
  constructor(private readonly clock: () => number = Date.now) {}

  #sweep(): void {
    const now = this.clock()
    for (const [key, task] of this.#tasks) if (now - task.at > ACCEPTED_KEPT_MS) this.#tasks.delete(key)
    while (this.#tasks.size > 256) this.#tasks.delete(this.#tasks.keys().next().value!)
  }

  accepted(task: Omit<AcceptedTask, 'at'>): void {
    this.#sweep()
    this.#tasks.set(`${task.module}\n${task.session}`, { ...task, at: this.clock() })
  }

  /** The task a module reports on, taken out; null for one this host did not hand it, or forgot. */
  take(module: string, session: string): AcceptedTask | null {
    this.#sweep()
    const key = `${module}\n${session}`
    const task = this.#tasks.get(key) ?? null
    this.#tasks.delete(key)
    return task
  }
}

/** A module refused a service call: its `error` or `why`, when it gave one. */
export class ModuleRefused extends Error {}

/**
 * POST to a module's service route as this host, vouched (`SERVICE_PASS_HEADER`), held to `ms`.
 * Throws `ModuleRefused` with the module's words, or with what happened, in a sentence.
 */
export async function callModule(deps: Pick<AgentSessionDeps, 'originOf' | 'fetch'>, module: string, path: string, body: unknown, ms: number): Promise<unknown> {
  const origin = await deps.originOf(module)
  if (!origin) throw new ModuleRefused(`${module} is not registered here`)
  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), ms)
  try {
    const response = await (deps.fetch ?? fetch)(`${new URL(origin).origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', [SERVICE_CALLER_HEADER]: HOST_CALLER, [SERVICE_PASS_HEADER]: mintServerPass() },
      body: JSON.stringify(body),
      signal: control.signal,
    })
    const got = (await response.json().catch(() => null)) as unknown
    if (!response.ok) {
      const said = got && typeof got === 'object' ? ((got as { error?: unknown; why?: unknown }).error ?? (got as { why?: unknown }).why) : null
      throw new ModuleRefused(typeof said === 'string' && said ? said.slice(0, LIMITS.REASON) : `it answered HTTP ${response.status}`)
    }
    return got
  } catch (error) {
    if (control.signal.aborted) throw new ModuleRefused(`it did not answer within ${Math.round(ms / 1000)} s`)
    if (error instanceof ModuleRefused) throw error
    throw new ModuleRefused(`it could not be reached (${error instanceof Error ? error.message : String(error)})`)
  } finally {
    clearTimeout(timer)
  }
}

/** Start a new session in `module` with `prompt`, in the project at `root`. Every failure is said in words, naming the module. */
export async function startAgentSession(
  deps: AgentSessionDeps,
  ask: { module: string; root: string; prompt: string; title: string; ms?: number },
): Promise<AgentStarted> {
  const named = deps.providers(AGENT_TASKS, ask.root).filter((one) => one.module === ask.module)
  const provider = providerOf(AGENT_TASKS, named)
  if (!provider) return { ok: false, why: `${named[0]?.name ?? ask.module} cannot start a session for Kehikot: it is not running here, or its version is too old to take one.`, noAgent: true }
  const didNot = (why: string) => ({ ok: false as const, why: `${provider.name} didn’t start a session: ${why.replace(/\.$/, '')}.`.slice(0, LIMITS.REASON) })
  const prompt = ask.prompt.slice(0, AGENT_PROMPT_MOST)
  try {
    const got = agentTaskStartResult.safeParse(
      await callModule(deps, provider.module, provider.descriptor.start, { project: ask.root, brief: prompt, place: null, title: ask.title.slice(0, LIMITS.TITLE) }, ask.ms ?? AGENT_START_MS),
    )
    if (!got.success) return didNot('it answered in a shape Kehikot does not read')
    if (got.data.outcome !== 'started' || !got.data.session) return didNot(got.data.why || 'it gave no reason')
    /* Accepted and still starting (2.99.0): kept, so that what the module reports of it is answered. */
    if (got.data.pending) deps.accepted?.accepted({ module: provider.module, name: provider.name, session: got.data.session, root: ask.root, title: ask.title.slice(0, LIMITS.TITLE) })
    return { ok: true, module: provider.module, name: provider.name, session: got.data.session, pending: got.data.pending }
  } catch (error) {
    return didNot(error instanceof Error ? error.message : String(error))
  }
}
