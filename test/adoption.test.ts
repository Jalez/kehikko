import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOST_CALLER, SERVICE_CALLER_HEADER, SERVICE_PASS_HEADER, type ServiceProvider, type TrackerRow } from 'kehikot-module-protocol'
import { mintServerPass } from 'kehikot-module-protocol/serve'

import { Adoption, type AdoptionDeps } from '../server/adoption.ts'
import { adoptRoutes, ADOPT_ROUTES } from '../server/adoptRoutes.ts'
import { open } from '../server/canvases.ts'
import { PAGE_ONLY } from '../server/guard.ts'
import { editEpicRef, readParts } from '../server/holdings.ts'
import { Inbox } from '../server/inbox.ts'
import { TOOL_NAMES } from '../server/mcp.ts'
import { addProject } from '../server/projects.ts'
import { TrackerNotices, writeNotices } from '../server/trackerNotices.ts'
import { epicsByRef } from '../server/trackers/reading.ts'
import { ADOPT_INSTRUCTION, adoptedSaid, dialogPlan, suggestEpic, toBring } from '../src/host/adoption.ts'
import type { Entry } from '../src/host/inbox.ts'
import { answerInbox, readOf, type InboxDoor } from '../src/host/inboxDoor.ts'
import { DEFAULT_NOTICES, TRACKER_NOTICES_MODULE, noticeItem, type Seen } from '../src/host/trackerNotices.ts'

/**
 * Adopting a tracker item no epic names (protocol 2.88.0): the suggestion, the one writer of an
 * epic's adopted refs, the automatic bring of a confident conversation, Undo, "Don't track this", the
 * dialog's plan, and that only the person's fresh press in a page adopts. Scratch folders and
 * databases; fake agent modules — nothing reaches a forge or a real module.
 */

const T0 = 1_800_000_000_000

describe('the suggestion comes from the repository or the branch, never adopts', () => {
  const item = { ref: '!4721', host: 'gitlab.example.org', repo: 'group/app', branch: 'feat/login' }
  const rows = [
    { ref: '!10', host: 'gitlab.example.org', repo: 'group/app', headBranch: 'feat/login-ui', baseBranch: 'feat/login' },
    { ref: '!11', host: 'gitlab.example.org', repo: 'group/app', headBranch: 'other' },
    { ref: '!12', host: 'gitlab.example.org', repo: 'group/other' },
  ]
  test('a branch that meets a change an epic names: that epic, sure', () => {
    const got = suggestEpic(item, [{ epic: 'auth', title: 'Auth', refs: ['!10'] }, { epic: 'misc', title: 'Misc', refs: ['!11'] }], rows)
    expect(got).toMatchObject({ epic: 'auth', sure: true })
    expect(got!.why).toContain('feat/login')
  })
  test('the same repository: suggested; sure only when one epic matches', () => {
    expect(suggestEpic({ ...item, branch: undefined }, [{ epic: 'misc', title: 'Misc', refs: ['!11'] }, { epic: 'other', title: 'Other', refs: ['!12'] }], rows)).toMatchObject({ epic: 'misc', sure: true })
    expect(suggestEpic({ ...item, branch: undefined }, [{ epic: 'a', title: 'A', refs: ['!10'] }, { epic: 'b', title: 'B', refs: ['!11'] }], rows)!.sure).toBe(false)
    expect(suggestEpic({ ...item, branch: undefined }, [{ epic: 'src', title: 'Src', refs: [], repo: 'group/app' }], rows)).toMatchObject({ epic: 'src', sure: true })
  })
  test('nothing to go by: no suggestion', () => {
    expect(suggestEpic(item, [{ epic: 'other', title: 'Other', refs: ['!12'] }], rows)).toBeNull()
  })
})

