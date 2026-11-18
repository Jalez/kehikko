import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Ran } from '../server/feedback.ts'
import { etags } from '../server/trackers/common.ts'
import { Trackers, WHOLE_EVERY_MS } from '../server/trackers/reading.ts'
import { remotesNamed } from '../server/trackers/sources.ts'
import { fixtureTracker, type Fixture } from './trackerFixture.ts'

/**
 * A scheduled tracker read costs what changed, not the size of the project:
 * a conditional probe that finds nothing is the whole read; a few changes are
 * one small listing; a held ref is not read again by name unless its CI is
 * still running; an old closed item is read once. Against the fixture
 * tracker: nothing here reaches GitHub or GitLab.
 */

let folder: string
beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-tracker-incremental-')))
  mkdirSync(join(folder, '.git'))
  writeFileSync(join(folder, '.git', 'config'), '[remote "origin"]\n')
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const START = Date.parse('2026-10-05T12:00:00.000Z')
const MIN = 60_000

function setUp(tracker: 'github' | 'gitlab', size = 600) {
  let clock = START
  const f = fixtureTracker({ tracker, host: tracker === 'github' ? 'github.com' : 'gitlab.example.org', repo: 'acme/widgets', size, now: START })
  /* Through `f.run` each time, so a test may swap what answers. */
  const trackers = new Trackers({ run: (argv, o) => f.run(argv, o), now: () => new Date(clock) })
  return {
    f,
    trackers,
    later(ms: number) {
      clock += ms
      return new Date(clock - MIN).toISOString()
    },
    read: (by: 'schedule' | 'press' = 'schedule') => trackers.refresh(folder, { project: true }, by),
    row: (ref: string) => trackers.rowsHeld(folder).find((r) => r.ref === ref),
  }
}

const said = (f: Fixture) => f.asked.map((argv) => argv.join(' '))
const graphql = (f: Fixture) => said(f).filter((line) => line.includes(' graphql '))

