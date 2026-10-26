import {
  LIMITS,
  WORK_ITEM_TYPES,
  type LastActivityKind,
  type PipelineState,
  type TrackerActivity,
  type TrackerColumn,
  type TrackerDetailFacts,
  type TrackerDiscussions,
  type TrackerReviewer,
  type TrackerRow,
  type WorkItemType,
} from 'kehikot-module-protocol'

import type { Runner } from '../feedback.ts'
import {
  chunks,
  clip,
  closingIssues,
  contributedIssues,
  contributesOf,
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
  withContributors,
  withPeople,
  type Adapter,
  type BoardsRead,
  type HeldBoard,
  type Me,
  type Read,
} from './common.ts'
import type { Source } from './sources.ts'

/**
 * GitLab, through `glab api`, on any host — gitlab.com or a self-hosted one.
 *
 * Written against a real self-hosted GitLab, where it
 * solved this against a real self-hosted GitLab: batched GraphQL by `iids`,
 * chunked at twenty-five so one refusal costs one batch, and — the part that matters
 * most — which merge request delivers which issue decided by the merge
 * request's OWN description ("Closes #2274"), never by GitLab's related-MR list,
 * which attaches a merge request to any issue it so much as mentions.
 *
 * The listing is REST, newest first, a page of a hundred at a time; the open
 * merge requests in it are then read once more by GraphQL for their pipeline
 * and approval, which the REST list does not carry.
 */

/**
 * The issues a merge request's description says it closes: GitLab's own
 * closing keywords. "Part of" and "implements" are not among them since
 * protocol 2.26.0 (Jalez/kehikko#187): they say the merge request is one part
 * of the issue, and go in `contributes` (`contributedIssues` in `common.ts`).
 */
export const declaredIssues = closingIssues
export { contributedIssues }

/** GitLab's pipeline status, in either case, as one of the protocol's words. */
export function pipelineOf(status: unknown): PipelineState | undefined {
  const word = str(status).toLowerCase()
  if (!word) return undefined
  if (word === 'success' || word === 'failed' || word === 'running' || word === 'canceled' || word === 'skipped' || word === 'manual') {
    return word
  }
  if (word === 'cancelled') return 'canceled'
  /* created, waiting_for_resource, preparing, pending, scheduled: not started. */
  return 'pending'
}

const numberOf = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(str(v))
  return Number.isInteger(n) && n > 0 ? n : null
}

/*
 * People (protocol 2.7.0).
 *
 * A merge request's reviewers come with their own interaction with it:
 * approved, or GitLab's `reviewState` (requested changes, reviewed, not yet).
 * Somebody who approved without being asked to review is listed as approved
 * too. Discussions are GitLab's own resolvable and resolved counts. The last
 * push is the later of the newest commit's time and the head pipeline's
 * creation — a pipeline is made by a push, and a commit made yesterday and
 * pushed today says yesterday.
 *
 * These are asked by GraphQL, so the REST listing's closed and merged merge
 * requests carry logins only; the open ones are read again by GraphQL anyway.
 * A GitLab too old to have these fields refuses the whole query ("Field …
 * doesn't exist on type …"): the batch is asked again without them, the
 * refusal is believed for `PEOPLE_RECHECK_MS`, and the read says so once.
 */

/**
 * What a person is told when their GitLab will not say who reviews a merge request, or who acted
 * last. An issue's work item type (protocol 2.11.0) is asked with the people and goes with them.
 */
export const OLD_GITLAB_PEOPLE = (host: string) =>
  `${host} does not say who reviews a merge request or who acted last (an older GitLab), so My role there shows author and assignee only and no last activity, and a task there reads as an issue.`

/** How long a host's refusal of the people fields is believed. */
export const PEOPLE_RECHECK_MS = 30 * 60_000

/** GitLab refusing a field it does not have. */
const NO_FIELD = /Field '[^']+' doesn't exist on type/

const REVIEW_STATE: Record<string, TrackerReviewer['state']> = {
  APPROVED: 'approved',
  REQUESTED_CHANGES: 'changes',
  REVIEWED: 'commented',
}

