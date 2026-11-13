import {
  LIMITS,
  isHttpsUrl,
  type PipelineState,
  type TrackerCheck,
  type TrackerComment,
  type TrackerDetailFacts,
  type TrackerMilestone,
  type TrackerRow,
} from 'kehikot-module-protocol'

import { clip, instant, list, nodes, obj, str } from './common.ts'
import type { Source } from './sources.ts'

/**
 * What a ref's detail carries beside its description (protocol 2.98.0): the milestone, the newest
 * comments and how many there are, a change's checks one by one, and a fork's branch. What a
 * person opens an item FOR, read with their own `gh` / `glab` sign-in, so a module can show one
 * item without loading the tracker's website.
 *
 * Every function here is pure: the adapters call the trackers and hand the answers in. Each field
 * is left out when the answer did not carry it, never guessed, and everything is clipped to the
 * protocol's bounds as it is read.
 */

/** An `https:` URL that fits, or nothing. Nothing else is carried to a page. */
export const httpsOrNothing = (v: unknown): string | undefined => {
  const s = str(v)
  return s && s.length <= LIMITS.URL && isHttpsUrl(s) ? s : undefined
}

/** A calendar date out of a date or an instant, or nothing. */
const dateOf = (v: unknown): string | undefined => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(str(v))
  return m ? m[1] : undefined
}

/** A milestone, from GitHub's `{ title url dueOn }` or GitLab's `{ title webPath|webUrl dueDate }`. */
export function milestoneOf(v: unknown, host: string): TrackerMilestone | undefined {
  const m = obj(v)
  const title = clip(str(m.title), LIMITS.TITLE)
  if (!title) return undefined
  const path = str(m.webPath)
  const url = httpsOrNothing(m.url) ?? httpsOrNothing(m.webUrl) ?? (path.startsWith('/') ? httpsOrNothing(`https://${host}${path}`) : undefined)
  const dueOn = dateOf(m.dueOn ?? m.dueDate)
  return { title, ...(url ? { url } : {}), ...(dueOn ? { dueOn } : {}) }
}

/** The newest comments, oldest first, at most `TRACKER_COMMENTS`; the rest is on the tracker. */
export function newestComments(all: TrackerComment[]): TrackerComment[] {
  const seen = new Set<string>()
  const unique = all.filter((c) => !seen.has(c.id) && (seen.add(c.id), true))
  return unique
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-LIMITS.TRACKER_COMMENTS)
}

interface CommentFields {
  id: unknown
  kind: TrackerComment['kind']
  author: unknown
  at: unknown
  editedAt?: unknown
  body: unknown
  url?: unknown
  path?: unknown
  verdict?: TrackerComment['verdict']
}

/** One comment in the protocol's shape, or null when it has no id or no time. */
export function comment(f: CommentFields): TrackerComment | null {
  const id = clip(String(typeof f.id === 'number' ? f.id : str(f.id)), LIMITS.TRACKER_WORD)
  const at = instant(f.at)
  if (!id || !at) return null
  const a = obj(f.author)
  const login = clip(str(a.login) || str(a.username), LIMITS.TRACKER_PERSON)
  const name = clip(str(a.name), LIMITS.TRACKER_PERSON)
  const body = str(f.body)
  const editedAt = instant(f.editedAt)
  const url = httpsOrNothing(f.url)
  const path = clip(str(f.path), LIMITS.PATH)
  return {
    id,
    kind: f.kind,
    ...(login ? { login } : {}),
    ...(name && name !== login ? { name } : {}),
    at,
    ...(editedAt && editedAt !== at ? { editedAt } : {}),
    body: clip(body, LIMITS.TRACKER_COMMENT),
    bodyClipped: body.length > LIMITS.TRACKER_COMMENT,
    ...(url ? { url } : {}),
    ...(f.kind === 'line' && path ? { path } : {}),
    ...(f.verdict ? { verdict: f.verdict } : {}),
  }
}

const present = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined

/** At most `TRACKER_CHECKS`, saying when there were more. */
function bounded(checks: TrackerCheck[], total: number): Pick<TrackerDetailFacts, 'checks' | 'checksClipped'> {
  return { checks: checks.slice(0, LIMITS.TRACKER_CHECKS), checksClipped: Math.max(total, checks.length) > LIMITS.TRACKER_CHECKS }
}

/* ------------------------------------------------------------------------ *
 * GitHub
 * ------------------------------------------------------------------------ */

const GH_AUTHOR = 'author { login ... on User { name } }'
const GH_COMMENT = `databaseId ${GH_AUTHOR} body createdAt lastEditedAt url`

/**
 * One item's comments, reviews, line comments, milestone, checks and fork, in one GraphQL query.
 * Owner and name passed `NAME` in `sources.ts`; `number` is a positive integer.
 */