describe('GitHub: a scheduled read costs what changed', () => {
  test('nothing changed: one conditional request answered 304, nothing listed, nothing lost', async () => {
    const { f, read, later, trackers } = setUp('github')
    expect((await read()).outcome).toBe('read')
    const held = trackers.rowsHeld(folder).length
    expect(held).toBeGreaterThan(0)
    later(15 * MIN)
    f.reset()
    expect((await read()).outcome).toBe('read')
    expect(said(f)).toHaveLength(1)
    expect(said(f)[0]).toContain('gh api -i -H If-None-Match: ')
    expect(trackers.rowsHeld(folder)).toHaveLength(held)
  })

  test('five changed: one small listing of what changed, merged in', async () => {
    const { f, read, later, row } = setUp('github')
    await read()
    const at = later(15 * MIN)
    const open = [...f.items.values()].filter((it) => it.kind === 'issue' && it.state === 'open')
    f.touch(open[0]!.number, at, { state: 'closed', closedAt: at })
    f.touch(open[1]!.number, at, { comments: 9 })
    const made = f.add({ kind: 'issue', state: 'open', createdAt: at, updatedAt: at, closedAt: null, checks: 'SUCCESS', comments: 0 })
    f.reset()
    await read()
    expect(graphql(f)).toHaveLength(1)
    expect(graphql(f)[0]).toContain('orderBy: { field: UPDATED_AT, direction: DESC }')
    expect(graphql(f)[0]).toContain('first: 10')
    expect(row(`gh#${open[0]!.number}`)?.state).toBe('closed')
    expect(row(`gh#${made.number}`)?.state).toBe('open')
  })

  test('an open change whose CI is running is read again until it finishes, and then no more', async () => {
    const { f, read, later, row } = setUp('github')
    await read()
    const change = [...f.items.values()].find((it) => it.kind === 'change' && it.state === 'open')!
    f.touch(change.number, later(15 * MIN), { checks: 'PENDING' })
    await read()
    expect(row(`gh#${change.number}`)?.pipeline).toBe('running')
    /* Its checks finish: nothing else about it moves, so no listing would say. */
    f.items.get(change.number)!.checks = 'FAILURE'
    later(15 * MIN)
    f.reset()
    await read()
    expect(graphql(f)).toHaveLength(1)
    expect(graphql(f)[0]).toContain(`n${change.number}: issueOrPullRequest(number: ${change.number})`)
    expect(row(`gh#${change.number}`)?.pipeline).toBe('failed')
    later(15 * MIN)
    f.reset()
    await read()
    expect(graphql(f)).toHaveLength(0)
  })

  test('a held ref is not read again by name; one never read is; neither is called gone', async () => {
    const { f, read, later, trackers, row } = setUp('github')
    const old = [...f.items.values()].find((it) => it.kind === 'issue' && it.state === 'closed' && it.number < 50)!
    trackers.get(folder, { refs: [`gh#${old.number}`] })
    await read()
    expect(row(`gh#${old.number}`)?.state).toBe('closed')
    later(15 * MIN)
    f.reset()
    await read()
    expect(graphql(f)).toHaveLength(0)
    const fresh = [...f.items.values()].find((it) => it.kind === 'issue' && it.state === 'closed' && it.number > 60 && it.number < 100)!
    trackers.get(folder, { refs: [`gh#${fresh.number}`] })
    later(15 * MIN)
    f.reset()
    await read()
    expect(graphql(f)).toHaveLength(1)
    expect(graphql(f)[0]).toContain(`issueOrPullRequest(number: ${fresh.number})`)
    expect(graphql(f)[0]).not.toContain(`issueOrPullRequest(number: ${old.number})`)
    const got = trackers.get(folder, { refs: [`gh#${old.number}`, `gh#${fresh.number}`] })
    if ('refused' in got) throw new Error(got.refused)
    expect(got.missing).toEqual([])
    expect(got.rows.map((r) => r.state)).toEqual(['closed', 'closed'])
  })

  test('an old closed item is read once: not by the daily whole read, again on Refresh all', async () => {
    const { f, read, later, trackers } = setUp('github')
    const old = [...f.items.values()].find((it) => it.kind === 'issue' && it.state === 'closed' && it.number < 50)!
    trackers.get(folder, { refs: [`gh#${old.number}`] })
    await read()
    later(WHOLE_EVERY_MS + MIN)
    f.reset()
    await read()
    /* Whole again — the listing is not of what changed — and the old item is not asked by name. */
    expect(graphql(f).some((q) => q.includes('field: CREATED_AT'))).toBe(true)
    expect(graphql(f).some((q) => q.includes(`issueOrPullRequest(number: ${old.number})`))).toBe(false)
    f.reset()
    await read('press')
    expect(graphql(f).some((q) => q.includes(`issueOrPullRequest(number: ${old.number})`))).toBe(true)
  })

  test('a listing that fails after its probe does not let the next probe say "nothing changed"', async () => {
    const { f, read, later, row } = setUp('github')
    await read()
    const issue = [...f.items.values()].find((it) => it.kind === 'issue' && it.state === 'open')!
    f.touch(issue.number, later(15 * MIN), { state: 'closed', closedAt: new Date(START).toISOString() })
    const real = f.run
    f.run = async (argv) => (argv.includes('graphql') ? ({ code: 1, out: '', err: 'dial tcp: i/o timeout' } satisfies Ran) : real(argv))
    expect((await read()).outcome).toBe('failed')
    f.run = real
    later(15 * MIN)
    await read()
    expect(row(`gh#${issue.number}`)?.state).toBe('closed')
  })
})

describe('GitLab: a scheduled read costs what changed', () => {
  test('nothing changed: three conditional requests (issues, merge requests, branches), nothing else', async () => {
    const { f, read, later } = setUp('gitlab')
    await read()
    later(15 * MIN)
    f.reset()
    await read()
    expect(said(f)).toHaveLength(3)
    for (const line of said(f)) expect(line).toContain('glab api -i -H If-None-Match: ')
  })

  test('a change is one listing of what changed per kind and its open items read again, batched', async () => {
    const { f, read, later, row } = setUp('gitlab')
    await read()
    const issue = [...f.items.values()].find((it) => it.kind === 'issue' && it.state === 'open')!
    f.touch(issue.number, later(15 * MIN), { comments: 6 })
    f.reset()
    await read()
    const listings = said(f).filter((line) => line.includes('updated_after=') && !line.includes(' -i '))
    expect(listings).toHaveLength(2)
    expect(graphql(f)).toHaveLength(1)
    expect(row(`#${issue.number}`)?.updatedAt).toBe(f.items.get(issue.number)!.updatedAt)
  })
})

