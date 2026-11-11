import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TrackerRow } from 'kehikot-module-protocol'

import { createCanvas, editCanvas, open, setSubject } from '../server/canvases.ts'
import type { Ran, Runner } from '../server/feedback.ts'
import { call, type Door } from '../server/mcp.ts'
import { Openness } from '../server/open.ts'
import { addProject } from '../server/projects.ts'
import type { Adapter, ListHow, Read } from '../server/trackers/common.ts'
import { editTrackers } from '../server/trackers/edit.ts'
import { githubAdapter, listQuery } from '../server/trackers/github.ts'
import { gitlabAdapter } from '../server/trackers/gitlab.ts'
import { Trackers } from '../server/trackers/reading.ts'
import { readConfig, sourcesOf, type Source } from '../server/trackers/sources.ts'
import {
  inScope,
  isDefaultReads,
  kindOf,
  readsOf,
  READS_DEFAULT,
  readsSaid,
  writtenReads,
} from '../src/host/trackerReads.ts'
import { listingText, trackerEditSchema } from '../src/host/trackerSources.ts'

/**
 * Jalez/kehikko#318: a person chooses what a tracker source reads — kinds,
 * states, and only what changed since the last read. Fake CLIs only.
 */

let folder: string
beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-tracker-reads-')))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const NOW = new Date('2026-10-05T12:00:00.000Z')
const DAY = 86_400_000
const ok = (out: unknown): Ran => ({ code: 0, out: typeof out === 'string' ? out : JSON.stringify(out), err: '' })
const fileOf = () => join(folder, '.kehikot', 'host', 'trackers.json')
const put = (value: unknown) => {
  mkdirSync(join(folder, '.kehikot', 'host'), { recursive: true })
  writeFileSync(fileOf(), JSON.stringify(value))
}
const json = () => JSON.parse(readFileSync(fileOf(), 'utf8'))
const ORIGIN = [{ name: 'origin', url: 'https://gitlab.example.org/group/project.git' }]
const GL = { tracker: 'gitlab', host: 'gitlab.example.org', repo: 'group/project' } as const
const gl: Source = { ...GL, default: true, listed: true }
const gh: Source = { tracker: 'github', host: 'github.com', repo: 'Jalez/kehikko', default: true, listed: true }

describe('the choice, in words and in the file', () => {
  test('only what differs from reading everything is written', () => {
    expect(isDefaultReads(READS_DEFAULT)).toBe(true)
    expect(writtenReads(READS_DEFAULT)).toBeNull()
    expect(writtenReads({ kinds: ['changes', 'issues'], closed: 30, since: true })).toEqual({ kinds: ['changes', 'issues'], closed: 30, since: true })
    expect(writtenReads({ kinds: ['issues', 'tasks', 'changes'], closed: false, since: false })).toEqual({ closed: false })
    expect(readsOf({ kinds: ['changes', 'issues'] })).toEqual({ kinds: ['issues', 'changes'], closed: true, since: false })
    expect(readsOf({ kinds: [] })).toBeNull()
    expect(readsOf({ closed: 0 })).toBeNull()
    expect(readsOf({ kinds: ['epics'] })).toBeNull()
  })

  test('said in the tracker’s own words', () => {
    expect(readsSaid(null, 'gitlab')).toBe('everything, in every state')
    expect(readsSaid({ kinds: ['changes'], closed: 30, since: true }, 'gitlab')).toBe(
      'merge requests, open, and closed in the last 30 days, only what changed since the last read',
    )
    expect(readsSaid({ kinds: ['issues', 'changes'], closed: false, since: false }, 'github')).toBe('everything, open only')
    expect(readsSaid({ kinds: ['changes'], closed: false, since: false }, 'github')).toBe('pull requests, open only')
  })

  test('which rows a source’s listing would hold', () => {
    const now = NOW.getTime()
    const closed = (days: number) => ({ kind: 'issue' as const, state: 'closed', closedAt: new Date(now - days * DAY).toISOString() })
    expect(kindOf({ kind: 'issue', workItem: 'task' })).toBe('tasks')
    expect(kindOf({ kind: 'change' })).toBe('changes')
    expect(inScope({ kind: 'issue', state: 'open' }, { kinds: ['changes'], closed: true, since: false }, now)).toBe(false)
    expect(inScope({ kind: 'issue', workItem: 'task', state: 'open' }, { kinds: ['issues'], closed: true, since: false }, now)).toBe(false)
    expect(inScope(closed(3), { ...READS_DEFAULT, closed: false }, now)).toBe(false)
    expect(inScope(closed(3), { ...READS_DEFAULT, closed: 7 }, now)).toBe(true)
    expect(inScope(closed(30), { ...READS_DEFAULT, closed: 7 }, now)).toBe(false)
    expect(inScope({ kind: 'change', state: 'merged', mergedAt: new Date(now - DAY).toISOString() }, { ...READS_DEFAULT, closed: 7 }, now)).toBe(true)
    expect(inScope(closed(300), null, now)).toBe(true)
  })
})

