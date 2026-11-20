import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TrackerActivity, TrackerRow } from 'kehikot-module-protocol'

import { open } from '../server/canvases.ts'
import { Inbox } from '../server/inbox.ts'
import { addProject } from '../server/projects.ts'
import { TrackerNotices } from '../server/trackerNotices.ts'
import { activityOf as githubActivity } from '../server/trackers/github.ts'
import { activityOf as gitlabActivity } from '../server/trackers/gitlab.ts'
import { factsOf, itemId, type Seen } from '../src/host/trackerNotices.ts'
import { isBotComment, newsOf, newsReport, quietAdded, quietLine, type EpicPlace } from '../src/host/trackerNews.ts'

/**
 * Tracker news to agents, with automated accounts kept quiet: a comment the
 * tracker says a bot wrote is counted on its item and said in one line after
 * people's news, in the next report that has people's news in it; a report of
 * only those is not sent. Bots are known by the tracker's `bot` (protocol
 * 2.111.0), never by a name. Made-up rows and scratch databases.
 */

const T0 = 1_800_000_000_000
const ME = 'jaakko'
const at = (ms: number) => new Date(ms).toISOString()
const SCANNER = 'scanner-bot'

const gl = (number: number, over: Partial<TrackerRow> = {}): TrackerRow => ({
  ref: `!${number}`,
  tracker: 'gitlab',
  host: 'gitlab.com',
  repo: 'g/r',
  number,
  kind: 'change',
  state: 'open',
  title: `change ${number}`,
  url: `https://gitlab.com/g/r/-/merge_requests/${number}`,
  labels: [],
  assignees: [],
  links: [],
  authorLogin: 'ali',
  myRoles: [],
  reviewers: [],
  updatedAt: at(T0 - 60_000),
  readAt: at(T0),
  ...over,
})

const comment = (login: string, when: number, bot?: boolean): TrackerActivity => ({ login, at: at(when), kind: 'comment', mine: false, ...(bot !== undefined ? { bot } : {}) })

describe('a bot\'s comment, as news', () => {
  const seen: Seen = { id: itemId(gl(5)), ref: '!5', title: 'change 5', facts: factsOf(gl(5)), events: [], since: null, at: T0 }

  test('marked by the tracker\'s bot, and a person\'s comment is not', () => {
    const bots = newsOf(seen, gl(5, { lastActivity: comment(SCANNER, T0 + 10, true) }), ME, T0 + 600_000, T0)
    expect(bots).toEqual([{ kind: 'commented', by: SCANNER, bot: true }])
    expect(bots.every(isBotComment)).toBe(true)
    const person = newsOf(seen, gl(5, { lastActivity: comment('mona', T0 + 10, false) }), ME, T0 + 600_000, T0)
    expect(person).toEqual([{ kind: 'commented', by: 'mona' }])
    expect(person.some(isBotComment)).toBe(false)
    /* Nothing said either way, whatever the name: a person. */
    expect(newsOf(seen, gl(5, { lastActivity: comment('build-bot', T0 + 10) }), ME, T0 + 600_000, T0).some(isBotComment)).toBe(false)
  })

  test('counted per account, and said as one line with the item\'s link', () => {
    const quiet = quietAdded(quietAdded(undefined, [{ kind: 'commented', by: SCANNER, name: 'Scanner', bot: true }]), [
      { kind: 'commented', by: 'scanner-BOT', bot: true },
      { kind: 'commented', by: 'deps', bot: true },
    ])
    expect(quiet).toEqual([{ by: SCANNER, name: 'Scanner', count: 2 }, { by: 'deps', count: 1 }])
    expect(quietLine('!5', 'https://x/5', quiet)).toBe('Scanner commented 2 times and deps commented once on !5 since the last report (automated accounts) — https://x/5')
    expect(quietLine('!5', '', [{ by: SCANNER, count: 3 }])).toBe(`${SCANNER} commented 3 times on !5 since the last report (an automated account)`)
    expect(quietLine('!5', 'u', [])).toBe('')
  })
})

