import { LIMITS, type PipelineState, type ReviewState, type TrackerDetailFacts, type TrackerRow } from 'roadmap-module-protocol'

import type { Runner } from '../feedback.ts'
import {
  chunks,
  clip,
  instant,
  labelsOf,
  list,
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
  type Read,
} from './common.ts'
import type { Source } from './sources.ts'

/**
 * GitHub, through `gh`.
 *
 * A listing is two `gh … list --json` calls, which page for themselves; named
 * refs are one GraphQL query per fifty, by `issueOrPullRequest`, because GitHub
 * numbers issues and pull requests from one sequence and `gh#41` cannot say
 * which it is. Detail is a `gh … view` per ref, asked for a few at a time.
 */

const ISSUE_FIELDS = 'number,state,stateReason,title,url,labels,assignees,author,createdAt,updatedAt,closedAt'
const PR_FIELDS =
  'number,state,title,url,labels,assignees,author,createdAt,updatedAt,closedAt,mergedAt,isDraft,reviewDecision,closingIssuesReferences,statusCheckRollup'

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
    createdAt: instant(r.createdAt) ?? undefined,
    updatedAt: instant(r.updatedAt) ?? undefined,
    closedAt: state === 'open' ? null : (instant(r.closedAt) ?? undefined),
    links,
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
  const rollup = r.statusCheckRollup ?? obj(obj(nodes(obj(r.commits))[0]).commit).statusCheckRollup
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
    createdAt: instant(r.createdAt) ?? undefined,
    updatedAt: instant(r.updatedAt) ?? undefined,
    closedAt: state === 'open' ? null : (instant(r.closedAt) ?? undefined),
    mergedAt: state === 'merged' ? (instant(r.mergedAt) ?? undefined) : null,
    links,
    pipeline: rollup === undefined || rollup === null ? undefined : pipelineOf(rollup),
    review: reviewOf(r.reviewDecision),
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

const GRAPH_ISSUE = `__typename
  ... on Issue { number state stateReason title url createdAt updatedAt closedAt
    author { login } labels(first: 32) { nodes { name } } assignees(first: 16) { nodes { login name } }
    closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number merged } } }
  ... on PullRequest { number state title url createdAt updatedAt closedAt mergedAt isDraft reviewDecision
    author { login } labels(first: 32) { nodes { name } } assignees(first: 16) { nodes { login name } }
    closingIssuesReferences(first: 10) { nodes { number } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }`

/** The GraphQL for a batch of numbers. Owner and name passed `NAME` in `sources.ts`, so they cannot leave the string. */
export function refsQuery(source: Source, numbers: readonly number[]): string {
  const [owner, name] = source.repo.split('/')
  const asked = numbers.map((n) => `n${n}: issueOrPullRequest(number: ${n}) { ${GRAPH_ISSUE} }`).join('\n')
  return `query { repository(owner: "${owner}", name: "${name}") {\n${asked}\n} }`
}

export function githubAdapter(run: Runner): Adapter {
  const gh = (args: string[], source: Source) =>
    run(['gh', ...args], { timeout: 30_000 }).then((ran) => ({ ran, source }))

  return {
    async list(source, limit, now): Promise<Read> {
      const [issues, prs] = await Promise.all([
        gh(['issue', 'list', '--repo', repoArg(source), '--state', 'all', '--limit', String(limit), '--json', ISSUE_FIELDS], source),
        gh(['pr', 'list', '--repo', repoArg(source), '--state', 'all', '--limit', String(limit), '--json', PR_FIELDS], source),
      ])
      for (const { ran } of [issues, prs]) {
        if (ran.code !== 0) return { ok: false, why: trouble(ran, 'gh', source.host) }
      }
      const a = parsed(issues.ran)
      const b = parsed(prs.ran)
      if (!Array.isArray(a) || !Array.isArray(b)) {
        return { ok: false, why: 'gh answered with something that is not a list. A version of gh answering --json differently.' }
      }
      const rows = [
        ...a.map((one) => issueRow(source, one, now)),
        ...b.map((one) => pullRow(source, one, now)),
      ].filter((one): one is TrackerRow => one !== null)
      return { ok: true, rows: linkClosers(rows), notFound: [] }
    },

    async refs(source, wanted, now): Promise<Read> {
      if (source.repo.split('/').length !== 2) {
        return { ok: false, why: `${source.repo} is not an owner/repo name GitHub can have.` }
      }
      const numbers = [...new Set(wanted.map((w) => w.number))]
      const rows: TrackerRow[] = []
      const notFound: Array<{ number: number; kind: null }> = []
      for (const group of chunks(numbers, 50)) {
        const args = ['api', 'graphql', '-f', `query=${refsQuery(source, group)}`]
        if (source.host !== 'github.com') args.push('--hostname', source.host)
        const { ran } = await gh(args, source)
        const data = obj(obj(obj(parsed(ran)).data).repository)
        /* Partly found is still an answer: GraphQL says NOT_FOUND for a
           number that does not exist and exits 1 with the rest in `data`. */
        if (!Object.keys(data).length) return { ok: false, why: trouble(ran, 'gh', source.host) }
        for (const n of group) {
          const node = data[`n${n}`]
          if (node === null || node === undefined) {
            notFound.push({ number: n, kind: null })
            continue
          }
          const made = str(obj(node).__typename) === 'PullRequest' ? pullRow(source, node, now) : issueRow(source, node, now)
          if (made) rows.push(made)
        }
      }
      return { ok: true, rows, notFound }
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