describe('the one writer keeps it', () => {
  test('set reads writes the choice on the entry, a remote’s entry with only reads stays, null takes it away', () => {
    const done = editTrackers(folder, { kind: 'set', ...GL, reads: { kinds: ['changes'], closed: false } }, ORIGIN)
    expect(done.outcome).toBe('changed')
    expect(done.said).toBe('group/project reads merge requests, open only.')
    expect(json().sources).toEqual([{ ...GL, reads: { kinds: ['changes'], closed: false } }])
    expect(editTrackers(folder, { kind: 'set', ...GL, reads: { kinds: ['changes'], closed: false } }, ORIGIN).outcome).toBe('unchanged')
    /* A choice of everything is no choice: the key goes, and the bare entry with it. */
    expect(editTrackers(folder, { kind: 'set', ...GL, reads: { kinds: ['issues', 'tasks', 'changes'] } }, ORIGIN).outcome).toBe('changed')
    expect(json().sources).toEqual([])
    editTrackers(folder, { kind: 'set', ...GL, reads: { since: true } }, ORIGIN)
    expect(editTrackers(folder, { kind: 'set', ...GL, reads: null }, ORIGIN).outcome).toBe('changed')
    expect(json().sources).toEqual([])
  })

  test('keys it does not know stay, and an older host’s file reads as before', () => {
    put({ version: 1, sources: [{ ...GL, list: true, mine: 'kept' }], every: 5 })
    editTrackers(folder, { kind: 'set', ...GL, reads: { closed: 30 } }, ORIGIN)
    expect(json()).toEqual({ version: 1, sources: [{ ...GL, list: true, reads: { closed: 30 }, mine: 'kept' }], every: 5 })
  })

  test('a reads this host cannot make sense of is left out, never a broken file', () => {
    put({ version: 1, sources: [{ ...GL, reads: { kinds: ['epics'], closed: 'soon' } }] })
    const config = readConfig(folder)
    expect(config.ok).toBe(true)
    if (!config.ok) return
    const [one] = sourcesOf(config.config, [ORIGIN[0]!.url])
    expect(one?.reads).toBeUndefined()
    put({ version: 1, sources: [{ ...GL, reads: { closed: 7, since: true } }] })
    const again = readConfig(folder)
    if (!again.ok) throw new Error(again.why)
    expect(sourcesOf(again.config, [ORIGIN[0]!.url])[0]?.reads).toEqual({ kinds: ['issues', 'tasks', 'changes'], closed: 7, since: true })
  })

  test('the page may send it, and nothing else in its place', () => {
    expect(trackerEditSchema.safeParse({ kind: 'set', ...GL, reads: { kinds: ['issues'], closed: 30, since: true } }).success).toBe(true)
    expect(trackerEditSchema.safeParse({ kind: 'set', ...GL, reads: null }).success).toBe(true)
    expect(trackerEditSchema.safeParse({ kind: 'set', ...GL, reads: { closed: -1 } }).success).toBe(false)
  })
})