describe('the one writer of an epic\'s adopted refs', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-adopt-')))
    const dir = join(root, '.kehikot', 'kehikko', 'epics')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ title: 'Auth', parts: [{ id: 'login', name: 'Login' }] }, null, 2))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test('adds the ref to the epic and its part, every other byte kept; Undo takes it out; no change, no write', () => {
    const file = join(root, '.kehikot', 'kehikko', 'epics', 'auth.json')
    expect(editEpicRef(root, 'auth', '!4721', ['login'], true).outcome).toBe('changed')
    const written = JSON.parse(readFileSync(file, 'utf8'))
    expect(written).toMatchObject({ title: 'Auth', refs: ['!4721'], partRefs: { login: ['!4721'] } })
    expect(epicsByRef(root).get('!4721')).toBe('auth')
    expect(readParts(root, 'auth')![0]!.refs).toContain('!4721')
    expect(editEpicRef(root, 'auth', '!4721', ['login'], true).outcome).toBe('unchanged')
    expect(editEpicRef(root, 'auth', '!4721', ['nope'], true).outcome).toBe('declined')
    expect(editEpicRef(root, 'auth', '!4721', [], false).outcome).toBe('changed')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ refs: [], partRefs: {} })
    expect(epicsByRef(root).has('!4721')).toBe(false)
  })
})

/* ---- the Adoption, with fake agent modules ---- */

type Call = { module: string; path: string; body: any; headers: Record<string, string> }