/** The reviewers of a merge request, and those who approved it without being asked. */
export function reviewersOf(reviewers: unknown, approvedBy: unknown): TrackerReviewer[] {
  const out = new Map<string, TrackerReviewer>()
  const put = (person: Record<string, unknown>, state: TrackerReviewer['state']) => {
    const who = login(person)
    if (!who || out.has(who.toLowerCase())) return
    const name = clip(str(person.name).trim(), LIMITS.TRACKER_PERSON)
    out.set(who.toLowerCase(), { login: who, ...(name ? { name } : {}), state })
  }
  for (const person of nodes(reviewers).map(obj)) {
    const with_ = obj(person.mergeRequestInteraction)
    put(person, with_.approved === true ? 'approved' : (REVIEW_STATE[str(with_.reviewState).toUpperCase()] ?? 'requested'))
  }
  for (const person of nodes(approvedBy).map(obj)) put(person, 'approved')
  return [...out.values()].slice(0, LIMITS.REVIEWERS)
}

/** GitLab's resolvable and resolved discussion counts, or nothing when it did not give both. */
export function discussionsOf(resolvable: unknown, resolved: unknown): TrackerDiscussions | undefined {
  if (typeof resolvable !== 'number' || typeof resolved !== 'number') return undefined
  if (!Number.isInteger(resolvable) || !Number.isInteger(resolved) || resolved < 0 || resolvable < resolved) return undefined
  return { resolved, unresolved: resolvable - resolved }
}

/** The later of the newest commit's time and the head pipeline's creation. */
export function lastPushOf(commits: unknown, pipeline: unknown): string | undefined {
  const times = [instant(obj(nodes(commits)[0]).committedDate), instant(obj(pipeline).createdAt)].filter(
    (t): t is string => t !== null,
  )
  return times.sort().at(-1)
}

/*
 * Branches and last activity (protocol 2.8.0).
 *
 * A merge request's target branch is its `baseBranch` and its source branch
 * its `headBranch` — only when the source project is the target project: a
 * merge request from a fork comes from a branch nothing here can target. Both
 * REST and GraphQL give them.
 *
 * The last activity is read from the newest `NOTES` notes, asked with the
 * people (GraphQL, in the same batch): a comment, or a system note GitLab
 * writes for an approval or requested changes (`review`), pushed commits
 * (`commit`), or a close, reopen or merge (`state`). Every other system note —
 * labels, assignments, mentions, a bot's session — is not somebody acting on
 * the item, and is passed over. When all of the newest `NOTES` are such, the
 * last activity is not known and is left out; when the item has fewer notes
 * than that and none counts, it was last touched when its author opened it.
 */

/** How many of the newest notes are looked through for the last activity. */
export const NOTES = 10

/** What one note says was done, or null for a note that is not somebody acting on the item. */
export function noteKind(note: Record<string, unknown>): LastActivityKind | null {
  if (note.system !== true) return 'comment'
  const body = str(note.body).trim().toLowerCase()
  if (/^(approved this merge request|requested changes)/.test(body)) return 'review'
  if (/^added \d+ (new )?commits?\b/.test(body)) return 'commit'
  if (/^(closed|reopened|merged)\b/.test(body)) return 'state'
  return null
}

/** The last activity from the newest notes, oldest first as GitLab gives them. Undefined when not asked. */
export function activityOf(notes: unknown, author: unknown, createdAt: unknown): TrackerActivity | undefined {
  if (!connection(notes)) return undefined
  const all = nodes(notes).map(obj)
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const kind = noteKind(all[i]!)
    if (!kind) continue
    const by = login(all[i]!.author)
    const at = instant(all[i]!.createdAt)
    return by && at ? { login: by, at, kind } : undefined
  }
  if (all.length >= NOTES) return undefined
  const by = login(author)
  const at = instant(createdAt)
  return by && at ? { login: by, at, kind: 'state' } : undefined
}

/**
 * Every person object an issue or merge request answer carries, REST or
 * GraphQL, for its row's `people` (protocol 2.10.0): author, assignees,
 * reviewers, approvers and the authors of the newest notes. `withPeople` keeps
 * the ones the row names, and makes a relative `avatarUrl` (a picture GitLab
 * stores itself) absolute against the source's host.
 */
export function peopleRead(r: Record<string, unknown>): unknown[] {
  return [
    r.author,
    ...nodes(r.assignees),
    ...nodes(r.reviewers),
    ...nodes(r.approvedBy),
    ...nodes(r.notes).map((note) => obj(note).author),
  ]
}

/*
 * Work item types (protocol 2.11.0).
 *
 * A GitLab issue can be a task, an incident or another work item type. GraphQL
 * says so in `Issue.type` (`TASK`), REST in `issue_type` (`task`) and `type`
 * (`TASK`); `issues(iids:)` and the REST list both return tasks beside plain
 * issues. The type is asked by GraphQL with the people, so a GitLab too old for
 * those is asked without it and its rows have none (`OLD_GITLAB_PEOPLE` says
 * so). A plain issue, and a type outside `WORK_ITEM_TYPES` (a namespace's own),
 * have no `workItem`.
 */