export function githubItemQuery(source: Source, number: number): string {
  const [owner, name] = source.repo.split('/')
  const n = LIMITS.TRACKER_COMMENTS
  return `query { repository(owner: "${owner}", name: "${name}") { issueOrPullRequest(number: ${Math.trunc(number)}) { __typename
  ... on Issue { milestone { title url dueOn } comments(last: ${n}) { totalCount nodes { ${GH_COMMENT} } } }
  ... on PullRequest { milestone { title url dueOn } comments(last: ${n}) { totalCount nodes { ${GH_COMMENT} } }
    reviews(last: ${n}) { nodes { databaseId ${GH_AUTHOR} body state submittedAt createdAt lastEditedAt url } }
    reviewThreads(last: 30) { nodes { path comments(last: 10) { totalCount nodes { ${GH_COMMENT} path } } } }
    isCrossRepository headRefName headRepository { nameWithOwner }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: ${LIMITS.TRACKER_CHECKS}) { totalCount nodes { __typename
      ... on CheckRun { name status conclusion detailsUrl startedAt completedAt }
      ... on StatusContext { context state targetUrl createdAt } } } } } } } } } } }`
}

const GH_VERDICT: Record<string, TrackerComment['verdict']> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented' }

/** A GitHub check run's or commit status's state, in the pipeline's words. */
export function githubCheckState(c: Record<string, unknown>): PipelineState {
  const conclusion = str(c.conclusion).toUpperCase()
  if (conclusion) {
    if (conclusion === 'SUCCESS') return 'success'
    if (conclusion === 'CANCELLED') return 'canceled'
    if (['SKIPPED', 'NEUTRAL', 'STALE'].includes(conclusion)) return 'skipped'
    if (conclusion === 'ACTION_REQUIRED') return 'manual'
    return 'failed'
  }
  const status = str(c.status).toUpperCase()
  if (status) return status === 'IN_PROGRESS' ? 'running' : status === 'COMPLETED' ? 'success' : 'pending'
  const state = str(c.state).toUpperCase()
  if (state === 'SUCCESS') return 'success'
  if (state === 'FAILURE' || state === 'ERROR') return 'failed'
  return 'pending'
}

/** What the item query answered, as detail facts. */
export function githubItemFacts(node: unknown, host: string): Partial<TrackerDetailFacts> {
  const r = obj(node)
  if (!Object.keys(r).length) return {}
  const conversation = obj(r.comments)
  const comments: TrackerComment[] = nodes(conversation)
    .map(obj)
    .map((c) => comment({ id: c.databaseId, kind: 'comment', author: c.author, at: c.createdAt, editedAt: c.lastEditedAt, body: c.body, url: c.url }))
    .filter(present)
  let extra = 0
  for (const review of nodes(r.reviews).map(obj)) {
    if (!str(review.body).trim()) continue
    const made = comment({
      id: typeof review.databaseId === 'number' ? `r${review.databaseId}` : null,
      kind: 'review',
      author: review.author,
      at: review.submittedAt ?? review.createdAt,
      editedAt: review.lastEditedAt,
      body: review.body,
      url: review.url,
      verdict: GH_VERDICT[str(review.state).toUpperCase()],
    })
    if (made) {
      comments.push(made)
      extra += 1
    }
  }
  for (const thread of nodes(r.reviewThreads).map(obj)) {
    for (const c of nodes(thread.comments).map(obj)) {
      const made = comment({ id: typeof c.databaseId === 'number' ? `l${c.databaseId}` : null, kind: 'line', author: c.author, at: c.createdAt, editedAt: c.lastEditedAt, body: c.body, url: c.url, path: c.path ?? thread.path })
      if (made) {
        comments.push(made)
        extra += 1
      }
    }
  }
  const out: Partial<TrackerDetailFacts> = { comments: newestComments(comments) }
  /* The conversation's own total, and the reviews and line comments that were read: GitHub counts
     those apart, so this is at least how many there are. */
  if (typeof conversation.totalCount === 'number') out.commentCount = conversation.totalCount + extra
  const milestone = milestoneOf(r.milestone, host)
  if (milestone) out.milestone = milestone
  if (str(r.__typename) === 'PullRequest') {
    const rollup = obj(obj(obj(obj(nodes(obj(r.commits))[0]).commit).statusCheckRollup).contexts)
    const checks: TrackerCheck[] = nodes(rollup)
      .map(obj)
      .map((c): TrackerCheck | null => {
        const name = clip(str(c.name) || str(c.context), LIMITS.TRACKER_LABEL)
        if (!name) return null
        const url = httpsOrNothing(c.detailsUrl) ?? httpsOrNothing(c.targetUrl)
        const at = instant(c.completedAt) ?? instant(c.startedAt) ?? instant(c.createdAt)
        return { name, state: githubCheckState(c), ...(url ? { url } : {}), ...(at ? { at } : {}) }
      })
      .filter(present)
    if (checks.length) Object.assign(out, bounded(checks, typeof rollup.totalCount === 'number' ? rollup.totalCount : checks.length))
    const repo = str(obj(r.headRepository).nameWithOwner)
    const branch = str(r.headRefName)
    if (r.isCrossRepository === true && repo && branch && repo.length <= LIMITS.TRACKER_REPO && branch.length <= LIMITS.BRANCH) {
      out.fork = { repo, branch }
    }
  }
  return out
}

