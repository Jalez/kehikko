import type { Database } from 'bun:sqlite'
import {
  AGENT_TASKS,
  AGENT_TASK_BRIEF_MAX,
  CONVERSATION_MATCHES,
  epicPartsOf,
  CONVERSATIONS_FINDER,
  HOST_CALLER,
  LIMITS,
  SERVICE_CALLER_HEADER,
  SERVICE_PASS_HEADER,
  agentTaskStartResult,
  agentTaskView,
  candidatesIn,
  confidentMatch,
  conversationsBringResult,
  providerOf,
  serviceDescriptor,
  type AdoptionConversation,
  type ConversationPlace,
  type InboxAdoptResult,
  type InboxAdoptionResult,
  type ServiceProvider,
} from 'kehikot-module-protocol'
import { mintServerPass } from 'kehikot-module-protocol/serve'

import {
  ADOPT_INSTRUCTION,
  adoptedSaid,
  adoptionBrief,
  elsewhere,
  placeSaid,
  suggestEpic,
  taskAgentFor,
  toBring,
  untrackedSaid,
  type BroughtOne,
  type EpicForAdoption,
  type RowForAdoption,
  type Suggestion,
} from '../src/host/adoption.ts'
import { spaceTree } from './spaces.ts'
import { TRACKER_NOTICES_MODULE, type Seen } from '../src/host/trackerNotices.ts'

/**
 * Adopting a tracker item no epic names, and the conversation that worked on it (protocol 2.88.0).
 * The rules are `src/host/adoption.ts`; this reads and writes.
 *
 * ## The acts are the person's
 *
 * Every write here is reached from the host's own page only (`PAGE_ONLY` in `guard.ts`), and the page
 * takes it only on the person's fresh press in the frame that asked (`actNeedsPress`). No MCP tool
 * reaches `adopt`, `untrack` or `undo`: an agent can only PROPOSE (`propose`, the door's
 * `propose_adoption`), which fills the dialog and adopts nothing.
 *
 * ## One writer for each thing it touches
 *
 * The ref goes into the epic through `editEpicRef` (the one writer of an epic's adopted refs); what
 * is not tracked goes through `TrackerNotices.track`; a conversation's place is written by the agent
 * module that runs it, asked through `conversations.finder`'s `bring` — a compare-and-set, so nothing
 * filed under another place is moved, and an Undo takes back only what is still as it was left.
 *
 * ## Kept
 *
 * In `frame.sqlite`, per project: the last adopt or untrack of each item (`inbox_adoptions`), what it
 * said and what it brought along, so the item can say it and Undo can take it back. Proposals are in
 * memory: they are a dialog's, and die with it.
 */

export interface AdoptionDeps {
  db: Database
  /** The tracker notices' record: the item, and "Don't track this". */
  notices: {
    seen(project: number, id: string): Seen | null
    track(project: number, id: string, track: boolean): { rev: number } | null
  }
  /** The folder of a project. */
  pathOf(project: number): string | null
  /** The project's epics, with their parts, refs and the repository their file names. */
  epics(root: string): (EpicForAdoption & { parts: { id: string; name: string }[] })[]
  /** The tracker reading's rows for the project now. */
  rows(root: string): readonly RowForAdoption[]
  /** Write or take back a ref (`editEpicRef`). */
  editRef(root: string, epic: string, ref: string, parts: readonly string[], add: boolean): { outcome: 'changed' | 'unchanged' | 'declined'; why: string }
  /** The modules providing a service now. */
  providers(service: string, root: string): ServiceProvider[]
  /** A module's registered origin. */
  originOf(module: string): Promise<string | null>
  /**
   * The agent modules placed on a kehikko of the project, in order, and its chosen primary (Kehikko
   * settings; null when none). Which of them does a task is `taskAgentFor`.
   */
  agentsOn(project: number, kehikko: string): { agents: string[]; primary: string | null; names?: Readonly<Record<string, string>> }
  /** An epic named one of the project's refs, or stopped: notices again, pages told. */
  changed(project: number): void
  fetch?: typeof fetch
  clock?: () => number
  /** For tests: the time limits (`ADOPTION_LIMITS`). */
  limits?: Partial<typeof ADOPTION_LIMITS>
}