/** An issue's work item type, from GraphQL or REST, or undefined for a plain issue or one not said. */
export function workItemOf(r: Record<string, unknown>): WorkItemType | undefined {
  const word = (str(r.type) || str(r.issue_type)).toLowerCase()
  return (WORK_ITEM_TYPES as readonly string[]).includes(word) ? (word as WorkItemType) : undefined
}

const branchOf = (v: unknown): string | undefined => {
  const b = str(v)
  return b && b.length <= LIMITS.BRANCH ? b : undefined
}

/** One issue, from REST or GraphQL; the two spell most of these differently and both are read. */
export function issueRow(source: Source, raw: unknown, now: string): TrackerRow | null {
  const r = obj(raw)
  const number = numberOf(r.iid)
  if (!number) return null
  const ref = spell(source, 'issue', number)
  if (!ref) return null
  const word = str(r.state).toLowerCase()
  const state = word === 'opened' ? 'open' : word === 'closed' ? 'closed' : null
  if (!state) return null
  return row(withPeople({
    ref,
    tracker: 'gitlab',
    host: source.host,
    repo: source.repo,
    number,
    kind: 'issue',
    workItem: workItemOf(r),
    state,
    title: clip(str(r.title), LIMITS.TITLE),
    url: clip(str(r.web_url) || str(r.webUrl), LIMITS.URL),
    labels: labelsOf(r.labels),
    assignees: people(r.assignees),
    author: who(r.author) || undefined,
    authorLogin: login(r.author) || undefined,
    assigneeLogins: logins(r.assignees),
    createdAt: instant(r.created_at ?? r.createdAt) ?? undefined,
    updatedAt: instant(r.updated_at ?? r.updatedAt) ?? undefined,
    closedAt: state === 'open' ? null : (instant(r.closed_at ?? r.closedAt) ?? undefined),
    links: [],
    lastActivity: activityOf(r.notes, r.author, r.created_at ?? r.createdAt),
    readAt: now,
  }, peopleRead(r), source.host))
}

/** A GraphQL connection (`{ nodes }`), as against REST's plain array. */
const connection = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** One merge request, from REST or GraphQL. */
export function mergeRow(source: Source, raw: unknown, now: string): TrackerRow | null {
  const r = obj(raw)
  const number = numberOf(r.iid)
  if (!number) return null
  const ref = spell(source, 'change', number)
  if (!ref) return null
  const word = str(r.state).toLowerCase()
  /* `locked` is a merge request mid-merge or frozen; it is not merged and not
     closed, so it reads as still open rather than as a guess. */
  const state = word === 'merged' ? 'merged' : word === 'closed' ? 'closed' : word === 'opened' || word === 'locked' ? 'open' : null
  if (!state) return null
  const description = str(r.description)
  const links = declaredIssues(description)
    .map((n) => spell(source, 'issue', n))
    .filter((one): one is string => one !== null)
    .slice(0, LIMITS.TRACKER_LINKS)
    .map((one) => ({ ref: one, relation: 'closes' as const }))
  const contributes = contributesOf(source, contributedIssues(description), links.map((l) => l.ref))
  const pipeline = pipelineOf(obj(r.headPipeline ?? r.head_pipeline).status)
  const approved = typeof r.approved === 'boolean' ? r.approved : undefined
  const draft = typeof r.draft === 'boolean' ? r.draft : typeof r.work_in_progress === 'boolean' ? r.work_in_progress : undefined
  const from = r.sourceProjectId ?? r.source_project_id
  const into = r.targetProjectId ?? r.target_project_id
  const ownBranch = from !== undefined && from !== null && String(from) === String(into)
  return row(withPeople({
    ref,
    tracker: 'gitlab',
    host: source.host,
    repo: source.repo,
    number,
    kind: 'change',
    state,
    title: clip(str(r.title), LIMITS.TITLE),
    url: clip(str(r.web_url) || str(r.webUrl), LIMITS.URL),
    draft,
    labels: labelsOf(r.labels),
    assignees: people(r.assignees),
    author: who(r.author) || undefined,
    authorLogin: login(r.author) || undefined,
    assigneeLogins: logins(r.assignees),
    createdAt: instant(r.created_at ?? r.createdAt) ?? undefined,
    updatedAt: instant(r.updated_at ?? r.updatedAt) ?? undefined,
    closedAt: state === 'open' ? null : (instant(r.closed_at ?? r.closedAt) ?? undefined),
    mergedAt: state === 'merged' ? (instant(r.merged_at ?? r.mergedAt) ?? undefined) : null,
    links,
    contributes,
    pipeline,
    /* GraphQL only (see "People" above): the REST list's `reviewers` say nobody's state. */
    reviewers: connection(r.reviewers) || connection(r.approvedBy) ? reviewersOf(r.reviewers, r.approvedBy) : undefined,
    discussions: discussionsOf(r.resolvableDiscussionsCount, r.resolvedDiscussionsCount),
    lastPushAt: lastPushOf(r.commits, r.headPipeline),
    baseBranch: branchOf(r.targetBranch ?? r.target_branch),
    headBranch: ownBranch ? branchOf(r.sourceBranch ?? r.source_branch) : undefined,
    lastActivity: activityOf(r.notes, r.author, r.created_at ?? r.createdAt),
    /* Only while open, as prior art does: an approval on a merged request is
       history, not a state of review. */
    review: state === 'open' && approved !== undefined ? (approved ? 'approved' : 'required') : undefined,
    readAt: now,
  }, peopleRead(r), source.host))
}