/** A glab that records each REST listing it is asked and answers it empty. */
function glabRecording(): Runner & { lines: string[] } {
  const lines: string[] = []
  const run = (async (argv: string[]) => {
    const line = argv.join(' ')
    lines.push(line)
    if (line.includes('graphql')) return ok({ data: { project: { issues: { nodes: [] } } } })
    return ok([])
  }) as Runner & { lines: string[] }
  run.lines = lines
  return run
}

describe('GitLab asks only for what is read', () => {
  const list = async (how: ListHow) => {
    const run = glabRecording()
    await gitlabAdapter(run, () => 0).list(gl, 400, NOW.toISOString(), how)
    return run.lines.filter((l) => !l.includes('graphql'))
  }

  test('open only', async () => {
    const lines = await list({ reads: { ...READS_DEFAULT, closed: false }, since: null })
    expect(lines).toHaveLength(2)
    for (const l of lines) expect(l).toContain('state=opened')
  })

  test('open, and closed in a window: two listings each', async () => {
    const lines = await list({ reads: { ...READS_DEFAULT, closed: 30 }, since: null })
    const after = encodeURIComponent(new Date(NOW.getTime() - 30 * DAY).toISOString())
    expect(lines.filter((l) => l.includes('state=opened'))).toHaveLength(2)
    expect(lines.filter((l) => l.includes(`state=all&updated_after=${after}`))).toHaveLength(2)
  })

  test('only what changed: every state, from the instant', async () => {
    const since = '2026-10-05T11:00:00.000Z'
    const lines = await list({ reads: { ...READS_DEFAULT, since: true }, since })
    expect(lines).toHaveLength(2)
    for (const l of lines) expect(l).toContain(`state=all&updated_after=${encodeURIComponent(since)}`)
  })

  test('changes only asks no issues; tasks only asks only tasks, and plain issues are left out', async () => {
    const changes = await list({ reads: { ...READS_DEFAULT, kinds: ['changes'] }, since: null })
    expect(changes.every((l) => l.includes('/merge_requests?'))).toBe(true)
    const tasks = await list({ reads: { ...READS_DEFAULT, kinds: ['tasks'] }, since: null })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toContain('/issues?state=all&issue_type=task')

    const run = (async (argv: string[]) => {
      const line = argv.join(' ')
      if (line.includes('/issues?')) {
        return ok([
          { iid: 1, state: 'opened', title: 'plain', web_url: 'w1', issue_type: 'issue' },
          { iid: 2, state: 'opened', title: 'task', web_url: 'w2', issue_type: 'task' },
        ])
      }
      if (line.includes('graphql')) return ok({ data: { project: { issues: { nodes: [] } } } })
      return ok([])
    }) as Runner
    const read = await gitlabAdapter(run, () => 0).list(gl, 400, NOW.toISOString(), { reads: { ...READS_DEFAULT, kinds: ['issues', 'changes'] }, since: null })
    if (!read.ok) throw new Error(read.why)
    expect(read.rows.map((r) => r.number)).toEqual([1])
  })
})