describe('conditional requests', () => {
  test('a 304 says "the same" only against an ETag this store kept; a 200 is kept only when told', async () => {
    const store = etags()
    let answer = 'HTTP/2.0 200 OK\r\nEtag: W/"a"\r\n\r\n[]'
    const asked: string[][] = []
    const run = async (argv: string[]): Promise<Ran> => {
      asked.push(argv)
      return { code: answer.includes(' 304 ') ? 1 : 0, out: answer, err: '' }
    }
    const first = await store.ask(run, ['gh', 'api', 'repos/a/b/issues'], 'k')
    expect(first.changed).toBe(true)
    expect(asked[0]).toEqual(['gh', 'api', '-i', 'repos/a/b/issues'])
    /* Not kept: the next asks unconditionally again. */
    await store.ask(run, ['gh', 'api', 'repos/a/b/issues'], 'k')
    expect(asked[1]).toEqual(['gh', 'api', '-i', 'repos/a/b/issues'])
    first.keep()
    answer = 'HTTP/2.0 304 Not Modified\r\nEtag: W/"a"\r\n\r\n'
    const second = await store.ask(run, ['gh', 'api', 'repos/a/b/issues'], 'k')
    expect(asked[2]).toEqual(['gh', 'api', '-i', '-H', 'If-None-Match: W/"a"', 'repos/a/b/issues'])
    expect(second.changed).toBe(false)
    answer = ''
    expect((await store.ask(run, ['gh', 'api', 'repos/a/b/issues'], 'k')).changed).toBeNull()
  })
})

describe('the project’s remotes', () => {
  test('git is asked once while the repository’s config is unchanged, and again after it is written', async () => {
    let runs = 0
    const run = async (): Promise<Ran> => {
      runs += 1
      return { code: 0, out: 'origin\thttps://github.com/a/b.git (fetch)\n', err: '' }
    }
    expect(await remotesNamed(folder, run)).toEqual([{ name: 'origin', url: 'https://github.com/a/b.git' }])
    await remotesNamed(folder, run)
    expect(runs).toBe(1)
    const later = new Date(Date.now() + 5_000)
    utimesSync(join(folder, '.git', 'config'), later, later)
    await remotesNamed(folder, run)
    expect(runs).toBe(2)
    /* Not a repository it can watch: asked every time, as before. */
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-no-git-')))
    try {
      await remotesNamed(bare, run)
      await remotesNamed(bare, run)
      expect(runs).toBe(4)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

describe('an idle canvas', () => {
  /** Ticks of the schedule a minute apart, on the clock the reading keeps, until every read lands. */
  async function idle(trackers: Trackers, minutes: number, base: number, setClock: (at: number) => void) {
    for (let m = 1; m <= minutes; m += 1) {
      setClock(base + m * MIN)
      trackers.signal(folder)
      trackers.tick(base + m * MIN)
      for (let i = 0; i < 200 && trackers.signal(folder).refreshing; i += 1) await Bun.sleep(1)
    }
  }

  function project(every: number) {
    mkdirSync(join(folder, '.kehikot', 'host'), { recursive: true })
    writeFileSync(join(folder, '.kehikot', 'host', 'trackers.json'), JSON.stringify({ version: 1, sources: [], every }))
    /* The schedule counts a look in real time, so the reading's clock starts at real now. */
    const base = Date.now()
    let clock = base
    const f = fixtureTracker({ tracker: 'github', host: 'github.com', repo: 'acme/widgets', size: 600, now: base })
    const trackers = new Trackers({ run: (argv, o) => f.run(argv, o), now: () => new Date(clock) })
    return { f, trackers, base, setClock: (at: number) => (clock = at) }
  }

  test('nothing changing for 25 minutes on a 5-minute schedule starts five probes and nothing else', async () => {
    const { f, trackers, base, setClock } = project(5)
    await trackers.refresh(folder, { project: true }, 'schedule')
    f.reset()
    await idle(trackers, 25, base, setClock)
    expect(said(f)).toHaveLength(5)
    for (const line of said(f)) expect(line).toContain('If-None-Match')
  })

  test('with the trackers read only on Refresh all, an idle canvas starts nothing at all', async () => {
    const { f, trackers, base, setClock } = project(0)
    await trackers.refresh(folder, { project: true }, 'press')
    f.reset()
    await idle(trackers, 25, base, setClock)
    expect(said(f)).toEqual([])
  })
})