/**
 * Give each issue the merge requests that declare it, and say it was closed by
 * a merge when one of them merged. A GitLab issue has no close reason, so this
 * is the only way `deriveDisposition` can call one done. The merge requests
 * that are only part of it go in its `contributedBy`, and never make it
 * `closedByMerge` (protocol 2.26.0).
 */
export function linkDeclarers(rows: TrackerRow[]): TrackerRow[] {
  return withContributors(closedByDeclarers(rows))
}

function closedByDeclarers(rows: TrackerRow[]): TrackerRow[] {
  const by = new Map<string, TrackerRow[]>()
  for (const one of rows) {
    if (one.kind !== 'change') continue
    for (const link of one.links) {
      if (link.relation === 'closes') by.set(link.ref, [...(by.get(link.ref) ?? []), one])
    }
  }
  return rows.map((one) => {
    const declarers = one.kind === 'issue' ? by.get(one.ref) : undefined
    if (!declarers?.length) return one
    const known = new Set(one.links.map((l) => l.ref))
    return {
      ...one,
      links: [
        ...one.links,
        ...declarers.filter((d) => !known.has(d.ref)).map((d) => ({ ref: d.ref, relation: 'closed-by' as const })),
      ].slice(0, LIMITS.TRACKER_LINKS),
      /* True when one merged. Never false from this alone: a merge request
         outside what was read may be the one that closed it. */
      ...(declarers.some((d) => d.state === 'merged') ? { closedByMerge: true } : {}),
    }
  })
}

/**
 * Labels, assignees and author; with the people, each person's picture too
 * (protocol 2.10.0). Asked without pictures of a GitLab too old for the people
 * fields, so that its query is the one it always was.
 */
const GRAPH_PEOPLE = (people: boolean) => {
  const face = people ? ' avatarUrl' : ''
  return `labels { nodes { title } } assignees { nodes { name username${face} } } author { name username${face} }`
}

/** The newest notes, for the last activity: see "Branches and last activity" above. */
const NOTES_GRAPH = `notes(last: ${NOTES}) { nodes { system body createdAt author { username avatarUrl } } }`

/** A merge request's reviewers, approvers, discussions, newest commit and notes: see "People" above. */
const MERGE_PEOPLE = `reviewers(first: 32) { nodes { username name avatarUrl mergeRequestInteraction { approved reviewState } } }
      approvedBy(first: 32) { nodes { username name avatarUrl } }
      resolvableDiscussionsCount resolvedDiscussionsCount
      commits(first: 1) { nodes { committedDate } }
      ${NOTES_GRAPH}`

/**
 * GraphQL for issues and merge requests by iid. The path passed `NAME` in `sources.ts`.
 *
 * Every connection carries `first:` equal to its iid count. GitLab costs a
 * query statically and, without `first:`, assumes a page of a hundred and
 * multiplies the nested fields by it — 397 for even one issue and one merge
 * request, against a limit of 250 (Jalez/kehikko#28).
 */