describe('GitHub asks only for what is read', () => {
  test('the states and the instant go into the query', () => {
    const open = listQuery(gh, { issues: null, pulls: null }, true, 50, true, { states: 'open' })
    expect(open).toContain('issues(first: 50, orderBy: { field: CREATED_AT, direction: DESC }, states: [OPEN])')
    expect(open).toContain('pullRequests(first: 50, orderBy: { field: CREATED_AT, direction: DESC }, states: [OPEN])')
    const closed = listQuery(gh, { issues: null, pulls: false }, true, 50, true, { states: 'closed', updatedFrom: '2026-09-05T12:00:00.000Z' })
    expect(closed).toContain('orderBy: { field: UPDATED_AT, direction: DESC }, states: [CLOSED], filterBy: { since: "2026-09-05T12:00:00.000Z" }')
    expect(closed).not.toContain('pullRequests')
    /* Nothing but an instant goes into the string. */
    expect(listQuery(gh, { issues: null, pulls: null }, true, 50, true, { updatedFrom: '") { injected' })).not.toContain('injected')
  })

  test('only what changed stops at the first older item', async () => {
    const asked: string[] = []
    const run = (async (argv: string[]) => {
      const q = argv.find((a) => a.startsWith('query=')) ?? ''
      asked.push(q)
      return ok({ data: { repository: {
        pullRequests: {
          pageInfo: { hasNextPage: true, endCursor: 'next' },
          nodes: [
            { number: 9, state: 'OPEN', title: 'new', url: 'u9', updatedAt: '2026-10-05T11:30:00Z' },
            { number: 8, state: 'MERGED', title: 'old', url: 'u8', updatedAt: '2026-10-01T00:00:00Z' },
          ],
        },
      } } })
    }) as Runner
    const read = await githubAdapter(run, () => 0).list(gh, 400, NOW.toISOString(), {
      reads: { ...READS_DEFAULT, kinds: ['changes'], since: true },
      since: '2026-10-05T11:00:00.000Z',
    })
    if (!read.ok) throw new Error(read.why)
    expect(read.rows.map((r) => r.number)).toEqual([9])
    expect(asked).toHaveLength(1)
    expect(asked[0]).not.toContain('issues(')
  })

  test('a held page after the first keeps what was read, with the share sentence', async () => {
    let calls = 0
    const run = (async () => {
      calls += 1
      if (calls === 1) {
        return ok({ data: { repository: {
          issues: { pageInfo: { hasNextPage: true, endCursor: 'next' }, nodes: [{ number: 1, state: 'OPEN', title: 'a', url: 'u' }] },
          pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] },
        } } })
      }
      return { code: 1, out: '', err: "Kehikot's share of your GitHub limit is used up until 13:00", held: true }
    }) as Runner
    const read = await githubAdapter(run, () => 0).list(gh, 400, NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    expect(read.rows).toHaveLength(1)
    expect(read.partial).toContain("Kehikot's share of your GitHub limit is used up")
  })
})

describe('the reading reads only what changed, and keeps the rest', () => {
  const remotes: Runner = async (argv) =>
    argv[0] === 'git' ? ok(`origin\t${ORIGIN[0]!.url} (fetch)\n`) : { code: 1, out: '', err: '' }

  const row = (number: number, over: Partial<TrackerRow> = {}): TrackerRow => ({
    ref: `#${number}`,
    tracker: 'gitlab',
    host: 'gitlab.example.org',
    repo: 'group/project',
    number,
    kind: 'issue',
    state: 'open',
    title: `issue ${number}`,
    url: `https://gitlab.example.org/group/project/-/issues/${number}`,
    labels: [],
    assignees: [],
    links: [],
    updatedAt: NOW.toISOString(),
    readAt: NOW.toISOString(),
    ...over,
  })

  function recording(answers: Array<TrackerRow[]>): Adapter & { hows: Array<ListHow | undefined> } {
    const hows: Array<ListHow | undefined> = []
    return {
      hows,
      async list(_source: Source, _limit: number, _now: string, how?: ListHow): Promise<Read> {
        hows.push(how)
        return { ok: true, rows: answers.shift() ?? [], notFound: [] }
      },
      async refs() {
        return { ok: true, rows: [], notFound: [] }
      },
      async detail() {
        return new Map()
      },
    }
  }

  test('a whole read first, then only what changed since it, merged into what is held', async () => {
    editTrackers(folder, { kind: 'set', ...GL, reads: { since: true } }, ORIGIN)
    let now = NOW
    const adapter = recording([[row(1), row(2)], [row(2, { title: 'renamed' })]])
    const trackers = new Trackers({ run: remotes, adapters: { gitlab: adapter }, now: () => now })
    await trackers.refresh(folder, { project: true })
    now = new Date(NOW.getTime() + 15 * 60_000)
    await trackers.refresh(folder, { project: true })
    expect(adapter.hows[0]?.since).toBeNull()
    expect(adapter.hows[1]?.since).toBe(new Date(NOW.getTime() - 2 * 60_000).toISOString())
    const got = trackers.get(folder, { project: true })
    if ('refused' in got) throw new Error(got.refused)
    expect(got.rows.map((r) => [r.number, r.title]).sort()).toEqual([[1, 'issue 1'], [2, 'renamed']])
  })

  test('a day on, or with other kinds chosen, the read is whole again', async () => {
    editTrackers(folder, { kind: 'set', ...GL, reads: { since: true } }, ORIGIN)
    let now = NOW
    const adapter = recording([[row(1)], [row(1)], [row(1)]])
    const trackers = new Trackers({ run: remotes, adapters: { gitlab: adapter }, now: () => now })
    await trackers.refresh(folder, { project: true })
    now = new Date(NOW.getTime() + 25 * 60 * 60_000)
    await trackers.refresh(folder, { project: true })
    expect(adapter.hows[1]?.since).toBeNull()
    editTrackers(folder, { kind: 'set', ...GL, reads: { since: true, closed: false } }, ORIGIN)
    await trackers.refresh(folder, { project: true })
    expect(adapter.hows[2]?.since).toBeNull()
  })

  test('rows the choice leaves out go, unless somebody names them; the listing says what it reads', async () => {
    const adapter = recording([
      [row(1), row(2, { state: 'closed', closedAt: NOW.toISOString() }), row(3, { state: 'closed', closedAt: NOW.toISOString() })],
      [row(1)],
    ])
    const trackers = new Trackers({ run: remotes, adapters: { gitlab: adapter }, now: () => NOW })
    await trackers.refresh(folder, { project: true })
    await trackers.refresh(folder, { refs: ['#3'] })
    editTrackers(folder, { kind: 'set', ...GL, reads: { closed: false } }, ORIGIN)
    await trackers.refresh(folder, { project: true })
    expect(adapter.hows[1]?.reads.closed).toBe(false)
    const got = trackers.get(folder, { project: true })
    if ('refused' in got) throw new Error(got.refused)
    expect(got.rows.map((r) => r.number).sort()).toEqual([1, 3])
    const listing = trackers.listing(folder, ORIGIN)
    expect(listing.sources[0]?.reads).toEqual({ closed: false })
    expect(listingText(listing, NOW.getTime())).toContain('Its listing reads everything, open only.')
  })
})

