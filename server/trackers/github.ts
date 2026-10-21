import {
  LIMITS,
  type PipelineState,
  type ReviewState,
  type TrackerBoard,
  type TrackerColumn,
  type TrackerDetailFacts,
  type TrackerDiscussions,
  type TrackerReviewer,
  type TrackerRow,
} from 'kehikot-module-protocol'

import type { Runner } from '../feedback.ts'
import {
  chunks,
  clip,
  instant,
  labelsOf,
  list,
  login,
  logins,
  nodes,
  obj,
  parsed,
  people,
  row,
  spell,
  str,
  trouble,
  who,
  type Adapter,
  type BoardsRead,
  type Me,
  type Read,
} from './common.ts'
import type { Source } from './sources.ts'

/**
 * GitHub, through `gh api graphql`.
 *
 * A listing is one GraphQL query per page of a hundred issues AND a hundred
 * pull requests, newest created first (the order `gh issue list` uses); named
 * refs are one query per fifty, by `issueOrPullRequest`, because GitHub numbers
 * issues and pull requests from one sequence and `gh#41` cannot say which it
 * is. Detail is a `gh … view` per ref, asked for a few at a time.
 *
 * ## Board columns
 *
 * Both queries carry each item's `projectItems`: the GitHub Projects (v2) it is
 * on, and where it stands on each. The column is the item's value of the
 * project's single-select field named "Status" — the field a new project's
 * board groups by. A project with no such field falls back to the first
 * single-select field the item has a value for, which is what a board made
 * from a custom field groups by in practice. An item on a project with a Status
 * field and no value for it ("No Status") has no column on that board. Archived
 * items and closed projects are left out.
 *
 * Projects need the `read:project` scope, which `gh auth login` does not ask
 * for. Without it GitHub refuses the whole query (`INSUFFICIENT_SCOPES`, no
 * data), so the query is asked again without `projectItems`, the rows come
 * back with no `column`, and the read says boards were unreadable — once, as
 * `NEEDS_PROJECT_SCOPE`. The refusal is remembered per host for
 * `SCOPE_RECHECK_MS`, so a reading does not pay a refused query every time,
 * and a `gh auth refresh -s read:project` is noticed within that.
 */

/** `--repo` for a source: `owner/repo`, or `host/owner/repo` off github.com. */
const repoArg = (s: Source) => (s.host === 'github.com' ? s.repo : `${s.host}/${s.repo}`)