export function refsQuery(source: Source, issues: readonly number[], merges: readonly number[], people = true): string {
  const parts: string[] = []
  if (issues.length) {
    parts.push(`issues(iids: [${issues.map((n) => `"${n}"`).join(',')}], first: ${issues.length}) { nodes {
      iid state title webUrl${people ? ' type' : ''} createdAt updatedAt closedAt ${GRAPH_PEOPLE(people)}${people ? ` ${NOTES_GRAPH}` : ''} } }`)
  }
  if (merges.length) {
    parts.push(`mergeRequests(iids: [${merges.map((n) => `"${n}"`).join(',')}], first: ${merges.length}) { nodes {
      iid state title webUrl draft createdAt updatedAt closedAt mergedAt description approved
      sourceBranch targetBranch sourceProjectId targetProjectId
      headPipeline { status${people ? ' createdAt' : ''} } ${GRAPH_PEOPLE(people)}${people ? `\n      ${MERGE_PEOPLE}` : ''} } }`)
  }
  return `query { project(fullPath: "${source.repo}") {\n${parts.join('\n')}\n} }`
}

/** As `refsQuery`: `first:` on every connection, for the same reason. */
export function detailQuery(source: Source, issues: readonly number[], merges: readonly number[]): string {
  const parts: string[] = []
  if (issues.length) parts.push(`issues(iids: [${issues.map((n) => `"${n}"`).join(',')}], first: ${issues.length}) { nodes { iid description } }`)
  if (merges.length) {
    parts.push(`mergeRequests(iids: [${merges.map((n) => `"${n}"`).join(',')}], first: ${merges.length}) { nodes {
      iid description diffHeadSha diffStats { path additions deletions } approvedBy { nodes { name username } } } }`)
  }
  return `query { project(fullPath: "${source.repo}") {\n${parts.join('\n')}\n} }`
}

/*
 * Board columns.
 *
 * A GitLab issue board is lists, each a label; an issue is in the list whose
 * label it carries, scoped labels (`workflow::doing`) included — GitLab lets an
 * issue carry one label per scope, so a scoped board has one answer. An open
 * issue carrying none of the lists' labels is in the board's Open list, and a
 * closed issue is in its Closed list, whatever its labels — which is how the
 * board shows them. A board scoped to labels holds only the issues carrying
 * all of them. Lists by assignee, milestone or iteration are not labels and
 * are left out. Merge requests are on no GitLab board.
 *
 * The boards are one REST call per source, on a whole read; an issue's column
 * is worked out from them and its labels wherever the row was read
 * (`columnsOn`), so a ref read by name is placed too.
 */

/** The Open and Closed lists, as GitLab names them on a board. */
export const OPEN_LIST = 'Open'
export const CLOSED_LIST = 'Closed'

/** One board from `GET projects/:id/boards`, as the host keeps it. */
export function boardOf(source: Source, raw: unknown): HeldBoard | null {
  const b = obj(raw)
  const name = clip(str(b.name).trim() || 'Development', LIMITS.TITLE)
  const id = typeof b.id === 'number' ? b.id : null
  const lists = list(b.lists)
    .map(obj)
    .filter((l) => str(obj(l.label).name))
    .sort((x, y) => (Number(x.position) || 0) - (Number(y.position) || 0))
    .map((l) => clip(str(obj(l.label).name), LIMITS.TRACKER_LABEL))
  const open = b.hide_backlog_list !== true
  const closed = b.hide_closed_list !== true
  const url = id === null ? '' : `https://${source.host}/${source.repo}/-/boards/${id}`
  return {
    board: name,
    ...(url && url.length <= LIMITS.URL ? { boardUrl: url } : {}),
    columns: [...(open ? [OPEN_LIST] : []), ...lists, ...(closed ? [CLOSED_LIST] : [])].slice(0, LIMITS.TRACKER_COLUMNS),
    lists,
    scope: labelsOf(b.labels),
    open,
    closed,
  }
}

/** Where one issue stands on one board, or null when the board does not hold it. */
export function columnOn(row: Pick<TrackerRow, 'kind' | 'state' | 'labels'>, board: HeldBoard): TrackerColumn | null {
  if (row.kind !== 'issue') return null
  const labels = new Set(row.labels)
  if ((board.scope ?? []).some((l) => !labels.has(l))) return null
  const at = { board: board.board, ...(board.boardUrl ? { boardUrl: board.boardUrl } : {}) }
  if (row.state !== 'open') return { name: CLOSED_LIST, ...at }
  const list = (board.lists ?? []).find((l) => labels.has(l))
  if (list) return { name: list, ...at }
  return board.open === false ? null : { name: OPEN_LIST, ...at }
}