describe('the report, with bots quiet', () => {
  const auth: EpicPlace[] = [{ epic: 'auth', parts: [] }]
  const ui: EpicPlace[] = [{ epic: 'ui', parts: [] }]

  test('people\'s lines first, in the order found, then the bots\' lines', () => {
    const { tells, quietTold } = newsReport([
      { line: '', places: auth, quiet: 'bot line A', key: 'a' },
      { line: 'mona approved !1', places: auth },
      { line: 'ali pushed 2 commits to !2', places: auth, quiet: 'bot line B', key: 'b' },
    ])
    expect(tells).toEqual([{ place: { epic: 'auth', space: ['auth'] }, body: 'mona approved !1\nali pushed 2 commits to !2\nbot line A\nbot line B' }])
    expect([...quietTold].sort()).toEqual(['a', 'b'])
  })

  test('a report of only bots\' lines is not sent, and those lines wait', () => {
    const { tells, quietTold } = newsReport([
      { line: '', places: ui, quiet: 'bot line', key: 'u' },
      { line: 'mona approved !1', places: auth },
    ])
    expect(tells).toEqual([{ place: { epic: 'auth', space: ['auth'] }, body: 'mona approved !1' }])
    expect(quietTold.size).toBe(0)
  })
})

describe('told to the sessions, across readings', () => {
  let db: Database
  let folder: string
  let project: number
  let clock: number
  let notices: TrackerNotices
  const places = new Map<string, EpicPlace[]>([['!5', [{ epic: 'auth', parts: [] }]], ['!6', [{ epic: 'auth', parts: [] }]]])
  const epics = new Map([['!5', 'auth'], ['!6', 'auth']])
  const me = new Map([['gitlab|gitlab.com', ME]])
  /** One reading landing; what it sends. */
  const land = (rows: TrackerRow[]) => {
    const out = notices.landed(project, { rows, me, epics, places })
    clock += 600_000
    return out.news.map((one) => one.body)
  }

  beforeEach(() => {
    db = open(':memory:')
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-news-bots-')))
    const added = addProject(db, folder, 'a project')
    if (!added.ok) throw new Error('no project')
    project = added.project.id
    clock = T0
    notices = new TrackerNotices(db, new Inbox(db, () => clock), () => clock)
  })
  afterEach(() => {
    db.close()
    rmSync(folder, { recursive: true, force: true })
  })

  test('bots alone send nothing; their count waits and is said after a person\'s comment on the same change', () => {
    expect(land([gl(5)])).toEqual([])
    expect(land([gl(5, { lastActivity: comment(SCANNER, clock - 5, true) })])).toEqual([])
    expect(land([gl(5, { lastActivity: comment(SCANNER, clock - 5, true) })])).toEqual([])
    expect(land([gl(5, { lastActivity: comment(SCANNER, clock - 5, true) })])).toEqual([])
    const told = land([gl(5, { lastActivity: comment('mona', clock - 5, false) })])
    expect(told).toEqual([
      `mona commented on !5 — change 5\n${SCANNER} commented 3 times on !5 since the last report (an automated account) — https://gitlab.com/g/r/-/merge_requests/5`,
    ])
    /* Told: not again. */
    expect(land([gl(5, { lastActivity: comment('bob', clock - 5, false) })])).toEqual(['bob commented on !5 — change 5'])
  })

  test('the count waiting on one change goes out with people\'s news on another in the same space', () => {
    land([gl(5), gl(6)])
    expect(land([gl(5, { lastActivity: comment(SCANNER, clock - 5, true) }), gl(6)])).toEqual([])
    const told = land([gl(5, { lastActivity: comment(SCANNER, clock - 600_005, true) }), gl(6, { state: 'merged', lastActivity: { login: 'ali', at: at(clock - 5), kind: 'state', mine: false } })])
    expect(told).toEqual([`ali merged !6 — change 6\n${SCANNER} commented once on !5 since the last report (an automated account) — https://gitlab.com/g/r/-/merge_requests/5`])
  })
})

describe('the adapters say a bot only as the tracker does', () => {
  test('GitHub: the actor\'s type', () => {
    const timeline = (author: unknown) => ({ nodes: [{ __typename: 'IssueComment', createdAt: at(T0), author }] })
    expect(githubActivity(timeline({ __typename: 'Bot', login: 'scanner' }), null, null)).toMatchObject({ login: 'scanner', kind: 'comment', bot: true })
    expect(githubActivity(timeline({ __typename: 'User', login: 'mona' }), null, null)).toMatchObject({ login: 'mona', bot: false })
    expect(githubActivity(timeline({ login: 'build-bot' }), null, null)?.bot).toBeUndefined()
  })

  test('GitLab: the author\'s bot flag', () => {
    const notes = (author: unknown) => ({ nodes: [{ system: false, body: 'hi', createdAt: at(T0), author }] })
    expect(gitlabActivity(notes({ username: 'scanner', bot: true }), null, null)).toMatchObject({ login: 'scanner', kind: 'comment', bot: true })
    expect(gitlabActivity(notes({ username: 'mona', bot: false }), null, null)).toMatchObject({ login: 'mona', bot: false })
    expect(gitlabActivity(notes({ username: 'build-bot' }), null, null)?.bot).toBeUndefined()
  })
})
