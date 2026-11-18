import type { Ran, Runner } from '../server/feedback.ts'

/**
 * A fixture tracker: a fake `gh` and a fake `glab` answering for one repository
 * of `size` items held in memory, the way the real CLIs answer the queries the
 * adapters make. For counting what a read costs (`dev/tracker-bench.ts`) and
 * for the tests that hold the reads incremental. Nothing here reaches GitHub
 * or GitLab.
 *
 * The answers are shaped and sized like real ones (people with pictures,
 * labels, a timeline, checks), so the bytes counted are near what a real read
 * moves. Conditional requests (`-i -H If-None-Match: …`) are answered 304
 * when the ETag still holds, as both trackers do.
 */

export interface Item {
  number: number
  kind: 'issue' | 'change'
  state: 'open' | 'closed' | 'merged'
  createdAt: string
  updatedAt: string
  closedAt: string | null
  /** A change's checks: what the tracker says of its CI. */
  checks: 'SUCCESS' | 'FAILURE' | 'PENDING'
  comments: number
}

export interface Fixture {
  items: Map<number, Item>
  /** Every process started, as argv. */
  asked: string[][]
  /** Bytes written to stdout across every process. */
  bytes: number
  /** Answer for these items as of now. */
  touch(number: number, at: string, change?: Partial<Item>): void
  add(item: Omit<Item, 'number'>): Item
  run: Runner
  reset(): void
}

const DAY = 86_400_000

/** A repository of `size` items, a fifth of them changes, the newest created last; about a tenth open. */
export function fixtureItems(size: number, now: number): Map<number, Item> {
  const items = new Map<number, Item>()
  const span = 500 * DAY
  for (let n = 1; n <= size; n += 1) {
    const created = now - span + (n / size) * span - DAY
    const kind = n % 5 === 0 ? 'change' : 'issue'
    const open = n % 11 === 0 || n > size - 40
    const updated = open ? Math.max(created, now - ((n * 7919) % 45) * DAY - DAY) : created + 3 * DAY
    items.set(n, {
      number: n,
      kind,
      state: open ? 'open' : kind === 'change' ? 'merged' : 'closed',
      createdAt: new Date(created).toISOString(),
      updatedAt: new Date(Math.min(updated, now - 60_000)).toISOString(),
      closedAt: open ? null : new Date(created + 3 * DAY).toISOString(),
      checks: n % 3 === 0 ? 'FAILURE' : 'SUCCESS',
      comments: n % 7,
    })
  }
  return items
}

const ok = (out: string): Ran => ({ code: 0, out, err: '' })
const avatar = (login: string) => `https://avatars.githubusercontent.com/u/${login.length * 7919}?s=48&v=4`
const person = (login: string) => ({ login, avatarUrl: avatar(login), fullName: `${login[0]!.toUpperCase()}${login.slice(1)} Person` })
const LOGINS = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank']
const pick = (n: number, k = 0) => LOGINS[(n + k) % LOGINS.length]!

function etagOf(text: string): string {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return `W/"${(h >>> 0).toString(16)}"`
}

/** A conditional answer, as `gh api -i` and `glab api -i` print one: the status line, headers, a blank line and the body. */
function conditional(argv: string[], body: string): Ran {
  const etag = etagOf(body)
  const at = argv.indexOf('-H')
  const header = at >= 0 ? argv[at + 1] ?? '' : ''
  const sent = /^If-None-Match:\s*(.+)$/i.exec(header)?.[1]?.trim()
  if (sent && sent === etag) {
    return { code: 1, out: `HTTP/2.0 304 Not Modified\r\nEtag: ${etag}\r\n\r\n`, err: 'gh: HTTP 304' }
  }
  return ok(`HTTP/2.0 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nEtag: ${etag}\r\n\r\n${body}`)
}

/* ------------------------------------------------------------------------ *
 * GitHub
 * ------------------------------------------------------------------------ */