/** A GitLab row with its column on each board put in afresh, or taken off when it is on none. */
export function columnsOn(row: TrackerRow, boards: readonly HeldBoard[]): TrackerRow {
  const { column: _column, columns: _columns, ...rest } = row
  const placed = boards.map((b) => columnOn(row, b)).filter((c): c is TrackerColumn => c !== null).slice(0, LIMITS.TRACKER_BOARDS)
  if (!placed.length) return rest
  return placed.length > 1 ? { ...rest, column: placed[0], columns: placed } : { ...rest, column: placed[0] }
}

/*
 * Related branches (protocol 2.19.0).
 *
 * GitLab's related branches of an issue are the project's branches named
 * `<iid>-…` — what its "Create branch" names them — leaving out a stable
 * branch (`12-0-stable`), the rule its own `related_branches` applies. That
 * list is one request PER ISSUE, so it is not asked: the source's branch names
 * are listed instead, `BRANCH_PAGES` pages of a hundred on a whole read (as
 * its boards are), and each issue's are worked out from them wherever the
 * row was read (`branchesOn`). A repository with more branches than that has
 * the rest unseen until a branch is deleted.
 */

/** Pages of a hundred branch names read per source on a whole read. */
export const BRANCH_PAGES = 3

/** The branches of an issue among a project's branch names: `<iid>-…`, never `<iid>-<n>-stable`. */
export function relatedBranches(iid: number, names: readonly string[]): string[] {
  const related = new RegExp(`^${iid}-(?!\\d+-stable)`, 'i')
  return names.filter((name) => related.test(name)).slice(0, LIMITS.TRACKER_BRANCHES)
}

/** A branch's page on a GitLab host: `https://<host>/<project>/-/tree/<name>`, each segment encoded. */
export function branchUrl(source: Pick<Source, 'host' | 'repo'>, name: string): string | undefined {
  const url = `https://${source.host}/${source.repo}/-/tree/${name.split('/').map(encodeURIComponent).join('/')}`
  return url.length <= LIMITS.URL ? url : undefined
}

/** A GitLab issue's row with its related branches put in afresh from the source's names. A change is left as it is. */
export function branchesOn(row: TrackerRow, names: readonly string[]): TrackerRow {
  if (row.kind !== 'issue') return row
  return {
    ...row,
    branches: relatedBranches(row.number, names).map((name) => {
      const url = branchUrl(row, name)
      return { name, ...(url ? { url } : {}) }
    }),
  }
}

/** How many pages of a hundred a listing of `limit` takes. */
/**
 * References per GraphQL query: GitLab's complexity grows with it, against a limit of 250 for a
 * logged-in user. Measured on gitlab.com (`queryComplexity { score }`): 242 at 25 + 25 with the
 * people and the notes; the pictures (2.10.0) make that 260, so a batch is 22 + 22, which scores
 * 243 (20 + 20: 232). An issue's `type` (2.11.0) adds 2 whatever the batch: 22 + 22 scores 245.
 * Over the limit, a batch is halved.
 */
export const BATCH = 22

/** GitLab's refusal of a query it costs too high. */
const COMPLEXITY = /Query has complexity of \d+, which exceeds max complexity of \d+/

const pagesFor = (limit: number) => Math.max(1, Math.ceil(limit / 100))