function fakes(candidates: unknown[], options: { agent?: boolean } = {}) {
  const calls: Call[] = []
  const finder = { name: 'Agent', program: 'Agent CLI', find: '/api/find', bring: '/api/bring' }
  const tasks = { name: 'Agent', program: 'Agent CLI', start: '/api/tasks', view: '/app?session={session}' }
  const providers = (service: string): ServiceProvider[] =>
    service === 'conversations.finder'
      ? [{ module: 'kehikot.agent', name: 'Agent', descriptor: finder, placed: null }]
      : service === 'agent.tasks' && options.agent
        ? [{ module: 'kehikot.agent', name: 'Agent', descriptor: tasks, placed: null }]
        : []
  const places = new Map<string, unknown>()
  const fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname
    const body = JSON.parse(String(init.body))
    calls.push({ module: 'kehikot.agent', path, body, headers: init.headers as Record<string, string> })
    if (path === '/api/find') return Response.json({ conversations: candidates })
    if (path === '/api/tasks') return Response.json({ outcome: 'started', session: 'task-1' })
    if (path === '/api/bring') {
      const now = places.get(body.session) ?? (candidates as any[]).find((one) => one.session === body.session)?.place ?? null
      if (JSON.stringify(now) !== JSON.stringify(body.from)) return Response.json({ outcome: 'elsewhere', place: now })
      places.set(body.session, body.to)
      return Response.json({ outcome: 'brought', place: body.to })
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof globalThis.fetch
  return { calls, providers, fetch, places }
}

const row = (over: Partial<TrackerRow> = {}): TrackerRow => ({
  ref: '!4721',
  tracker: 'gitlab',
  host: 'gitlab.example.org',
  repo: 'group/app',
  number: 4721,
  kind: 'change',
  state: 'open',
  title: 'Fix login',
  url: 'https://gitlab.example.org/group/app/-/merge_requests/4721',
  labels: [],
  assignees: [],
  links: [],
  authorLogin: 'me',
  myRoles: ['author'],
  reviewers: [{ login: 'mona', state: 'requested' }],
  headBranch: 'feat/login',
  updatedAt: new Date(T0 - 60_000).toISOString(),
  readAt: new Date(T0).toISOString(),
  ...over,
})

describe('adopting, bringing along, Undo and untrack', () => {
  let db: Database
  let root: string
  let project: number
  let clock: number
  let inbox: Inbox
  let notices: TrackerNotices
  let id: string
  const edits: string[] = []
  const me = new Map([['gitlab|gitlab.example.org', 'me']])

  beforeEach(() => {
    db = open(':memory:')
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-adopt-')))
    const dir = join(root, '.kehikot', 'kehikko', 'epics')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ title: 'Auth', parts: [{ id: 'login', name: 'Login' }] }, null, 2))
    const added = addProject(db, root, 'a project')
    if (!added.ok) throw new Error(added.why)
    project = added.project.id
    clock = T0
    inbox = new Inbox(db, () => clock)
    notices = new TrackerNotices(db, inbox, () => clock)
    notices.landed(project, { rows: [row()], me, epics: new Map() })
    clock += 60_000
    notices.landed(project, { rows: [row({ reviewers: [{ login: 'mona', state: 'changes' }] })], me, epics: new Map() })
    id = inbox.all(project).find((one) => one.module === TRACKER_NOTICES_MODULE)!.id
    edits.length = 0
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const make = (f: ReturnType<typeof fakes>, more: Partial<AdoptionDeps> = {}) =>
    new Adoption({
      db,
      notices,
      pathOf: () => root,
      epics: () => [{ epic: 'auth', title: 'Auth', parts: [{ id: 'login', name: 'Login' }], refs: epicsByRef(root).has('!4721') ? ['!4721'] : [] }],
      rows: () => [],
      editRef: (r, epic, ref, parts, add) => {
        edits.push(`${add ? '+' : '-'}${epic}:${ref}:${parts.join(',')}`)
        return editEpicRef(r, epic, ref, parts, add)
      },
      providers: f.providers,
      originOf: async () => 'http://127.0.0.1:9999',
      tasksAgent: () => 'kehikot.agent',
      changed: (p) => notices.restateOne(p, epicsByRef(root)),
      fetch: f.fetch,
      clock: () => clock,
      ...more,
    })

  test('a confident, unplaced conversation of a provider comes along by itself; the ref is written by the one writer', async () => {
    const f = fakes([{ session: 's1', title: 'Fix login', match: 'created', reason: 'created !4721', lastActive: 5 }])
    const got = await make(f).adopt(project, TRACKER_NOTICES_MODULE, id, 'auth', ['login'], 'k1')
    expect(got.outcome).toBe('adopted')
    expect(edits).toEqual(['+auth:!4721:login'])
    expect(got.said).toBe('Added to Auth › Login · its Agent CLI conversation came along')
    const bring = f.calls.find((one) => one.path === '/api/bring')!
    expect(bring.body).toMatchObject({ project: root, session: 's1', to: { epic: 'auth', parts: ['login'], kehikko: 'k1' }, from: null })
    expect(bring.headers[SERVICE_CALLER_HEADER]).toBe(HOST_CALLER)
    expect(bring.headers[SERVICE_PASS_HEADER]).toMatch(/^[A-Za-z0-9_-]{32,64}$/)
    /* It is an ordinary item of the epic now. */
    expect(inbox.all(project).find((one) => one.id === id)!.place).toEqual({ epic: 'auth' })
  })

  test('adopting into a space deeper than a part: the ref goes where refs are kept, the conversation under the space itself', async () => {
    const f = fakes([{ session: 's1', title: 'Fix login', match: 'created', reason: 'created !4721', lastActive: 5 }])
    const got = await make(f).adopt(project, TRACKER_NOTICES_MODULE, id, 'auth', [], 'k1', null, [], ['auth', 'login', 'errors'])
    expect(got.outcome).toBe('adopted')
    /* Refs are kept at the top two levels: the depth-2 space that holds the chosen one. */
    expect(edits).toEqual(['+auth:!4721:login'])
    const bring = f.calls.find((one) => one.path === '/api/bring')!
    expect(bring.body).toMatchObject({ to: { epic: 'auth', parts: ['login'], kehikko: 'k1', space: ['auth', 'login', 'errors'] } })
  })

  test('a weak match is not brought; one filed under another place is not moved, and said', async () => {
    const f = fakes([
      { session: 'weak', title: 'Some work', match: 'folder', reason: 'worked in this repository', lastActive: 9 },
      { session: 'there', title: 'Fix login too', match: 'pushed', reason: 'pushed branch feat/login', lastActive: 4, place: { epic: 'other', parts: [], kehikko: null } },
    ])
    const got = await make(f).adopt(project, TRACKER_NOTICES_MODULE, id, 'auth', [], null)
    expect(f.calls.filter((one) => one.path === '/api/bring')).toEqual([])
    expect(got.brought).toEqual([{ session: 'there', title: 'Fix login too', program: 'Agent CLI', outcome: 'elsewhere', why: '' }])
    expect(got.said).toBe('Added to Auth · one of its conversations is filed elsewhere and stayed there')
  })

  test('Undo takes back the ref and the conversation\'s place, only where it is still as left', async () => {
    const f = fakes([{ session: 's1', title: 'Fix login', match: 'branch', reason: 'worked on branch feat/login', lastActive: 5 }])
    const adoption = make(f)
    await adoption.adopt(project, TRACKER_NOTICES_MODULE, id, 'auth', [], null)
    expect(adoption.afters(project)).toEqual([{ module: TRACKER_NOTICES_MODULE, id, said: 'Added to Auth · its Agent CLI conversation came along', undo: true }])
    const undone = await adoption.undo(project, TRACKER_NOTICES_MODULE, id)
    expect(undone).toMatchObject({ outcome: 'done', changed: 2 })
    expect(edits).toEqual(['+auth:!4721:', '-auth:!4721:'])
    const back = f.calls.filter((one) => one.path === '/api/bring').at(-1)!
    expect(back.body).toMatchObject({ session: 's1', to: null, from: { epic: 'auth', parts: [], kehikko: null } })
    expect(f.places.get('s1')).toBeNull()
    expect(epicsByRef(root).has('!4721')).toBe(false)
    expect((await adoption.undo(project, TRACKER_NOTICES_MODULE, id)).outcome).toBe('declined')
  })

  test('"Don\'t track this": the notice goes and stays gone; Track again brings it back', () => {
    const f = fakes([])
    const adoption = make(f)
    const live = () => inbox.open(project).filter((one) => one.module === TRACKER_NOTICES_MODULE && one.closed === null)
    expect(live()).toHaveLength(1)
    expect(adoption.untrack(project, TRACKER_NOTICES_MODULE, id).outcome).toBe('done')
    expect(live()).toHaveLength(0)
    clock += 60_000
    notices.landed(project, { rows: [row({ reviewers: [{ login: 'mona', state: 'approved' }] })], me, epics: new Map() })
    expect(live()).toHaveLength(0)
    expect(notices.untracked(project).map((one) => one.ref)).toEqual(['!4721'])
    expect(adoption.retrack(project, id)).toBe(true)
    expect(live()).toHaveLength(1)
  })

  test('the setting: no items an epic does not name, when the person turns them off', () => {
    const seen: Seen = { id: 'x', ref: '!1', title: 't', facts: { kind: 'change', state: 'open' }, events: [{ kind: 'approved', at: T0 }], since: T0, at: T0 }
    expect(noticeItem(seen, DEFAULT_NOTICES)).not.toBeNull()
    expect(noticeItem(seen, { ...DEFAULT_NOTICES, outside: false })).toBeNull()
    expect(noticeItem({ ...seen, epic: 'auth' }, { ...DEFAULT_NOTICES, outside: false })).not.toBeNull()
    writeNotices(db, { ...DEFAULT_NOTICES, outside: false })
  })

  test('the dialog starts a new conversation with the brief, through the person\'s agent', async () => {
    const f = fakes([{ session: 's1', title: 'Fix login', match: 'created', reason: 'created !4721', lastActive: 5 }], { agent: true })
    const got = await make(f).startTask(project, TRACKER_NOTICES_MODULE, id)
    expect(got).toEqual({ ok: true, module: 'kehikot.agent', name: 'Agent', session: 'task-1', view: 'http://127.0.0.1:9999/app?session=task-1' })
    const start = f.calls.find((one) => one.path === '/api/tasks')!
    expect(start.headers[SERVICE_CALLER_HEADER]).toBe(HOST_CALLER)
    expect(start.body.place).toBeNull()
    for (const line of ['!4721', 'Fix login', 'https://gitlab.example.org/group/app/-/merge_requests/4721', 'feat/login', 'auth — Auth', 'login (Login)', 's1 (Agent CLI)', ADOPT_INSTRUCTION]) {
      expect(start.body.brief).toContain(line)
    }
    expect((await make(f, { tasksAgent: () => null }).startTask(project, TRACKER_NOTICES_MODULE, id)).ok).toBe(false)
  })

  test('propose fills the dialog and adopts nothing; the task\'s conversation is filed with the adoption', async () => {
    const f = fakes([{ session: 's1', title: 'Fix login', match: 'mentioned', reason: 'mentioned !4721', lastActive: 5 }], { agent: true })
    const adoption = make(f)
    adoption.propose(project, id, { epic: 'auth', parts: [], conversations: ['s1'], why: 'Same repository.' })
    expect(edits).toEqual([])
    const read = await adoption.adoption(project, TRACKER_NOTICES_MODULE, id)
    expect(read.proposal).toEqual({ epic: 'auth', parts: [], conversations: ['s1'], why: 'Same repository.' })
    expect(read.agent).toEqual({ module: 'kehikot.agent', name: 'Agent' })
    expect(read.conversations[0]).toMatchObject({ session: 's1', comes: false, program: 'Agent CLI' })
    /* The person's one press: the proposal's conversation, confirmed, comes along though weak, and so does the task's. */
    const got = await adoption.adopt(project, TRACKER_NOTICES_MODULE, id, 'auth', [], null, { module: 'kehikot.agent', session: 'task-1' }, ['s1'])
    expect(got.brought.map((one) => one.session)).toEqual(['s1'])
    expect(f.calls.filter((one) => one.path === '/api/bring').map((one) => one.body.session)).toEqual(['s1', 'task-1'])
    expect(adoption.proposalOf(project, id)).toBeNull()
  })
})