/**
 * How long anything here may take. The page's own calls carry no work that waits on a module longer
 * than `waitMs`: a module's page that asks through the host gives up after 12 s (`ANSWER_WITHIN_MS`),
 * and the host's server closes a GET it has not answered in 30 s (`idleTimeout`). So:
 *
 *  - `findMs`: each finder is asked in parallel with the others, and one that has not answered by then
 *    finds nothing.
 *  - `waitMs`: how long a read waits for the finders before answering with what came in so far
 *    (`finding: true`); the scan goes on, and the next read has it.
 *  - `freshMs`: how long a scan's answer is used as it is; an older one is answered while a new one runs.
 *  - `startMs`: how long an agent module has to say it started a task. The page is never kept waiting
 *    for it: the start runs in the background and the page reads how it went (`taskState`).
 */
export const ADOPTION_LIMITS = { findMs: 6000, waitMs: 2500, freshMs: 20_000, startMs: 25_000 }

type Candidate = AdoptionConversation & { place: ConversationPlace | null }

/** One scan of the finders for an item: what has come in so far, and whether every finder has answered. */
interface Scan {
  at: number
  done: boolean
  out: Candidate[]
  ended: Promise<void>
}

/** How the start of an adoption's task is going, as the page reads it. */
export type TaskState =
  | { state: 'starting'; module: string; name: string }
  | { state: 'started'; module: string; name: string; session: string; view: string }
  | { state: 'failed'; why: string; noAgent?: true }

/** One conversation brought along, kept for Undo: who runs it and where it was. */
interface Brought {
  module: string
  program: string
  session: string
  title: string
  outcome: BroughtOne['outcome']
  to: ConversationPlace
}

interface Record_ {
  kind: 'adopt' | 'untrack'
  ref: string
  epic: string | null
  parts: string[]
  brought: Brought[]
  said: string
  undone: boolean
}

export interface Proposal {
  epic: string
  parts: string[]
  conversations: string[]
  why: string
  at: number
}

const CALL_MS = 8000

/** What a module said when it refused a service call: its `error` or `why`, when it gave one. */
class Refused extends Error {}

export const ADOPTION_SAYS = {
  noItem: 'That names no tracker item Kehikot holds in this project.',
  noProject: 'That names no project of yours.',
  inEpic: 'A space names it already.',
  noAgent: 'No agent module on this kehikko can find where it belongs. Add one to let it find the right space, or choose a space yourself.',
  nothingToUndo: 'There is nothing to undo for that item.',
} as const

export class Adoption {
  readonly #proposals = new Map<string, Proposal>()
  readonly #scans = new Map<string, Scan>()
  readonly #tasks = new Map<string, TaskState & { at: number }>()
  constructor(private readonly deps: AdoptionDeps) {
    deps.db.exec(`
      create table if not exists inbox_adoptions (
        project integer not null references projects(id) on delete cascade,
        id      text    not null,
        data    text    not null,
        at      integer not null,
        primary key (project, id)
      );
    `)
  }