function ghIssue(it: Item, repo: string) {
  return {
    __typename: 'Issue',
    number: it.number,
    state: it.state === 'open' ? 'OPEN' : 'CLOSED',
    stateReason: it.state === 'open' ? null : 'COMPLETED',
    title: `Issue number ${it.number}: a title of the length people write them`,
    url: `https://github.com/${repo}/issues/${it.number}`,
    createdAt: it.createdAt,
    updatedAt: it.updatedAt,
    closedAt: it.closedAt,
    author: person(pick(it.number)),
    labels: { nodes: [{ name: 'bug' }, { name: `area:${it.number % 9}` }] },
    assignees: { nodes: [{ login: pick(it.number, 1), name: 'Assignee', avatarUrl: avatar(pick(it.number, 1)) }] },
    closedByPullRequestsReferences: { nodes: it.state === 'open' ? [] : [{ number: it.number + 1, merged: true, state: 'MERGED', isDraft: false }] },
    timelineItems: { nodes: it.comments ? [{ __typename: 'IssueComment', createdAt: it.updatedAt, author: { login: pick(it.number, 2), avatarUrl: avatar(pick(it.number, 2)) } }] : [] },
    linkedBranches: { nodes: [] },
    projectItems: { nodes: [] },
  }
}

function ghPull(it: Item, repo: string) {
  return {
    __typename: 'PullRequest',
    number: it.number,
    state: it.state === 'open' ? 'OPEN' : it.state === 'merged' ? 'MERGED' : 'CLOSED',
    title: `Pull request ${it.number}: fix the thing the issue describes`,
    url: `https://github.com/${repo}/pull/${it.number}`,
    body: `Fixes #${it.number - 1}\n\n${'A description of what this change does and why, as people write them. '.repeat(6)}`,
    createdAt: it.createdAt,
    updatedAt: it.updatedAt,
    closedAt: it.closedAt,
    mergedAt: it.state === 'merged' ? it.closedAt : null,
    isDraft: false,
    reviewDecision: it.state === 'open' ? 'REVIEW_REQUIRED' : 'APPROVED',
    headRefName: `fix-${it.number}`,
    baseRefName: 'main',
    isCrossRepository: false,
    author: person(pick(it.number)),
    labels: { nodes: [{ name: 'enhancement' }] },
    assignees: { nodes: [] },
    closingIssuesReferences: { nodes: [{ number: it.number - 1 }] },
    commits: { nodes: [{ commit: { committedDate: it.updatedAt, statusCheckRollup: { state: it.checks, contexts: { nodes: [] } } } }] },
    reviewRequests: { nodes: [{ requestedReviewer: { login: pick(it.number, 3), name: 'Reviewer', avatarUrl: avatar(pick(it.number, 3)) } }] },
    latestReviews: { nodes: [{ state: 'COMMENTED', submittedAt: it.updatedAt, author: { login: pick(it.number, 4), avatarUrl: avatar(pick(it.number, 4)), name: 'R' } }] },
    reviewThreads: { totalCount: 2, nodes: [{ isResolved: true, comments: { nodes: [{ author: { login: pick(it.number, 4), avatarUrl: avatar(pick(it.number, 4)) } }] } }, { isResolved: false, comments: { nodes: [{ author: { login: pick(it.number, 5), avatarUrl: avatar(pick(it.number, 5)) } }] } }] },
    timelineItems: {
      nodes: Array.from({ length: Math.min(10, 2 + it.comments) }, (_, i) =>
        i % 2
          ? { __typename: 'PullRequestCommit', commit: { committedDate: it.updatedAt, oid: `abc${it.number}${i}`.padEnd(40, '0') } }
          : { __typename: 'IssueComment', createdAt: it.updatedAt, author: { login: pick(it.number, i), avatarUrl: avatar(pick(it.number, i)) } },
      ),
    },
    projectItems: { nodes: [] },
  }
}