describe('the words and the dialog\'s plan', () => {
  test('what an adoption says', () => {
    expect(adoptedSaid('Auth', [], [{ program: 'P', outcome: 'brought' }])).toBe('Added to Auth · its P conversation came along')
    expect(adoptedSaid('Auth', [], [])).toBe('Added to Auth')
    expect(toBring([{ match: 'created', place: null }, { match: 'folder', place: null }, { match: 'pushed', place: { epic: 'x', parts: [], kehikko: null } }])).toEqual([{ match: 'created', place: null }])
  })
  const epics = [{ epic: 'auth', title: 'Auth', parts: [{ id: 'login', name: 'Login' }] }]
  const conversations = [{ session: 's1', title: 'Fix login', program: 'P' }]
  test('with an agent: nothing to confirm until it proposes; then one press', () => {
    expect(dialogPlan({ epics, suggested: null, agent: { module: 'm', name: 'A' }, proposal: null, conversations })).toEqual({ mode: 'agent', confirm: null })
    expect(dialogPlan({ epics, suggested: null, agent: { module: 'm', name: 'A' }, proposal: { epic: 'auth', parts: ['login'], conversations: ['s1'] }, conversations }).confirm).toEqual({
      epic: 'auth',
      parts: ['login'],
      label: 'Adopt into Auth › Login · bring Fix login (P)',
      conversations: ['s1'],
    })
    expect(dialogPlan({ epics, suggested: null, agent: { module: 'm', name: 'A' }, proposal: { epic: 'gone', parts: [], conversations: [] }, conversations }).confirm).toBeNull()
  })
  test('with no agent picked: the picker, with the suggestion chosen', () => {
    expect(dialogPlan({ epics, suggested: { epic: 'auth', parts: [] }, agent: null, proposal: null, conversations })).toEqual({
      mode: 'picker',
      confirm: { epic: 'auth', parts: [], label: 'Adopt into Auth', conversations: [] },
    })
  })
})