describe('an agent sets it through set_tracker_source', () => {
  test('reads keeps the choices it is not given', async () => {
    const db = open(':memory:')
    const added = addProject(db, folder, 'p')
    const project = added.ok ? added.project.id : null
    const made = createCanvas(db, 'k', project)
    editCanvas(db, made.id, { placements: [] })
    if (project !== null) setSubject(db, project, { epic: 'x' })
    const remotes: Runner = async (argv) => (argv[0] === 'git' ? ok(`origin\t${ORIGIN[0]!.url} (fetch)\n`) : { code: 1, out: '', err: '' })
    const quiet: Adapter = {
      async list() {
        return { ok: true, rows: [], notFound: [] }
      },
      async refs() {
        return { ok: true, rows: [], notFound: [] }
      },
      async detail() {
        return new Map()
      },
    }
    const trackers = new Trackers({ run: remotes, adapters: { gitlab: quiet }, now: () => NOW })
    const door: Door = {
      db,
      which: () => new Openness().open(),
      wake: () => {},
      epicsChanged: () => {},
      dispositionsChanged: () => {},
      seen: async () => [],
      trackers,
    }
    const first = await call('set_tracker_source', { kehikko: made.id, action: 'reads', source: 'gitlab.example.org/group/project', closed: 30 }, door)
    expect(first.failed).toBe(false)
    expect(first.text).toContain('reads everything, open, and closed in the last 30 days')
    const second = await call('set_tracker_source', { kehikko: made.id, action: 'reads', source: 'group/project', since: true }, door)
    expect(second.failed).toBe(false)
    expect(json().sources[0].reads).toEqual({ closed: 30, since: true })
    const bad = await call('set_tracker_source', { kehikko: made.id, action: 'reads', source: 'group/project', kinds: [] }, door)
    expect(bad.failed).toBe(true)
    expect(bad.text).toContain('Nothing was changed')
    db.close()
  })
})