const ghNode = (it: Item, repo: string) => (it.kind === 'change' ? ghPull(it, repo) : ghIssue(it, repo))

/** One half of a listing as the query asks it: `issues(first: 50, after: "o50", orderBy: …, states: […], filterBy: { since: … })`. */
function ghHalf(items: Item[], query: string, half: 'issues' | 'pullRequests', repo: string): unknown {
  const m = new RegExp(`\\b${half}\\(([^)]*)\\)`).exec(query)
  if (!m) return undefined
  const args = m[1]!
  const first = Number(/first: (\d+)/.exec(args)?.[1] ?? 50)
  const after = Number(/after: "o(\d+)"/.exec(args)?.[1] ?? 0)
  const field = /field: (\w+)/.exec(args)?.[1] ?? 'CREATED_AT'
  const states = /states: \[([^\]]*)\]/.exec(args)?.[1]?.split(',').map((s) => s.trim().toLowerCase())
  const since = /since: "([^"]+)"/.exec(args)?.[1]
  let list = items.filter((it) => (half === 'issues' ? it.kind === 'issue' : it.kind === 'change'))
  if (states) list = list.filter((it) => states.includes(it.state))
  if (since) list = list.filter((it) => it.updatedAt >= since)
  list.sort((a, b) => (field === 'UPDATED_AT' ? b.updatedAt.localeCompare(a.updatedAt) : b.createdAt.localeCompare(a.createdAt)))
  const page = list.slice(after, after + first)
  const more = after + first < list.length
  return { pageInfo: { hasNextPage: more, endCursor: more ? `o${after + first}` : null }, nodes: page.map((it) => ghNode(it, repo)) }
}