export function gitlabAdapter(run: Runner, clock: () => number = Date.now): Adapter {
  const glab = (args: string[], source: Source) =>
    run(['glab', 'api', '--hostname', source.host, ...args], { timeout: 30_000 })
  const graph = (query: string, source: Source) => glab(['graphql', '-f', `query=${query}`], source)
  const project = (source: Source) => `projects/${encodeURIComponent(source.repo)}`
  /** Hosts that refused the people fields, until when that is believed. */
  const noPeople = new Map<string, number>()
  const peopleAsked = (host: string) => {
    const until = noPeople.get(host)
    return until === undefined || clock() >= until
  }

  /** One REST collection, newest first, page by page until it runs out or reaches `limit`. */
  async function pages(source: Source, what: 'issues' | 'merge_requests', limit: number): Promise<unknown[] | string> {
    const out: unknown[] = []
    for (let page = 1; page <= pagesFor(limit); page += 1) {
      const ran = await glab(
        [`${project(source)}/${what}?state=all&order_by=updated_at&sort=desc&per_page=100&page=${page}`],
        source,
      )
      if (ran.code !== 0) return trouble(ran, 'glab', source.host)
      const got = parsed(ran)
      if (!Array.isArray(got)) return `${source.host} answered with something that is not a list.`
      out.push(...got)
      if (got.length < 100) break
    }
    return out.slice(0, limit)
  }

  /**
   * Read these iids by GraphQL, `BATCH` at a time. A batch GitLab refuses costs
   * only that batch: the rows of the others are kept, and the refused refs are
   * handed back as `unread` with GitLab's own words, so the source's error and
   * those refs' `failed` say what happened without discarding the good rows.
   * A complexity refusal ("Query has complexity of N, which exceeds max
   * complexity of M") is retried with the batch halved, down to one reference;
   * only then is that batch given up.
   */
  async function byIids(source: Source, issues: number[], merges: number[], now: string): Promise<Read> {
    const rows: TrackerRow[] = []
    const seenIssues = new Set<number>()
    const seenMerges = new Set<number>()
    const unread: Array<{ number: number; kind: 'issue' | 'change' }> = []
    let why = ''
    let withoutPeople = false

    const take = (data: Record<string, unknown>) => {
      for (const node of nodes(data.issues)) {
        const made = issueRow(source, node, now)
        if (made) {
          rows.push(made)
          seenIssues.add(made.number)
        }
      }
      for (const node of nodes(data.mergeRequests)) {
        const made = mergeRow(source, node, now)
        if (made) {
          rows.push(made)
          seenMerges.add(made.number)
        }
      }
    }

    /** One batch; on a complexity refusal, its two halves. */
    async function batch(i: number[], m: number[]): Promise<void> {
      const people = peopleAsked(source.host)
      if (!people) withoutPeople = true
      const ran = await graph(refsQuery(source, i, m, people), source)
      const answer = obj(parsed(ran))
      const data = obj(obj(answer.data).project)
      if (Object.keys(data).length) return take(data)
      const first = list(answer.errors).length ? clip(str(obj(list(answer.errors)[0]).message), LIMITS.REASON) : ''
      if (people && NO_FIELD.test(`${first} ${ran.err} ${ran.out}`)) {
        /* An older GitLab: the same batch without the people fields. */
        noPeople.set(source.host, clock() + PEOPLE_RECHECK_MS)
        return batch(i, m)
      }
      const refusal = COMPLEXITY.test(`${first} ${ran.err} ${ran.out}`)
      const size = i.length + m.length
      if (refusal && size > 1) {
        const half = Math.ceil(size / 2)
        const items = [...i.map((number) => ({ number, kind: 'issue' as const })), ...m.map((number) => ({ number, kind: 'change' as const }))]
        for (const part of [items.slice(0, half), items.slice(half)]) {
          await batch(
            part.filter((one) => one.kind === 'issue').map((one) => one.number),
            part.filter((one) => one.kind === 'change').map((one) => one.number),
          )
        }
        return
      }
      if (!why) why = first || trouble(ran, 'glab', source.host)
      unread.push(...i.map((number) => ({ number, kind: 'issue' as const })), ...m.map((number) => ({ number, kind: 'change' as const })))
    }

    const groups = Math.max(Math.ceil(issues.length / BATCH), Math.ceil(merges.length / BATCH))
    for (let g = 0; g < groups; g += 1) {
      await batch(issues.slice(g * BATCH, (g + 1) * BATCH), merges.slice(g * BATCH, (g + 1) * BATCH))
    }
    const cannot = (n: number, kind: 'issue' | 'change') => unread.some((u) => u.number === n && u.kind === kind)
    if (unread.length && !rows.length) return { ok: false, why }
    if (merges.length && !withoutPeople && peopleAsked(source.host)) noPeople.delete(source.host)
    return {
      ok: true,
      rows,
      ...(withoutPeople ? { people: { unreadable: OLD_GITLAB_PEOPLE(source.host) } } : {}),
      notFound: [
        ...issues.filter((n) => !seenIssues.has(n) && !cannot(n, 'issue')).map((number) => ({ number, kind: 'issue' as const })),
        ...merges.filter((n) => !seenMerges.has(n) && !cannot(n, 'change')).map((number) => ({ number, kind: 'change' as const })),
      ],
      ...(unread.length ? { unread: { why: clip(`${why} (${unread.length} of ${issues.length + merges.length} references not read)`, LIMITS.REASON), refs: unread } } : {}),
    }
  }

  return {
    async me(host): Promise<Me> {
      const ran = await run(['glab', 'api', '--hostname', host, 'user'], { timeout: 30_000 })
      const who = ran.code === 0 ? login(parsed(ran)) : ''
      if (who) return { login: who }
      return { why: ran.code === 0 ? `glab did not say who is logged in to ${host}.` : trouble(ran, 'glab', host) }
    },

    async list(source, limit, now): Promise<Read> {
      const [issues, merges] = await Promise.all([pages(source, 'issues', limit), pages(source, 'merge_requests', limit)])
      if (typeof issues === 'string') return { ok: false, why: issues }
      if (typeof merges === 'string') return { ok: false, why: merges }
      const rows = [
        ...issues.map((one) => issueRow(source, one, now)),
        ...merges.map((one) => mergeRow(source, one, now)),
      ].filter((one): one is TrackerRow => one !== null)
      /* The REST list has no pipeline, no approval and no notes; the open
         merge requests are read again, batched, for all three, and the open
         issues beside them in the same queries for their notes (the last
         activity). A failure here keeps the rows and loses only those
         fields — absent, not guessed. */
      const open = rows.filter((one) => one.kind === 'change' && one.state === 'open').map((one) => one.number)
      const openIssues = rows.filter((one) => one.kind === 'issue' && one.state === 'open').map((one) => one.number)
      let people: { unreadable: string } | undefined
      if (open.length || openIssues.length) {
        const again = await byIids(source, openIssues, open, now)
        if (again.ok && again.people) people = again.people
        if (again.ok) {
          const fresh = new Map(again.rows.map((one) => [`${one.kind}:${one.number}`, one]))
          for (let i = 0; i < rows.length; i += 1) {
            const one = rows[i]!
            const got = fresh.get(`${one.kind}:${one.number}`)
            if (got) rows[i] = got
          }
        }
      }
      return { ok: true, rows: linkDeclarers(rows), notFound: [], ...(people ? { people } : {}) }
    },

    async boards(source): Promise<BoardsRead | null> {
      const ran = await glab([`${project(source)}/boards?per_page=100`], source)
      if (ran.code !== 0) return null
      const got = parsed(ran)
      if (!Array.isArray(got)) return null
      return {
        boards: got
          .map((one) => boardOf(source, one))
          .filter((one): one is HeldBoard => one !== null)
          .slice(0, LIMITS.TRACKER_BOARDS),
      }
    },

    async branches(source): Promise<string[] | null> {
      const names: string[] = []
      for (let page = 1; page <= BRANCH_PAGES; page += 1) {
        const ran = await glab([`${project(source)}/repository/branches?per_page=100&page=${page}`], source)
        if (ran.code !== 0) return page === 1 ? null : names
        const got = parsed(ran)
        if (!Array.isArray(got)) return page === 1 ? null : names
        for (const one of got) {
          const name = branchOf(obj(one).name)
          if (name) names.push(name)
        }
        if (got.length < 100) break
      }
      return names
    },

    async refs(source, wanted, now): Promise<Read> {
      const issues = [...new Set(wanted.filter((w) => w.kind !== 'change').map((w) => w.number))]
      const merges = [...new Set(wanted.filter((w) => w.kind === 'change').map((w) => w.number))]
      return byIids(source, issues, merges, now)
    },

    async detail(source, rows, now) {
      const out = new Map<string, TrackerDetailFacts>()
      for (const group of chunks(rows, 25)) {
        const issues = group.filter((r) => r.kind === 'issue').map((r) => r.number)
        const merges = group.filter((r) => r.kind === 'change').map((r) => r.number)
        const ran = await graph(detailQuery(source, issues, merges), source)
        const data = obj(obj(obj(parsed(ran)).data).project)
        if (!Object.keys(data).length) return { why: trouble(ran, 'glab', source.host) }
        const found = new Map<string, Record<string, unknown>>()
        for (const node of nodes(data.issues)) found.set(`issue:${str(obj(node).iid)}`, obj(node))
        for (const node of nodes(data.mergeRequests)) found.set(`change:${str(obj(node).iid)}`, obj(node))
        for (const one of group) {
          const r = found.get(`${one.kind}:${one.number}`)
          if (!r) continue
          const body = str(r.description)
          const files = nodes(r.diffStats).map(obj)
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
                  headSha: str(r.diffHeadSha) ? clip(str(r.diffHeadSha), LIMITS.TRACKER_WORD) : null,
                  approvedBy: people(r.approvedBy),
                }
              : {}),
            readAt: now,
          })
        }
      }
      return out
    },
  }
}