/* ------------------------------------------------------------------------ *
 * GitLab
 * ------------------------------------------------------------------------ */

/** A merge request's or issue's notes, newest first, as REST pages them. */
export const gitlabNotesPath = (project: string, kind: 'issue' | 'change', iid: number) =>
  `${project}/${kind === 'change' ? 'merge_requests' : 'issues'}/${Math.trunc(iid)}/notes?sort=desc&order_by=created_at&per_page=100`

/**
 * The people's notes on an item, newest `TRACKER_COMMENTS`, oldest first. GitLab's system notes
 * ("added 1 commit", "changed the description") are the tracker talking about the item, not
 * people talking on it, and are left out. A note on a line of the diff is a `line` comment.
 */
export function gitlabComments(notes: unknown, itemUrl: string): TrackerComment[] {
  const out: TrackerComment[] = []
  for (const n of list(notes).map(obj)) {
    if (n.system === true) continue
    const id = typeof n.id === 'number' ? n.id : Number(str(n.id))
    if (!Number.isInteger(id) || id <= 0) continue
    const line = str(n.type) === 'DiffNote'
    const position = obj(n.position)
    const made = comment({
      id,
      kind: line ? 'line' : 'comment',
      author: n.author,
      at: n.created_at,
      editedAt: n.last_edited_at,
      body: n.body,
      url: /^https:\/\//.test(itemUrl) ? `${itemUrl}#note_${id}` : undefined,
      path: line ? str(position.new_path) || str(position.old_path) : undefined,
    })
    if (made) out.push(made)
  }
  return newestComments(out)
}

/** A GitLab job's status, in the pipeline's words. */
export function gitlabJobState(status: unknown): PipelineState {
  switch (str(status).toLowerCase()) {
    case 'success':
      return 'success'
    case 'failed':
      return 'failed'
    case 'running':
      return 'running'
    case 'canceled':
    case 'canceling':
      return 'canceled'
    case 'skipped':
      return 'skipped'
    case 'manual':
      return 'manual'
    default:
      /* created, pending, preparing, scheduled, waiting_for_resource */
      return 'pending'
  }
}

/** A head pipeline's jobs, in pipeline order (REST answers newest first). */
export function gitlabChecks(jobs: unknown): Pick<TrackerDetailFacts, 'checks' | 'checksClipped'> | {} {
  const all = list(jobs).map(obj)
  const checks: TrackerCheck[] = all
    .map((j): TrackerCheck | null => {
      const name = clip(str(j.name), LIMITS.TRACKER_LABEL)
      if (!name) return null
      const url = httpsOrNothing(j.web_url)
      const at = instant(j.finished_at) ?? instant(j.started_at) ?? instant(j.created_at)
      const stage = clip(str(j.stage), LIMITS.TRACKER_LABEL)
      return { name, state: gitlabJobState(j.status), ...(url ? { url } : {}), ...(at ? { at } : {}), ...(stage ? { stage } : {}) }
    })
    .filter(present)
    .reverse()
  return checks.length ? bounded(checks, all.length) : {}
}

/* ------------------------------------------------------------------------ *
 * Freshness
 * ------------------------------------------------------------------------ */

const moving = (state: PipelineState | undefined) => state === 'running' || state === 'pending'

/**
 * Whether a detail still answers for its row: nothing it carries has moved since it was read.
 * A comment moves the row's `updatedAt`; a check finishing does not on GitHub, so a change whose
 * pipeline moved since (`pipelineAt`), or whose checks were running when read and are not now
 * (or the reverse), is read again too.
 */
export function detailCurrent(row: TrackerRow, detail: TrackerDetailFacts | undefined = row.detail): detail is TrackerDetailFacts {
  if (!detail) return false
  if (row.updatedAt && detail.readAt < row.updatedAt) return false
  if (row.pipelineAt && detail.readAt < row.pipelineAt) return false
  if (row.kind === 'change' && detail.checks?.length && row.pipeline) {
    if (detail.checks.some((c) => moving(c.state)) !== moving(row.pipeline)) return false
  }
  return true
}

/** The version of a row a detail is read for, so each version is asked once. */
export const detailVersion = (row: TrackerRow) => `${row.updatedAt ?? ''}|${row.pipelineAt ?? ''}|${row.pipeline ?? ''}`