function answerGh(f: { items: Map<number, Item> }, argv: string[], repo: string): Ran {
  const rest = argv.slice(1)
  if (rest[0] === 'api' && rest[1] === 'user') return ok(JSON.stringify({ login: 'alice', name: 'Alice' }))
  if (rest[0] === 'api' && rest[1] === 'graphql') {
    const query = (rest.find((a) => a.startsWith('query=')) ?? '').slice('query='.length)
    const items = [...f.items.values()]
    if (/issueOrPullRequest\(number:/.test(query)) {
      const out: Record<string, unknown> = {}
      for (const m of query.matchAll(/n(\d+): issueOrPullRequest\(number: (\d+)\)/g)) {
        const it = f.items.get(Number(m[2]))
        out[`n${m[1]}`] = it ? ghNode(it, repo) : null
      }
      return ok(JSON.stringify({ data: { repository: out } }))
    }
    const repository: Record<string, unknown> = {}
    const issues = ghHalf(items, query, 'issues', repo)
    const pulls = ghHalf(items, query, 'pullRequests', repo)
    if (issues !== undefined) repository.issues = issues
    if (pulls !== undefined) repository.pullRequests = pulls
    return ok(JSON.stringify({ data: { repository } }))
  }
  if (rest[0] === 'api' && rest.some((a) => a.startsWith('repos/'))) {
    /* The REST issues list, newest updated first (issues and pull requests both). */
    const path = rest.find((a) => a.startsWith('repos/'))!
    const per = Number(/per_page=(\d+)/.exec(path)?.[1] ?? 30)
    const newest = [...f.items.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, per)
    const body = JSON.stringify(newest.map((it) => ({ number: it.number, state: it.state === 'open' ? 'open' : 'closed', updated_at: it.updatedAt, comments: it.comments, ...(it.kind === 'change' ? { pull_request: { merged_at: it.state === 'merged' ? it.closedAt : null } } : {}) })))
    return rest.includes('-i') || rest.includes('--include') ? conditional(rest, body) : ok(body)
  }
  if (rest[0] === 'pr' || rest[0] === 'issue') return ok(JSON.stringify({ body: 'A body.', files: [], headRefOid: 'a'.repeat(40), latestReviews: [] }))
  return { code: 1, out: '', err: `the fixture does not answer ${argv.join(' ')}` }
}

/* ------------------------------------------------------------------------ *
 * GitLab
 * ------------------------------------------------------------------------ */

function glRest(it: Item, host: string, repo: string) {
  const base = {
    iid: it.number,
    state: it.state === 'open' ? 'opened' : it.state,
    title: `${it.kind === 'change' ? 'Merge request' : 'Issue'} ${it.number}: a title of the length people write them`,
    web_url: `https://${host}/${repo}/-/${it.kind === 'change' ? 'merge_requests' : 'issues'}/${it.number}`,
    created_at: it.createdAt,
    updated_at: it.updatedAt,
    closed_at: it.closedAt,
    labels: ['bug', `area::${it.number % 9}`],
    author: { username: pick(it.number), name: 'Author Person', avatar_url: avatar(pick(it.number)) },
    assignees: [{ username: pick(it.number, 1), name: 'Assignee', avatar_url: avatar(pick(it.number, 1)) }],
    user_notes_count: it.comments,
    description: `${'A description as people write them. '.repeat(8)}`,
  }
  return it.kind === 'change'
    ? { ...base, merged_at: it.state === 'merged' ? it.closedAt : null, draft: false, source_branch: `${it.number - 1}-fix`, target_branch: 'main', source_project_id: 1, target_project_id: 1, description: `Closes #${it.number - 1}\n\n${base.description}` }
    : { ...base, issue_type: 'issue' }
}

function glGraph(it: Item, host: string, repo: string) {
  const notes = { nodes: Array.from({ length: Math.min(5, it.comments) }, () => ({ system: false, body: 'A comment as people write them.', createdAt: it.updatedAt, author: { username: pick(it.number, 2), avatarUrl: avatar(pick(it.number, 2)) }, position: null })) }
  const common = {
    iid: String(it.number),
    state: it.state === 'open' ? 'opened' : it.state,
    title: `${it.kind === 'change' ? 'Merge request' : 'Issue'} ${it.number}: a title of the length people write them`,
    webUrl: `https://${host}/${repo}/-/${it.kind === 'change' ? 'merge_requests' : 'issues'}/${it.number}`,
    createdAt: it.createdAt,
    updatedAt: it.updatedAt,
    closedAt: it.closedAt,
    labels: { nodes: [{ title: 'bug' }] },
    assignees: { nodes: [{ name: 'Assignee', username: pick(it.number, 1), avatarUrl: avatar(pick(it.number, 1)) }] },
    author: { name: 'Author', username: pick(it.number), avatarUrl: avatar(pick(it.number)) },
    notes,
  }
  if (it.kind === 'issue') return { ...common, type: 'ISSUE' }
  return {
    ...common,
    draft: false,
    mergedAt: it.state === 'merged' ? it.closedAt : null,
    description: `Closes #${it.number - 1}`,
    approved: false,
    sourceBranch: `${it.number - 1}-fix`,
    targetBranch: 'main',
    sourceProjectId: 1,
    targetProjectId: 1,
    headPipeline: { status: it.checks === 'SUCCESS' ? 'SUCCESS' : it.checks === 'PENDING' ? 'RUNNING' : 'FAILED', finishedAt: it.updatedAt, createdAt: it.updatedAt },
    reviewers: { nodes: [{ username: pick(it.number, 3), name: 'R', avatarUrl: avatar(pick(it.number, 3)), mergeRequestInteraction: { approved: false, reviewState: 'UNREVIEWED' } }] },
    approvedBy: { nodes: [] },
    resolvableDiscussionsCount: 2,
    resolvedDiscussionsCount: 1,
    commits: { nodes: [{ committedDate: it.updatedAt }] },
  }
}

function answerGlab(f: { items: Map<number, Item> }, argv: string[], host: string, repo: string): Ran {
  const rest = argv.slice(argv.indexOf('--hostname') + 2)
  const items = [...f.items.values()]
  if (rest[0] === 'user') return ok(JSON.stringify({ username: 'alice', name: 'Alice' }))
  if (rest[0] === 'graphql') {
    const query = (rest.find((a) => a.startsWith('query=')) ?? '').slice('query='.length)
    const iids = (what: string) => {
      const m = new RegExp(`${what}\\(iids: \\[([^\\]]*)\\]`).exec(query)
      return m ? m[1]!.split(',').map((s) => Number(s.replace(/"/g, ''))).filter(Boolean) : null
    }
    const project: Record<string, unknown> = {}
    const is = iids('issues')
    const ms = iids('mergeRequests')
    if (is) project.issues = { nodes: is.map((n) => f.items.get(n)).filter((it) => it?.kind === 'issue').map((it) => glGraph(it!, host, repo)) }
    if (ms) project.mergeRequests = { nodes: ms.map((n) => f.items.get(n)).filter((it) => it?.kind === 'change').map((it) => glGraph(it!, host, repo)) }
    return ok(JSON.stringify({ data: { project } }))
  }
  const path = rest.find((a) => a.startsWith('projects/')) ?? ''
  if (/\/boards/.test(path)) return ok('[]')
  if (/\/repository\/branches/.test(path)) {
    const body = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ name: `${i + 1}-branch` })))
    return argv.includes('-i') ? conditional(argv, body) : ok(body)
  }
  const what = /\/(issues|merge_requests)\?/.exec(path)?.[1]
  if (what) {
    const q = new URLSearchParams(path.split('?')[1])
    const state = q.get('state') ?? 'all'
    const after = q.get('updated_after')
    const per = Number(q.get('per_page') ?? 20)
    const page = Number(q.get('page') ?? 1)
    let list = items.filter((it) => (what === 'issues' ? it.kind === 'issue' : it.kind === 'change'))
    if (state === 'opened') list = list.filter((it) => it.state === 'open')
    if (after) list = list.filter((it) => it.updatedAt >= new Date(after).toISOString())
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const body = JSON.stringify(list.slice((page - 1) * per, page * per).map((it) => glRest(it, host, repo)))
    return argv.includes('-i') ? conditional(argv, body) : ok(body)
  }
  return { code: 1, out: '', err: `the fixture does not answer ${argv.join(' ')}` }
}

