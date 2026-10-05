import { LIMITS, type PipelineState, type TrackerDetailFacts, type TrackerRow } from 'kehikot-module-protocol'

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
 * GitLab, through `glab api`, on any host — gitlab.com or a self-hosted one.
 *
 * Lifted in substance from `innovium-roadmap`'s `src/trackers/gitlab.ts`, which
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
 * The words in a merge request's description that say it is FOR an issue.
 * Prior art's pattern, unchanged: GitLab's own closing keywords, and the
 * "part of" / "implements" a stack's upper merge requests use, since GitLab's
 * `closed_by` ignores a merge request that targets a feature branch.
 */
const DECLARATION =
  /\b(?:clos(?:e|es|ed|ing)|fix(?:es|ed|ing)?|resolv(?:e|es|ed|ing)|part of|implements)\b[\s:]*((?:#\d+[\s,]*(?:and\s*)?)+)/gi

export function declaredIssues(description: string | null | undefined): number[] {
  const out = new Set<number>()
  for (const m of (description ?? '').matchAll(DECLARATION)) {
    for (const ref of m[1]!.matchAll(/#(\d+)/g)) out.add(Number(ref[1]))
  }
  return [...out]
}

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
  return row({
    ref,
    tracker: 'gitlab',
    host: source.host,
    repo: source.repo,
    number,
    kind: 'issue',
    state,
    title: clip(str(r.title), LIMITS.TITLE),
    url: clip(str(r.web_url) || str(r.webUrl), LIMITS.URL),
    labels: labelsOf(r.labels),
    assignees: people(r.assignees),
    author: who(r.author) || undefined,
    createdAt: instant(r.created_at ?? r.createdAt) ?? undefined,
    updatedAt: instant(r.updated_at ?? r.updatedAt) ?? undefined,
    closedAt: state === 'open' ? null : (instant(r.closed_at ?? r.closedAt) ?? undefined),
    links: [],
    readAt: now,
  })
}

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
  const links = declaredIssues(str(r.description))
    .map((n) => spell(source, 'issue', n))
    .filter((one): one is string => one !== null)
    .slice(0, LIMITS.TRACKER_LINKS)
    .map((one) => ({ ref: one, relation: 'closes' as const }))
  const pipeline = pipelineOf(obj(r.headPipeline ?? r.head_pipeline).status)
  const approved = typeof r.approved === 'boolean' ? r.approved : undefined
  const draft = typeof r.draft === 'boolean' ? r.draft : typeof r.work_in_progress === 'boolean' ? r.work_in_progress : undefined
  return row({
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
    createdAt: instant(r.created_at ?? r.createdAt) ?? undefined,
    updatedAt: instant(r.updated_at ?? r.updatedAt) ?? undefined,
    closedAt: state === 'open' ? null : (instant(r.closed_at ?? r.closedAt) ?? undefined),
    mergedAt: state === 'merged' ? (instant(r.merged_at ?? r.mergedAt) ?? undefined) : null,
    links,
    pipeline,
    /* Only while open, as prior art does: an approval on a merged request is
       history, not a state of review. */
    review: state === 'open' && approved !== undefined ? (approved ? 'approved' : 'required') : undefined,
    readAt: now,
  })
}

/**
 * Give each issue the merge requests that declare it, and say it was closed by
 * a merge when one of them merged. A GitLab issue has no close reason, so this
 * is the only way `deriveDisposition` can call one done.
 */
export function linkDeclarers(rows: TrackerRow[]): TrackerRow[] {
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

const GRAPH_PEOPLE = 'labels { nodes { title } } assignees { nodes { name username } } author { name username }'

/**
 * GraphQL for issues and merge requests by iid. The path passed `NAME` in `sources.ts`.
 *
 * Every connection carries `first:` equal to its iid count. GitLab costs a
 * query statically and, without `first:`, assumes a page of a hundred and
 * multiplies the nested fields by it — 397 for even one issue and one merge
 * request, against a limit of 250 (Jalez/kehikko#28).
 */
export function refsQuery(source: Source, issues: readonly number[], merges: readonly number[]): string {
  const parts: string[] = []
  if (issues.length) {
    parts.push(`issues(iids: [${issues.map((n) => `"${n}"`).join(',')}], first: ${issues.length}) { nodes {
      iid state title webUrl createdAt updatedAt closedAt ${GRAPH_PEOPLE} } }`)
  }
  if (merges.length) {
    parts.push(`mergeRequests(iids: [${merges.map((n) => `"${n}"`).join(',')}], first: ${merges.length}) { nodes {
      iid state title webUrl draft createdAt updatedAt closedAt mergedAt description approved
      headPipeline { status } ${GRAPH_PEOPLE} } }`)
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

/** How many pages of a hundred a listing of `limit` takes. */
/** References per GraphQL query: GitLab's complexity grows with it (148 at 25 + 25, against a limit of 250). */
const BATCH = 25

/** GitLab's refusal of a query it costs too high. */
const COMPLEXITY = /Query has complexity of \d+, which exceeds max complexity of \d+/

const pagesFor = (limit: number) => Math.max(1, Math.ceil(limit / 100))

export function gitlabAdapter(run: Runner): Adapter {
  const glab = (args: string[], source: Source) =>
    run(['glab', 'api', '--hostname', source.host, ...args], { timeout: 30_000 })
  const graph = (query: string, source: Source) => glab(['graphql', '-f', `query=${query}`], source)
  const project = (source: Source) => `projects/${encodeURIComponent(source.repo)}`

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
      const ran = await graph(refsQuery(source, i, m), source)
      const answer = obj(parsed(ran))
      const data = obj(obj(answer.data).project)
      if (Object.keys(data).length) return take(data)
      const first = list(answer.errors).length ? clip(str(obj(list(answer.errors)[0]).message), LIMITS.REASON) : ''
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
    return {
      ok: true,
      rows,
      notFound: [
        ...issues.filter((n) => !seenIssues.has(n) && !cannot(n, 'issue')).map((number) => ({ number, kind: 'issue' as const })),
        ...merges.filter((n) => !seenMerges.has(n) && !cannot(n, 'change')).map((number) => ({ number, kind: 'change' as const })),
      ],
      ...(unread.length ? { unread: { why: clip(`${why} (${unread.length} of ${issues.length + merges.length} references not read)`, LIMITS.REASON), refs: unread } } : {}),
    }
  }

  return {
    async list(source, limit, now): Promise<Read> {
      const [issues, merges] = await Promise.all([pages(source, 'issues', limit), pages(source, 'merge_requests', limit)])
      if (typeof issues === 'string') return { ok: false, why: issues }
      if (typeof merges === 'string') return { ok: false, why: merges }
      const rows = [
        ...issues.map((one) => issueRow(source, one, now)),
        ...merges.map((one) => mergeRow(source, one, now)),
      ].filter((one): one is TrackerRow => one !== null)
      /* The REST list has no pipeline and no approval; the open merge requests
         are read again, batched, for both. A failure here keeps the rows and
         loses only those two fields — absent, not guessed. */
      const open = rows.filter((one) => one.kind === 'change' && one.state === 'open').map((one) => one.number)
      if (open.length) {
        const again = await byIids(source, [], open, now)
        if (again.ok) {
          const fresh = new Map(again.rows.map((one) => [one.number, one]))
          for (let i = 0; i < rows.length; i += 1) {
            const one = rows[i]!
            if (one.kind === 'change' && fresh.has(one.number)) rows[i] = fresh.get(one.number)!
          }
        }
      }
      return { ok: true, rows: linkDeclarers(rows), notFound: [] }
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