  #now(): number {
    return (this.deps.clock ?? Date.now)()
  }

  #record(project: number, id: string): Record_ | null {
    const row = this.deps.db.query<{ data: string }, [number, string]>('select data from inbox_adoptions where project = ? and id = ?').get(project, id)
    if (!row) return null
    try {
      return JSON.parse(row.data) as Record_
    } catch {
      return null
    }
  }

  #keep(project: number, id: string, record: Record_): void {
    this.deps.db
      .query('insert into inbox_adoptions (project, id, data, at) values (?, ?, ?, ?) on conflict (project, id) do update set data = excluded.data, at = excluded.at')
      .run(project, id, JSON.stringify(record), this.#now())
  }

  /** What the last act on each item said, and whether it can be undone: the items' `after`. */
  afters(project: number): { module: string; id: string; said: string; undo: boolean }[] {
    return this.deps.db
      .query<{ id: string; data: string }, [number]>('select id, data from inbox_adoptions where project = ? order by at desc limit 500')
      .all(project)
      .flatMap((row) => {
        try {
          const record = JSON.parse(row.data) as Record_
          return [{ module: TRACKER_NOTICES_MODULE, id: row.id, said: record.said, undo: !record.undone }]
        } catch {
          return []
        }
      })
  }

  /* ---- finding ---- */

  #limit(name: keyof typeof ADOPTION_LIMITS): number {
    return this.deps.limits?.[name] ?? ADOPTION_LIMITS[name]
  }

  async #post(module: string, path: string, body: unknown, ms = CALL_MS): Promise<unknown> {
    const origin = await this.deps.originOf(module)
    if (!origin) throw new Error(`${module} is not registered here.`)
    const control = new AbortController()
    const timer = setTimeout(() => control.abort(), ms)
    try {
      const response = await (this.deps.fetch ?? fetch)(`${new URL(origin).origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', [SERVICE_CALLER_HEADER]: HOST_CALLER, [SERVICE_PASS_HEADER]: mintServerPass() },
        body: JSON.stringify(body),
        signal: control.signal,
      })
      const got = (await response.json().catch(() => null)) as unknown
      if (!response.ok) {
        const said = got && typeof got === 'object' ? ((got as { error?: unknown; why?: unknown }).error ?? (got as { why?: unknown }).why) : null
        throw new Refused(typeof said === 'string' && said ? said.slice(0, LIMITS.REASON) : `it answered HTTP ${response.status}`)
      }
      return got
    } catch (error) {
      if (control.signal.aborted) throw new Refused(`it did not answer within ${Math.round(ms / 1000)} s`)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Every finder's candidates for an item, each with who runs it; a provider that fails or is slower
   * than `findMs` says nothing. The finders are asked IN PARALLEL, once per item for `freshMs`, and
   * this waits at most `wait` ms: `finding` says the scan has not ended, and what came in so far is
   * answered (or the last scan's answer, while a new one runs).
   */
  async #candidates(root: string, seen: Seen, wait: number): Promise<{ found: Candidate[]; finding: boolean }> {
    const key = `${root}\u0000${seen.ref}\u0000${seen.link?.url ?? ''}\u0000${seen.link?.branch ?? ''}`
    const had = this.#scans.get(key)
    const now = this.#now()
    let scan = had
    if (!had || (had.done && now - had.at > this.#limit('freshMs'))) {
      scan = this.#scan(root, seen)
      this.#scans.set(key, scan)
      if (this.#scans.size > 200) this.#scans.delete(this.#scans.keys().next().value!)
    }
    const current = scan!
    if (!current.done && wait > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([current.ended, new Promise<void>((done) => (timer = setTimeout(done, wait)))])
      clearTimeout(timer)
    }
    if (current.done) return { found: current.out, finding: false }
    /* Still finding: the last whole answer when there was one, else what came in so far. */
    return { found: had && had !== current && had.done ? had.out : ranked(current.out), finding: true }
  }

  #scan(root: string, seen: Seen): Scan {
    const link = seen.link
    const refs = [...new Set([seen.ref, ...(link ? [`${link.host}/${link.repo}${seen.ref.replace(/^[^#!]*/, '')}`] : [])])].slice(0, 8)
    const scan: Scan = { at: this.#now(), done: false, out: [], ended: Promise.resolve() }
    const asks = this.deps.providers(CONVERSATIONS_FINDER, root).map(async (provider) => {
      const finder = serviceDescriptor(CONVERSATIONS_FINDER, provider.descriptor)
      if (!finder) return
      try {
        const body = await this.#post(
          provider.module,
          finder.find,
          {
            project: root,
            refs,
            ...(link?.url ? { url: link.url } : {}),
            ...(link?.branch ? { branch: link.branch } : {}),
            ...(link?.repo ? { repo: link.repo } : {}),
          },
          this.#limit('findMs'),
        )
        for (const one of candidatesIn(body)) {
          scan.out.push({
            module: provider.module,
            program: finder.program,
            session: one.session,
            title: one.title,
            folder: one.folder,
            lastActive: one.lastActive,
            match: one.match,
            reason: one.reason,
            placed: null,
            comes: false,
            place: one.place,
          })
        }
      } catch {
        /* A finder that does not answer, or not in time, finds nothing. */
      }
    })
    scan.ended = Promise.allSettled(asks).then(() => {
      scan.out = ranked(scan.out)
      scan.done = true
    })
    return scan
  }

  /**
   * `inbox.adoption`: what the page needs to offer adopting one item. The candidates are asked of the
   * finders now; only titles and reasons go to the page.
   */
  /**
   * Which agent does the task on the kehikko the person is on (`taskAgentFor`): its primary, its only
   * agent module, or the one that can; `choose` when two or more can and none is primary. Nothing at no
   * kehikko.
   */
  taskAgent(
    project: number,
    root: string,
    kehikko: string | null,
  ): { agent: ServiceProvider | null; choose: ServiceProvider[]; update: { module: string; name: string }[] } | null {
    if (!kehikko) return null
    const providers = this.deps.providers(AGENT_TASKS, root)
    const on = this.deps.agentsOn(project, kehikko)
    const pick = taskAgentFor(on.agents, providers.map((one) => one.module), on.primary)
    const named = (module: string) => providers.find((one) => one.module === module) ?? null
    /* No agent there can: the ones that might after an update (an older version, before `agent.tasks`). */
    const update = !pick.agent && !pick.choose.length ? on.agents.map((module) => ({ module, name: on.names?.[module] ?? module })) : []
    return { agent: pick.agent ? named(pick.agent) : null, choose: pick.choose.flatMap((one) => named(one) ?? []), update }
  }

  async adoption(
    project: number,
    module: string,
    id: string,
    kehikko: string | null = null,
    wait: number = this.#limit('waitMs'),
  ): Promise<InboxAdoptionResult & { finding?: boolean }> {
    const empty = (outcome: 'no-such-item' | 'declined', why: string): InboxAdoptionResult => ({
      outcome,
      why,
      item: null,
      epics: [],
      suggested: null,
      conversations: [],
      agent: null,
      proposal: null,
    })
    const root = this.deps.pathOf(project)
    if (!root) return empty('declined', ADOPTION_SAYS.noProject)
    const seen = module === TRACKER_NOTICES_MODULE ? this.deps.notices.seen(project, id) : null
    if (!seen) return empty('no-such-item', ADOPTION_SAYS.noItem)
    const epics = this.deps.epics(root)
    const titleOf = (slug: string) => epics.find((one) => one.epic === slug)?.title ?? null
    const suggested = this.#suggest(root, seen, epics)
    const { found, finding } = await this.#candidates(root, seen, wait)
    const comes = new Set(toBring(found).map((one) => `${one.module}|${one.session}`))
    const picked = this.taskAgent(project, root, kehikko)
    const agent = picked?.agent ?? null
    const proposal = this.#proposals.get(`${project}|${id}`) ?? null
    return {
      outcome: 'ok',
      why: '',
      item: {
        ref: seen.ref,
        title: seen.title.slice(0, LIMITS.TITLE),
        url: seen.link?.url ?? '',
        repo: seen.link?.repo ?? '',
        host: seen.link?.host ?? '',
        ...(seen.author ? { author: seen.author.slice(0, LIMITS.TITLE) } : {}),
        ...(seen.link?.branch ? { branch: seen.link.branch } : {}),
      },
      epics: epics.slice(0, 200).map((one) => ({ epic: one.epic, title: one.title.slice(0, LIMITS.TITLE), parts: one.parts.slice(0, LIMITS.PARTS), refs: one.refs.slice(0, 200) })),
      /* The whole tree, so the dialog can adopt into a space at any depth (protocol 2.89.0). */
      spaces: spaceTree(root),
      suggested,
      conversations: found.map(({ place, ...one }) => ({ ...one, placed: placeSaid(place, titleOf), comes: comes.has(`${one.module}|${one.session}`) })),
      agent: agent ? { module: agent.module, name: agent.name } : null,
      /* With no agent: the ones the person would choose between, or none there can (protocol 2.91.0). */
      ...(picked && !agent ? { taskAgents: picked.choose.slice(0, 16).map((one) => ({ module: one.module, name: one.name.slice(0, LIMITS.TITLE) })) } : {}),
      ...(picked?.update.length ? { agentsToUpdate: picked.update.slice(0, 16).map((one) => ({ module: one.module, name: one.name.slice(0, LIMITS.TITLE) })) } : {}),
      proposal: proposal ? { epic: proposal.epic, parts: proposal.parts, conversations: proposal.conversations, why: proposal.why } : null,
      /* Not the protocol's: the page's own route reads it, and re-reads until the finders have all answered. */
      ...(finding ? { finding: true } : {}),
    }
  }

  #suggest(root: string, seen: Seen, epics: readonly EpicForAdoption[]): Suggestion | null {
    if (!seen.link) return null
    return suggestEpic({ ref: seen.ref, host: seen.link.host, repo: seen.link.repo, ...(seen.link.branch ? { branch: seen.link.branch } : {}) }, epics, this.deps.rows(root))
  }

  /* ---- the person's acts ---- */

  /**
   * `inbox.adopt`: the ref into the epic and parts, then every conversation that confidently worked on
   * it and is filed under no place brought there by the module that runs it. `task`: a conversation an
   * agent for Kehikot's own tasks ran for this adoption, filed under the epic too.
   */
  async adopt(
    project: number,
    module: string,
    id: string,
    epic: string,
    parts: readonly string[] | string[],
    kehikko: string | null,
    task?: { module: string; session: string } | null,
    /** Sessions the person confirmed bringing (an agent's proposal), confident or not; never one filed elsewhere. */
    also: readonly string[] = [],
    /**
     * The space to adopt into, at any depth (protocol 2.89.0), by its path of ids; its first id is `epic`.
     * The ref is filed where refs are kept — the top-level space and the space under it that holds the
     * chosen one (`epicPartsOf`) — and the conversations brought are filed under the space itself.
     */
    space: readonly string[] | null = null,
  ): Promise<InboxAdoptResult> {
    const declined = (why: string, outcome: 'declined' | 'no-such-item' = 'declined'): InboxAdoptResult => ({ outcome, said: '', brought: [], why })
    const root = this.deps.pathOf(project)
    if (!root) return declined(ADOPTION_SAYS.noProject)
    const seen = module === TRACKER_NOTICES_MODULE ? this.deps.notices.seen(project, id) : null
    if (!seen) return declined(ADOPTION_SAYS.noItem, 'no-such-item')
    const epics = this.deps.epics(root)
    const target = epics.find((one) => one.epic === epic)
    if (!target) return declined(`This project has no space ${epic}.`)
    const into = space && space.length && space[0] === epic ? [...space] : null
    if (into) parts = epicPartsOf(into).parts
    const written = this.deps.editRef(root, epic, seen.ref, parts, true)
    if (written.outcome === 'declined') return declined(written.why)

    const to: ConversationPlace = { epic, parts: [...parts], kehikko, ...(into && into.length > 2 ? { space: into } : {}) }
    const { found } = await this.#candidates(root, seen, this.#limit('findMs') + 500)
    const brought: Brought[] = []
    const bring = async (one: { module: string; session: string; title: string; program: string }) => {
      const provider = this.deps.providers(CONVERSATIONS_FINDER, root).find((p) => p.module === one.module)
      const finder = provider ? serviceDescriptor(CONVERSATIONS_FINDER, provider.descriptor) : null
      if (!finder) return void brought.push({ ...one, outcome: 'failed', to })
      try {
        const got = conversationsBringResult.safeParse(await this.#post(one.module, finder.bring, { project: root, session: one.session, to, from: null }))
        const outcome: Brought['outcome'] = !got.success ? 'failed' : got.data.outcome === 'brought' ? 'brought' : got.data.outcome === 'elsewhere' ? 'elsewhere' : 'failed'
        brought.push({ ...one, outcome, to })
      } catch {
        brought.push({ ...one, outcome: 'failed', to })
      }
    }
    const sure = toBring(found)
    for (const one of found) if (one.place === null && also.includes(one.session) && !sure.includes(one)) sure.push(one)
    await Promise.all(sure.map((one) => bring(one)))
    for (const one of found) if (elsewhere(one, to) && (confidentMatch(one.match) || also.includes(one.session))) brought.push({ module: one.module, program: one.program, session: one.session, title: one.title, outcome: 'elsewhere', to })
    if (task && !brought.some((one) => one.module === task.module && one.session === task.session)) {
      const program = this.deps.providers(AGENT_TASKS, root).find((p) => p.module === task.module)
      const tasks = program ? serviceDescriptor(AGENT_TASKS, program.descriptor) : null
      await bring({ module: task.module, session: task.session, title: 'adoption', program: tasks?.program ?? task.module })
      /* The task's own conversation is filed, not announced as one that worked on the item. */
      const last = brought[brought.length - 1]
      if (last) last.title = ''
    }

    const partNames = parts.map((part) => target.parts.find((one) => one.id === part)?.name ?? part)
    const said = adoptedSaid(target.title, partNames, brought.filter((one) => one.title !== ''))
    this.#keep(project, id, { kind: 'adopt', ref: seen.ref, epic, parts: [...parts], brought, said, undone: false })
    this.#proposals.delete(`${project}|${id}`)
    this.deps.changed(project)
    return {
      outcome: 'adopted',
      said,
      brought: brought.filter((one) => one.title !== '').map((one) => ({ session: one.session, title: one.title.slice(0, LIMITS.TITLE), program: one.program, outcome: one.outcome, why: '' })),
      why: '',
    }
  }

  /** `inbox.untrack`: tell nothing more about this item's ref here. */
  untrack(project: number, module: string, id: string): { outcome: 'done' | 'declined'; changed: number; why: string } {
    const seen = module === TRACKER_NOTICES_MODULE ? this.deps.notices.seen(project, id) : null
    if (!seen) return { outcome: 'declined', changed: 0, why: ADOPTION_SAYS.noItem }
    const out = this.deps.notices.track(project, id, false)
    this.#keep(project, id, { kind: 'untrack', ref: seen.ref, epic: null, parts: [], brought: [], said: untrackedSaid(seen.ref), undone: false })
    this.deps.changed(project)
    return { outcome: 'done', changed: out ? 1 : 0, why: '' }
  }

  /** "Track again", from Settings › Trackers: the item's notice comes back. */
  retrack(project: number, id: string): boolean {
    const out = this.deps.notices.track(project, id, true)
    const record = this.#record(project, id)
    if (record?.kind === 'untrack' && !record.undone) this.#keep(project, id, { ...record, undone: true, said: '' })
    this.deps.changed(project)
    return out !== null
  }

  /**
   * `inbox.undo`: take back the last adopt (the ref, and each conversation brought along, only where it
   * is still as it was left) or untrack.
   */
  async undo(project: number, module: string, id: string): Promise<{ outcome: 'done' | 'declined'; changed: number; why: string }> {
    const root = this.deps.pathOf(project)
    const record = module === TRACKER_NOTICES_MODULE ? this.#record(project, id) : null
    if (!root || !record || record.undone) return { outcome: 'declined', changed: 0, why: ADOPTION_SAYS.nothingToUndo }
    let changed = 0
    if (record.kind === 'untrack') {
      if (this.deps.notices.track(project, id, true)) changed += 1
    } else if (record.epic) {
      const out = this.deps.editRef(root, record.epic, record.ref, [], false)
      if (out.outcome === 'declined') return { outcome: 'declined', changed: 0, why: out.why }
      if (out.outcome === 'changed') changed += 1
      for (const one of record.brought) {
        if (one.outcome !== 'brought') continue
        const provider = this.deps.providers(CONVERSATIONS_FINDER, root).find((p) => p.module === one.module)
        const finder = provider ? serviceDescriptor(CONVERSATIONS_FINDER, provider.descriptor) : null
        if (!finder) continue
        try {
          const got = conversationsBringResult.safeParse(await this.#post(one.module, finder.bring, { project: root, session: one.session, to: null, from: one.to }))
          if (got.success && got.data.outcome === 'brought') changed += 1
        } catch {
          /* It stays where it was put; said by its own module. */
        }
      }
    }
    this.#keep(project, id, { ...record, undone: true, said: '' })
    this.deps.changed(project)
    return { outcome: 'done', changed, why: '' }
  }

  /* ---- an agent's proposal, and the task that makes one ---- */

  /** The item a ref names in a project's notices: what `propose_adoption` is about. */
  propose(project: number, id: string, proposal: Omit<Proposal, 'at'>): void {
    this.#proposals.set(`${project}|${id}`, { ...proposal, at: this.#now() })
    this.deps.changed(project)
  }

  /** The proposal for an item, when an agent made one. */
  proposalOf(project: number, id: string): Proposal | null {
    return this.#proposals.get(`${project}|${id}`) ?? null
  }

  /**
   * Start the person's agent for Kehikot's own tasks on one item, and answer AT ONCE: the start runs in
   * the background (`startTask`) and the page reads how it goes (`taskState`), so no call of the page
   * waits on the finders or on the agent's program starting. A start already under way for the item is
   * joined, never made twice. What cannot be started is said at once.
   */
  beginTask(project: number, module: string, id: string, kehikko: string | null = null): TaskState {
    const key = `${project}|${module}|${id}`
    const was = this.#tasks.get(key)
    if (was?.state === 'starting') return strip(was)
    const root = this.deps.pathOf(project)
    if (!root) return { state: 'failed', why: ADOPTION_SAYS.noProject }
    const picked = this.taskAgent(project, root, kehikko)?.agent ?? null
    const provider = picked ? providerOf(AGENT_TASKS, [picked]) : null
    if (!provider) return { state: 'failed', why: ADOPTION_SAYS.noAgent, noAgent: true }
    const starting: TaskState = { state: 'starting', module: provider.module, name: provider.name }
    this.#tasks.set(key, { ...starting, at: this.#now() })
    if (this.#tasks.size > 200) this.#tasks.delete(this.#tasks.keys().next().value!)
    void this.startTask(project, module, id, kehikko)
      .catch((error: unknown): Awaited<ReturnType<Adoption['startTask']>> => ({ ok: false, why: `${provider.name} didn’t start the task: ${error instanceof Error ? error.message : String(error)}` }))
      .then((got) => {
        const now = this.#now()
        this.#tasks.set(key, got.ok ? { state: 'started', module: got.module, name: got.name, session: got.session, view: got.view, at: now } : { state: 'failed', why: got.why, ...(got.noAgent ? { noAgent: true as const } : {}), at: now })
        this.deps.changed(project)
      })
    return starting
  }

  /** How the last start of a task for the item went; null when none was asked. */
  taskState(project: number, module: string, id: string): TaskState | null {
    const got = this.#tasks.get(`${project}|${module}|${id}`)
    return got ? strip(got) : null
  }

  /**
   * The start itself: a NEW conversation fed the brief (`adoptionBrief`), under no place until the
   * adoption files it. Every way it fails is said in words, naming the agent.
   */
  async startTask(project: number, module: string, id: string, kehikko: string | null = null): Promise<{ ok: true; module: string; name: string; session: string; view: string } | { ok: false; why: string; noAgent?: true }> {
    const root = this.deps.pathOf(project)
    if (!root) return { ok: false, why: ADOPTION_SAYS.noProject }
    const picked = this.taskAgent(project, root, kehikko)?.agent ?? null
    const provider = picked ? providerOf(AGENT_TASKS, [picked]) : null
    if (!provider) return { ok: false, why: ADOPTION_SAYS.noAgent, noAgent: true }
    const read = await this.adoption(project, module, id, kehikko, this.#limit('findMs') + 500)
    if (read.outcome !== 'ok' || !read.item) return { ok: false, why: read.why || ADOPTION_SAYS.noItem }
    const brief = clipBrief(
      adoptionBrief({
        project: root,
        item: read.item,
        epics: read.epics,
        candidates: read.conversations.map((one) => ({ program: one.program, session: one.session, title: one.title, reason: one.reason, match: one.match, placed: one.placed })),
        suggested: read.suggested,
      }),
    )
    const didNot = (why: string) => ({ ok: false as const, why: `${provider.name} didn’t start the task: ${why.replace(/\.$/, '')}.`.slice(0, LIMITS.REASON) })
    try {
      const got = agentTaskStartResult.safeParse(
        await this.#post(provider.module, provider.descriptor.start, { project: root, brief, place: null, title: `Place ${read.item.ref} in a space`.slice(0, LIMITS.TITLE) }, this.#limit('startMs')),
      )
      if (!got.success) return didNot('it answered in a shape Kehikot does not read')
      if (got.data.outcome !== 'started' || !got.data.session) return didNot(got.data.why || 'it gave no reason')
      const origin = await this.deps.originOf(provider.module)
      if (!origin) return { ok: false, why: `${provider.name} is not registered here.` }
      return { ok: true, module: provider.module, name: provider.name, session: got.data.session, view: `${new URL(origin).origin}${agentTaskView(provider.descriptor, got.data.session)}` }
    } catch (error) {
      return didNot(error instanceof Error ? error.message : String(error))
    }
  }
}

const strip = ({ at: _at, ...state }: TaskState & { at: number }): TaskState => state as TaskState

/** Strongest match first, then the newest; at most the twenty the page is given. */
function ranked(found: readonly Candidate[]): Candidate[] {
  const rank = (one: Candidate) => CONVERSATION_MATCHES.indexOf(one.match)
  return [...found].sort((a, b) => rank(a) - rank(b) || b.lastActive - a.lastActive).slice(0, 20)
}

/** A brief an agent module takes: at most `AGENT_TASK_BRIEF_MAX`, its instruction kept at the end. */
export function clipBrief(brief: string): string {
  if (brief.length <= AGENT_TASK_BRIEF_MAX) return brief
  const tail = brief.slice(brief.lastIndexOf(`\n\n${ADOPT_INSTRUCTION}`))
  const room = AGENT_TASK_BRIEF_MAX - tail.length - 40
  return `${brief.slice(0, Math.max(0, room)).trimEnd()}\n- … (more left out)${tail}`
}