describe('only the person\'s fresh press in a page adopts', () => {
  const entry = (more: Partial<Entry> = {}): Entry => ({
    module: TRACKER_NOTICES_MODULE,
    name: '',
    id: 'gitlab:gitlab.example.org/group/app!4721',
    state: 'attention',
    label: '!4721 · changes requested by mona',
    priority: 'normal',
    refs: ['!4721'],
    entered: 1,
    opened: 1,
    closed: null,
    how: null,
    seen: null,
    dismissed: null,
    origin: 'activity',
    ...more,
  })
  const door = (entries: Entry[], ran: string[]): InboxDoor => ({
    entries: () => entries,
    elsewhere: () => [],
    muted: () => [],
    earlier: () => 0,
    rev: () => 1,
    next: () => null,
    at: () => ({ epic: null, kehikko: null }),
    names: () => ({ epic: () => null, part: () => null, kehikko: () => null }),
    projectName: () => 'P',
    log: async () => null,
    act: () => {},
    answer: async () => ({ ok: true }),
    open: () => {},
    use: () => {},
    hasProject: () => true,
    adopting: {
      afters: () => new Map([[`${TRACKER_NOTICES_MODULE}\u0000x`, { said: 'Added to Auth', undo: true }]]),
      adoption: async () => (ran.push('adoption'), { outcome: 'ok', why: '', item: null, epics: [], suggested: null, conversations: [], agent: null, proposal: null }),
      adopt: async (_key, epic) => (ran.push(`adopt ${epic}`), { outcome: 'adopted', said: 'Added to Auth', brought: [], why: '' }),
      adoptWith: async () => (ran.push('with'), 'no-agent'),
      untrack: async () => (ran.push('untrack'), { outcome: 'done', changed: 1, why: '' }),
      undo: async () => (ran.push('undo'), { outcome: 'done', changed: 1, why: '' }),
    },
  })
  const key = { module: TRACKER_NOTICES_MODULE, id: 'gitlab:gitlab.example.org/group/app!4721' }

  test('no press: every act is declined and nothing runs; the read needs none', async () => {
    const ran: string[] = []
    const d = door([entry()], ran)
    for (const [method, params] of [
      ['inbox.adopt', { ...key, epic: 'auth' }],
      ['inbox.adoptWith', key],
      ['inbox.untrack', key],
      ['inbox.undo', key],
    ] as const) {
      const got = await answerInbox(method, params, false, d)
      expect(got.ok && (got.data as { outcome: string }).outcome).toBe('declined')
    }
    expect(ran).toEqual([])
    expect((await answerInbox('inbox.adoption', key, false, d)).ok).toBe(true)
    expect(ran).toEqual(['adoption'])
  })

  test('a fresh press: each act runs; an item an epic names is not adoptable', async () => {
    const ran: string[] = []
    const d = door([entry()], ran)
    expect(((await answerInbox('inbox.adopt', { ...key, epic: 'auth' }, true, d)) as any).data.outcome).toBe('adopted')
    expect(((await answerInbox('inbox.adoptWith', key, true, d)) as any).data.outcome).toBe('no-agent')
    expect(((await answerInbox('inbox.untrack', key, true, d)) as any).data.outcome).toBe('done')
    expect(((await answerInbox('inbox.undo', key, true, d)) as any).data.outcome).toBe('done')
    expect(ran).toEqual(['adopt auth', 'with', 'untrack', 'undo'])
    const inEpic = door([entry({ place: { epic: 'auth' } })], [])
    expect(((await answerInbox('inbox.adopt', { ...key, epic: 'auth' }, true, inEpic)) as any).data.outcome).toBe('no-such-item')
  })

  test('items say whether they are adoptable, and what the last act did', () => {
    const d = door([entry(), entry({ id: 'x', place: { epic: 'auth' } })], [])
    const [a, b] = readOf(d).items
    expect(a).toMatchObject({ adoptable: true })
    expect(b).toMatchObject({ adoptable: false, after: { said: 'Added to Auth', undo: true } })
  })

  test('no agent tool adopts, untracks or undoes; the routes are the page\'s alone', () => {
    for (const name of TOOL_NAMES) expect(name).not.toMatch(/adopt$|untrack|undo/)
    expect(TOOL_NAMES).toContain('propose_adoption')
    for (const path of [...ADOPT_ROUTES, '/host/tasks-agent']) expect(PAGE_ONLY).toContain(path)
    expect(PAGE_ONLY).not.toContain('/host/server-pass')
  })

  test('the host vouches for its own pass once, at /host/server-pass', async () => {
    const route = adoptRoutes({ adoption: {} as Adoption, untracked: () => [], hasProject: () => true })
    const pass = mintServerPass()
    const ask = async (p: string) => (await (await route(new Request(`http://127.0.0.1/host/server-pass?pass=${p}`), new URL(`http://127.0.0.1/host/server-pass?pass=${p}`)))!.json()) as { minted: boolean }
    expect((await ask(pass)).minted).toBe(true)
    expect((await ask(pass)).minted).toBe(false)
  })
})