/** GitHub's check rollup as one pipeline word, or nothing when no check ran. */
export function pipelineOf(checks: unknown): PipelineState | undefined {
  const all = nodes(checks).map(obj)
  if (!all.length) {
    /* GraphQL's rollup is one object with a `state`. */
    const state = str(obj(checks).state).toUpperCase()
    if (state === 'SUCCESS') return 'success'
    if (state === 'FAILURE' || state === 'ERROR') return 'failed'
    if (state === 'PENDING' || state === 'EXPECTED') return 'running'
    return undefined
  }
  const words = all.map((c) => (str(c.conclusion) || str(c.state) || str(c.status)).toUpperCase())
  if (words.some((w) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED'].includes(w))) return 'failed'
  if (words.some((w) => ['CANCELLED'].includes(w))) return 'canceled'
  if (words.some((w) => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING', 'REQUESTED', ''].includes(w))) {
    return 'running'
  }
  return 'success'
}

export function reviewOf(decision: unknown): ReviewState | undefined {
  switch (str(decision).toUpperCase()) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes-requested'
    case 'REVIEW_REQUIRED':
      return 'required'
  }
  return undefined
}

/*
 * People (protocol 2.7.0).
 *
 * A pull request's reviewers are its review requests and its latest review by
 * each person, by login. A login both asked and reviewed has been asked again,
 * so it is `requested`. Only users, bots and mannequins are asked for: a team
 * reviewer needs `read:org`, which a token may not have, and a team is nobody's
 * own role. A pending review is the reviewer's unsent draft and is left out.
 *
 * The review threads are counted only when every one was read (`totalCount`
 * equals what came back): a count of the first hundred would be wrong.
 *
 * The last push is the head commit's `committedDate`; GitHub's `pushedDate` is
 * always null now. A rebase or an amend moves it, which is the push that
 * matters for "ready for another look".
 */

const REVIEW_STATE: Record<string, TrackerReviewer['state']> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes',
  COMMENTED: 'commented',
  DISMISSED: 'commented',
}

/** The reviewers of a pull request: its latest reviews, then its open requests, which win. */
export function reviewersOf(requests: unknown, reviews: unknown): TrackerReviewer[] {
  const out = new Map<string, TrackerReviewer>()
  const put = (person: Record<string, unknown>, state: TrackerReviewer['state']) => {
    const who = login(person)
    if (!who) return
    const name = clip(str(person.name).trim(), LIMITS.TRACKER_PERSON)
    out.set(who.toLowerCase(), { login: who, ...(name ? { name } : {}), state })
  }
  for (const review of nodes(reviews).map(obj)) {
    const state = REVIEW_STATE[str(review.state).toUpperCase()]
    if (state) put(obj(review.author), state)
  }
  const asked = nodes(requests).map((one) => obj(obj(one).requestedReviewer))
  for (const person of asked) {
    const key = login(person).toLowerCase()
    /* Asked again after reviewing: asked, and first, since that is the news. */
    if (key) out.delete(key)
  }
  const reviewed = [...out.values()]
  out.clear()
  for (const person of asked) put(person, 'requested')
  return [...out.values(), ...reviewed].slice(0, LIMITS.REVIEWERS)
}

/** Resolved and unresolved review threads, or nothing when not all of them were read. */
export function discussionsOf(threads: unknown): TrackerDiscussions | undefined {
  const t = obj(threads)
  if (!Array.isArray(t.nodes) && !Array.isArray(threads)) return undefined
  const all = nodes(threads).map(obj)
  if (typeof t.totalCount === 'number' && t.totalCount !== all.length) return undefined
  const resolved = all.filter((one) => one.isResolved === true).length
  return { resolved, unresolved: all.length - resolved }
}

/** One issue, from `gh issue list --json` or GraphQL — the two spell these fields the same. */
export function issueRow(source: Source, raw: unknown, now: string): TrackerRow | null {
  const r = obj(raw)
  const number = r.number
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null
  const ref = spell(source, 'issue', number)
  if (!ref) return null
  const state = str(r.state).toUpperCase() === 'OPEN' ? 'open' : str(r.state).toUpperCase() === 'CLOSED' ? 'closed' : null
  if (!state) return null
  const closers = nodes(r.closedByPullRequestsReferences).map(obj)
  const links = closers
    .map((pr) => (typeof pr.number === 'number' ? spell(source, 'change', pr.number) : null))
    .filter((one): one is string => one !== null)
    .slice(0, LIMITS.TRACKER_LINKS)
    .map((one) => ({ ref: one, relation: 'closed-by' as const }))
  return row({
    ref,
    tracker: 'github',
    host: source.host,
    repo: source.repo,
    number,
    kind: 'issue',
    state,
    title: clip(str(r.title), LIMITS.TITLE),
    url: clip(str(r.url), LIMITS.URL),
    /* Only when there is one. An open issue answers "" or null, and a reason
       written as an empty string would be one somebody has to read past. */
    stateReason: str(r.stateReason) ? clip(str(r.stateReason).toUpperCase(), LIMITS.TRACKER_WORD) : undefined,
    closedByMerge: closers.length ? closers.some((pr) => pr.merged === true) : undefined,
    labels: labelsOf(r.labels),
    assignees: people(r.assignees),
    author: who(r.author) || undefined,
    authorLogin: login(r.author) || undefined,
    assigneeLogins: logins(r.assignees),
    createdAt: instant(r.createdAt) ?? undefined,
    updatedAt: instant(r.updatedAt) ?? undefined,
    closedAt: state === 'open' ? null : (instant(r.closedAt) ?? undefined),
    links,
    ...placed(r.projectItems),
    readAt: now,
  })
}

/** One pull request, from `gh pr list --json` or GraphQL. */
export function pullRow(source: Source, raw: unknown, now: string): TrackerRow | null {
  const r = obj(raw)
  const number = r.number
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null
  const ref = spell(source, 'change', number)
  if (!ref) return null
  const word = str(r.state).toUpperCase()
  const state = word === 'OPEN' ? 'open' : word === 'MERGED' ? 'merged' : word === 'CLOSED' ? 'closed' : null
  if (!state) return null
  const links = nodes(r.closingIssuesReferences)
    .map(obj)
    .map((issue) => (typeof issue.number === 'number' ? spell(source, 'issue', issue.number) : null))
    .filter((one): one is string => one !== null)
    .slice(0, LIMITS.TRACKER_LINKS)
    .map((one) => ({ ref: one, relation: 'closes' as const }))
  /* GraphQL hangs the rollup off the last commit; the list hands it over flat. */
  const head = obj(obj(nodes(obj(r.commits))[0]).commit)
  const rollup = r.statusCheckRollup ?? head.statusCheckRollup
  const read = (field: string) => Object.prototype.hasOwnProperty.call(r, field)
  return row({
    ref,
    tracker: 'github',
    host: source.host,
    repo: source.repo,
    number,
    kind: 'change',
    state,
    title: clip(str(r.title), LIMITS.TITLE),
    url: clip(str(r.url), LIMITS.URL),
    draft: typeof r.isDraft === 'boolean' ? r.isDraft : undefined,
    labels: labelsOf(r.labels),
    assignees: people(r.assignees),
    author: who(r.author) || undefined,
    authorLogin: login(r.author) || undefined,
    assigneeLogins: logins(r.assignees),
    createdAt: instant(r.createdAt) ?? undefined,
    updatedAt: instant(r.updatedAt) ?? undefined,
    closedAt: state === 'open' ? null : (instant(r.closedAt) ?? undefined),
    mergedAt: state === 'merged' ? (instant(r.mergedAt) ?? undefined) : null,
    links,
    pipeline: rollup === undefined || rollup === null ? undefined : pipelineOf(rollup),
    review: reviewOf(r.reviewDecision),
    /* Absent when the answer did not carry them, which is not the same as nobody. */
    reviewers: read('reviewRequests') || read('latestReviews') ? reviewersOf(r.reviewRequests, r.latestReviews) : undefined,
    discussions: read('reviewThreads') ? discussionsOf(r.reviewThreads) : undefined,
    lastPushAt: instant(head.committedDate) ?? undefined,
    ...placed(r.projectItems),
    readAt: now,
  })
}

/**
 * Give each issue the changes that say they close it, from the changes in the
 * same reading — the listing hands over a pull request's closing references and
 * not an issue's closers.
 */
export function linkClosers(rows: TrackerRow[]): TrackerRow[] {
  const closers = new Map<string, TrackerRow[]>()
  for (const one of rows) {
    if (one.kind !== 'change') continue
    for (const link of one.links) {
      if (link.relation !== 'closes') continue
      closers.set(link.ref, [...(closers.get(link.ref) ?? []), one])
    }
  }
  return rows.map((one) => {
    const by = one.kind === 'issue' ? closers.get(one.ref) : undefined
    if (!by?.length) return one
    const known = new Set(one.links.map((l) => l.ref))
    const links = [
      ...one.links,
      ...by.filter((c) => !known.has(c.ref)).map((c) => ({ ref: c.ref, relation: 'closed-by' as const })),
    ].slice(0, LIMITS.TRACKER_LINKS)
    return { ...one, links, closedByMerge: one.closedByMerge || by.some((c) => c.state === 'merged') }
  })
}

/** What a person is told, once, when GitHub would not show the boards. */
export const NEEDS_PROJECT_SCOPE = 'Board columns need `gh auth refresh -s read:project`.'

/** How long a host's refusal of `read:project` is believed before the boards are asked for again. */
export const SCOPE_RECHECK_MS = 30 * 60_000

const SINGLE_SELECT = '... on ProjectV2SingleSelectField { name options { name } }'

/** An item's place on every project it is on. See "Board columns" above. */
const PROJECT_ITEMS = `projectItems(first: 10) { nodes { isArchived
      project { title url closed status: field(name: "Status") { ${SINGLE_SELECT} } }
      status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      fieldValues(first: 20) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ${SINGLE_SELECT} } } } } } }`

const optionsOf = (field: unknown): string[] =>
  list(obj(field).options)
    .map((o) => clip(str(obj(o).name), LIMITS.TRACKER_LABEL))
    .filter(Boolean)
    .slice(0, LIMITS.TRACKER_COLUMNS)

/** The boards one item is on, with its column on each where it has one. */
export function boardsOf(projectItems: unknown): Array<{ board: TrackerBoard; column: TrackerColumn | null }> {
  const out: Array<{ board: TrackerBoard; column: TrackerColumn | null }> = []
  for (const item of nodes(projectItems).map(obj)) {
    if (item.isArchived === true) continue
    const project = obj(item.project)
    const title = clip(str(project.title).trim(), LIMITS.TITLE)
    if (!title || project.closed === true) continue
    const url = str(project.url)
    const at = url && url.length <= LIMITS.URL ? { boardUrl: url } : {}
    const statusField = obj(project.status)
    let name: string
    let columns: string[]
    if (str(statusField.name)) {
      /* The project has a Status: that is the board's column, valued or not. */
      name = str(obj(item.status).name)
      columns = optionsOf(statusField)
    } else {
      const first = nodes(item.fieldValues).map(obj).find((v) => str(v.name) && str(obj(v.field).name))
      name = first ? str(first.name) : ''
      columns = first ? optionsOf(first.field) : []
    }
    const column = name ? { name: clip(name, LIMITS.TRACKER_LABEL), board: title, ...at } : null
    out.push({ board: { board: title, ...at, columns }, column })
  }
  return out.slice(0, LIMITS.TRACKER_BOARDS)
}

/** `column`, and `columns` when there is more than one, for a row; nothing when it is on no board. */
export function placed(projectItems: unknown): { column?: TrackerColumn; columns?: TrackerColumn[] } {
  const columns = boardsOf(projectItems)
    .map((one) => one.column)
    .filter((one): one is TrackerColumn => one !== null)
  if (!columns.length) return {}
  return columns.length > 1 ? { column: columns[0], columns } : { column: columns[0] }
}

/** Every board the items of one answer are on, each once, by title and link. */
export function boardsSeen(items: readonly unknown[]): TrackerBoard[] {
  const out = new Map<string, TrackerBoard>()
  for (const raw of items) {
    for (const { board } of boardsOf(obj(raw).projectItems)) {
      const key = `${board.board}|${board.boardUrl ?? ''}`
      const was = out.get(key)
      if (!was || (!was.columns.length && board.columns.length)) out.set(key, board)
    }
  }
  return [...out.values()].slice(0, LIMITS.TRACKER_BOARDS)
}

const ISSUE_GRAPH = (boards: boolean) => `number state stateReason title url createdAt updatedAt closedAt
    author { login } labels(first: 32) { nodes { name } } assignees(first: 16) { nodes { login name } }
    closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number merged } }${boards ? `\n    ${PROJECT_ITEMS}` : ''}`
/** A pull request's people: see "People" above. Users, bots and mannequins; never a team (`read:org`). */
const PEOPLE = `reviewRequests(first: 32) { nodes { requestedReviewer { ... on User { login name } ... on Bot { login } ... on Mannequin { login } } } }
    latestReviews(first: 32) { nodes { state author { login ... on User { name } } } }
    reviewThreads(first: 100) { totalCount nodes { isResolved } }`
const PULL_GRAPH = (boards: boolean) => `number state title url createdAt updatedAt closedAt mergedAt isDraft reviewDecision
    author { login } labels(first: 32) { nodes { name } } assignees(first: 16) { nodes { login name } }
    closingIssuesReferences(first: 10) { nodes { number } }
    commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
    ${PEOPLE}${boards ? `\n    ${PROJECT_ITEMS}` : ''}`

const repository = (source: Source) => {
  const [owner, name] = source.repo.split('/')
  return `repository(owner: "${owner}", name: "${name}")`
}

/**
 * The GraphQL for a batch of numbers, with each item's boards unless `boards`
 * is false. Owner and name passed `NAME` in `sources.ts`, so they cannot leave
 * the string.
 */
export function refsQuery(source: Source, numbers: readonly number[], boards = true): string {
  const asked = numbers
    .map((n) => `n${n}: issueOrPullRequest(number: ${n}) { __typename
  ... on Issue { ${ISSUE_GRAPH(boards)} }
  ... on PullRequest { ${PULL_GRAPH(boards)} } }`)
    .join('\n')
  return `query { ${repository(source)} {\n${asked}\n} }`
}

/** A cursor GitHub handed back, checked before it goes into a query: base64 and nothing else. */
const CURSOR = /^[A-Za-z0-9+/=:_-]{1,200}$/

/**
 * One page of a listing: up to a hundred issues and a hundred pull requests,
 * newest created first, after the cursors given. `null` asks for the first
 * page; `false` leaves that half out (it has run out or is not wanted).
 */
export function listQuery(
  source: Source,
  after: { issues: string | null | false; pulls: string | null | false },
  boards = true,
  size = 100,
): string {
  const page = (cursor: string | null) =>
    `first: ${size}${cursor ? `, after: "${cursor}"` : ''}, orderBy: { field: CREATED_AT, direction: DESC }`
  const parts: string[] = []
  if (after.issues !== false) {
    parts.push(`issues(${page(after.issues)}) { pageInfo { hasNextPage endCursor } nodes { ${ISSUE_GRAPH(boards)} } }`)
  }
  if (after.pulls !== false) {
    parts.push(`pullRequests(${page(after.pulls)}) { pageInfo { hasNextPage endCursor } nodes { ${PULL_GRAPH(boards)} } }`)
  }
  return `query { ${repository(source)} {\n${parts.join('\n')}\n} }`
}

/** GitHub refusing a query for a scope the token lacks — here, only ever `read:project`. */
export function lacksProjectScope(answer: unknown, ran: { err: string; out: string }): boolean {
  const errors = list(obj(answer).errors).map(obj)
  if (errors.some((e) => str(e.type) === 'INSUFFICIENT_SCOPES')) return true
  return /read:project/.test(`${ran.err}\n${ran.out}`) && !Object.keys(obj(obj(answer).data)).length
}

export function githubAdapter(run: Runner, clock: () => number = Date.now): Adapter {
  const gh = (args: string[], source: Source) =>
    run(['gh', ...args], { timeout: 30_000 }).then((ran) => ({ ran, source }))
  /** Hosts that refused `read:project`, until when that is believed. */
  const noScope = new Map<string, number>()

  /**
   * One GraphQL query, with the boards when the host is believed to show them,
   * and again without them when it refuses the scope. Says which it got.
   */
  async function graph(source: Source, build: (boards: boolean) => string) {
    const call = (query: string) => {
      const args = ['api', 'graphql', '-f', `query=${query}`]
      if (source.host !== 'github.com') args.push('--hostname', source.host)
      return gh(args, source).then(({ ran }) => ({ ran, answer: parsed(ran) }))
    }
    const believed = noScope.get(source.host)
    if (believed === undefined || clock() >= believed) {
      const first = await call(build(true))
      if (!lacksProjectScope(first.answer, first.ran)) {
        noScope.delete(source.host)
        return { ...first, boards: true }
      }
      noScope.set(source.host, clock() + SCOPE_RECHECK_MS)
    }
    return { ...(await call(build(false))), boards: false }
  }

  const boardsRead = (boards: boolean, items: readonly unknown[]): BoardsRead =>
    boards ? { boards: boardsSeen(items) } : { unreadable: NEEDS_PROJECT_SCOPE }

  return {
    async me(host): Promise<Me> {
      const args = ['gh', 'api', 'user']
      if (host !== 'github.com') args.push('--hostname', host)
      const ran = await run(args, { timeout: 30_000 })
      const who = ran.code === 0 ? login(parsed(ran)) : ''
      if (who) return { login: who }
      return { why: ran.code === 0 ? `gh did not say who is logged in to ${host}.` : trouble(ran, 'gh', host) }
    },

    async list(source, limit, now): Promise<Read> {
      if (source.repo.split('/').length !== 2) {
        return { ok: false, why: `${source.repo} is not an owner/repo name GitHub can have.` }
      }
      const issues: unknown[] = []
      const pulls: unknown[] = []
      let after: { issues: string | null | false; pulls: string | null | false } = { issues: null, pulls: null }
      let boards = true
      while (after.issues !== false || after.pulls !== false) {
        const got = await graph(source, (b) => listQuery(source, after, b))
        boards &&= got.boards
        const repo = obj(obj(obj(got.answer).data).repository)
        if (!Object.keys(repo).length) {
          if (got.ran.code === 0 && obj(got.answer).data) {
            return { ok: false, why: 'gh answered with something that is not a listing. A version of gh answering GraphQL differently.' }
          }
          return { ok: false, why: trouble(got.ran, 'gh', source.host) }
        }
        const next = (half: 'issues' | 'pullRequests', into: unknown[], was: string | null | false): string | null | false => {
          if (was === false) return false
          const connection = obj(repo[half])
          into.push(...nodes(connection))
          const info = obj(connection.pageInfo)
          const cursor = str(info.endCursor)
          return info.hasNextPage === true && into.length < limit && CURSOR.test(cursor) ? cursor : false
        }
        after = { issues: next('issues', issues, after.issues), pulls: next('pullRequests', pulls, after.pulls) }
      }
      const items = [...issues.slice(0, limit), ...pulls.slice(0, limit)]
      const rows = [
        ...issues.slice(0, limit).map((one) => issueRow(source, one, now)),
        ...pulls.slice(0, limit).map((one) => pullRow(source, one, now)),
      ].filter((one): one is TrackerRow => one !== null)
      return { ok: true, rows: linkClosers(rows), notFound: [], boards: boardsRead(boards, items) }
    },

    async refs(source, wanted, now): Promise<Read> {
      if (source.repo.split('/').length !== 2) {
        return { ok: false, why: `${source.repo} is not an owner/repo name GitHub can have.` }
      }
      const numbers = [...new Set(wanted.map((w) => w.number))]
      const rows: TrackerRow[] = []
      const items: unknown[] = []
      const notFound: Array<{ number: number; kind: null }> = []
      let boards = true
      for (const group of chunks(numbers, 50)) {
        const got = await graph(source, (b) => refsQuery(source, group, b))
        boards &&= got.boards
        const data = obj(obj(obj(got.answer).data).repository)
        /* Partly found is still an answer: GraphQL says NOT_FOUND for a
           number that does not exist and exits 1 with the rest in `data`. */
        if (!Object.keys(data).length) return { ok: false, why: trouble(got.ran, 'gh', source.host) }
        for (const n of group) {
          const node = data[`n${n}`]
          if (node === null || node === undefined) {
            notFound.push({ number: n, kind: null })
            continue
          }
          items.push(node)
          const made = str(obj(node).__typename) === 'PullRequest' ? pullRow(source, node, now) : issueRow(source, node, now)
          if (made) rows.push(made)
        }
      }
      return { ok: true, rows, notFound, boards: boardsRead(boards, items) }
    },

    async detail(source, rows, now) {
      const out = new Map<string, TrackerDetailFacts>()
      for (const one of rows) {
        const args =
          one.kind === 'change'
            ? ['pr', 'view', String(one.number), '--repo', repoArg(source), '--json', 'body,files,headRefOid,latestReviews']
            : ['issue', 'view', String(one.number), '--repo', repoArg(source), '--json', 'body']
        const { ran } = await gh(args, source)
        if (ran.code !== 0) return { why: trouble(ran, 'gh', source.host) }
        const r = obj(parsed(ran))
        const body = str(r.body)
        const files = list(r.files).map(obj)
        out.set(one.ref, {
          body: clip(body, LIMITS.TRACKER_BODY),
          bodyClipped: body.length > LIMITS.TRACKER_BODY,
          files: files
            .slice(0, LIMITS.TRACKER_FILES)
            .filter((f) => str(f.path))
            .map((f) => ({
              path: clip(str(f.path), LIMITS.PATH),
              ...(typeof f.additions === 'number' ? { additions: f.additions } : {}),
              ...(typeof f.deletions === 'number' ? { deletions: f.deletions } : {}),
            })),
          filesClipped: files.length > LIMITS.TRACKER_FILES,
          ...(one.kind === 'change'
            ? {
                headSha: str(r.headRefOid) ? clip(str(r.headRefOid), LIMITS.TRACKER_WORD) : null,
                approvedBy: list(r.latestReviews)
                  .map(obj)
                  .filter((review) => str(review.state).toUpperCase() === 'APPROVED')
                  .map((review) => who(review.author))
                  .filter(Boolean)
                  .slice(0, LIMITS.TRACKER_PEOPLE),
              }
            : {}),
          readAt: now,
        })
      }
      return out
    },
  }
}