/**
 * The fixture: `tracker` names which CLI answers for `repo`; `git remote -v`
 * names it as the project's origin.
 */
export function fixtureTracker(options: { tracker: 'github' | 'gitlab'; host: string; repo: string; size: number; now: number }): Fixture {
  const { tracker, host, repo } = options
  const f: Fixture = {
    items: fixtureItems(options.size, options.now),
    asked: [],
    bytes: 0,
    touch(number, at, change = {}) {
      const it = f.items.get(number)
      if (!it) throw new Error(`no item ${number}`)
      Object.assign(it, change, { updatedAt: at })
    },
    add(item) {
      const number = Math.max(...f.items.keys()) + 1
      const made = { ...item, number }
      f.items.set(number, made)
      return made
    },
    reset() {
      f.asked = []
      f.bytes = 0
    },
    run: async (argv) => {
      f.asked.push(argv)
      let ran: Ran
      if (argv[0] === 'git') {
        ran = argv.includes('remote')
          ? ok(`origin\thttps://${host}/${repo}.git (fetch)\norigin\thttps://${host}/${repo}.git (push)\n`)
          : { code: 1, out: '', err: 'not a repository' }
      } else if (argv[0] === 'gh' && tracker === 'github') ran = answerGh(f, argv, repo)
      else if (argv[0] === 'glab' && tracker === 'gitlab') ran = answerGlab(f, argv, host, repo)
      else ran = { code: 1, out: '', err: `the fixture does not answer ${argv.join(' ')}` }
      f.bytes += ran.out.length
      return ran
    },
  }
  return f
}
