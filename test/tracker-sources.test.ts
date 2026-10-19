import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCanvas, editCanvas, open, setSubject } from '../server/canvases.ts'
import type { Ran, Runner } from '../server/feedback.ts'
import { call, type Door } from '../server/mcp.ts'
import { Openness } from '../server/open.ts'
import { addProject } from '../server/projects.ts'
import { editTrackers, nextStep, spell } from '../server/trackers/edit.ts'
import { Trackers } from '../server/trackers/reading.ts'
import { listSources, readConfig, sourcesOf, splitRemote, type Source } from '../server/trackers/sources.ts'
import { Wakes } from '../server/wake.ts'
import { listingText, rolesOf, readSaid, trackerEditSchema } from '../src/host/trackerSources.ts'

/**
 * A project's tracker sources, understood and edited in the app: the words,
 * the one writer, the `off` switch, what a person types, and the agent's tool.
 */

let folder: string
beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-tracker-sources-')))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const fileOf = () => join(folder, '.kehikot', 'host', 'trackers.json')
const put = (text: string) => {
  mkdirSync(join(folder, '.kehikot', 'host'), { recursive: true })
  writeFileSync(fileOf(), text)
}
const text = () => readFileSync(fileOf(), 'utf8')
const json = () => JSON.parse(text())

const ORIGIN = [{ name: 'origin', url: 'https://github.com/Jalez/kehikko.git' }]
const GL = { tracker: 'gitlab', host: 'gitlab.example.org', repo: 'group/sub/project' } as const
const OWN = { tracker: 'github', host: 'github.com', repo: 'Jalez/kehikko' } as const

describe('what a person types', () => {
  test('a link of any form, with subgroups, ports and .git', () => {
    expect(spell('https://github.com/Jalez/kehikko')).toEqual({ ok: true, tracker: 'github', host: 'github.com', repo: 'Jalez/kehikko' })
    expect(spell('git@github.com:Jalez/kehikko.git')).toEqual({ ok: true, tracker: 'github', host: 'github.com', repo: 'Jalez/kehikko' })
    expect(spell('git@gitlab.example.org:group/sub/project.git')).toEqual({ ok: true, ...GL })
    expect(spell('ssh://git@gitlab.example.org:2222/group/sub/project.git')).toEqual({ ok: true, ...GL })
    expect(spell('https://gitlab.example.org:8443/group/sub/project.git')).toEqual({ ok: true, ...GL })
    expect(spell('https://github.com/Jalez/kehikko/issues/12')).toEqual({ ok: true, tracker: 'github', host: 'github.com', repo: 'Jalez/kehikko' })
    expect(spell('https://gitlab.example.org/group/sub/project/-/merge_requests/7')).toEqual({ ok: true, ...GL })
  })

  test('a name needs its tracker, and a self-hosted GitLab its host', () => {
    expect(spell('Jalez/kehikko')).toMatchObject({ ok: false, needs: 'tracker' })
    expect(spell('Jalez/kehikko', 'github')).toEqual({ ok: true, tracker: 'github', host: 'github.com', repo: 'Jalez/kehikko' })
    expect(spell('group/sub/project', 'gitlab')).toEqual({ ok: true, tracker: 'gitlab', host: 'gitlab.com', repo: 'group/sub/project' })
    expect(spell('group/sub/project', 'gitlab', 'https://GitLab.Example.org/')).toEqual({ ok: true, ...GL })
    expect(spell('a/b/c', 'github')).toMatchObject({ ok: false })
    expect(spell('just-a-word', 'github')).toMatchObject({ ok: false })
    expect(spell('  ')).toMatchObject({ ok: false })
  })

  test('a link on a host that does not say asks which tracker, and takes the answer', () => {
    expect(spell('https://code.example.org/team/app.git')).toMatchObject({ ok: false, needs: 'tracker' })
    expect(spell('https://code.example.org/team/app.git', 'gitlab')).toEqual({ ok: true, tracker: 'gitlab', host: 'code.example.org', repo: 'team/app' })
    expect(splitRemote('not a url')).toBeNull()
  })

  test('the edit the page may send is bounded', () => {
    expect(trackerEditSchema.safeParse({ kind: 'schedule', every: 15 }).success).toBe(true)
    expect(trackerEditSchema.safeParse({ kind: 'schedule', every: -1 }).success).toBe(false)
    expect(trackerEditSchema.safeParse({ kind: 'drop-everything' }).success).toBe(false)
  })
})

describe('the writer', () => {
  test('adds a source, keeps what it does not know, and says nothing twice', () => {
    put('{\n  "version": 1,\n  "sources": [],\n  "note": "kept",\n  "every": 30\n}\n')
    const done = editTrackers(folder, { kind: 'add', input: 'git@gitlab.example.org:group/sub/project.git' }, [])
    expect(done.outcome).toBe('changed')
    expect(json()).toEqual({
      version: 1,
      sources: [{ tracker: 'gitlab', host: 'gitlab.example.org', repo: 'group/sub/project', list: true }],
      every: 30,
      note: 'kept',
    })
    /* Stable order: the known keys first, then the person's own. */
    expect(Object.keys(json())).toEqual(['version', 'sources', 'every', 'note'])
    const again = editTrackers(folder, { kind: 'add', input: 'https://gitlab.example.org/group/sub/project' }, [])
    expect(again.outcome).toBe('unchanged')
  })

  test('a change that changes nothing writes nothing', () => {
    put('{"version":1,"sources":[{"tracker":"gitlab","host":"gitlab.example.org","repo":"group/sub/project","list":true}],"every":15}')
    const before = text()
    const stamp = new Date('2020-01-01T00:00:00Z')
    utimesSync(fileOf(), stamp, stamp)
    const done = editTrackers(folder, { kind: 'set', ...GL, list: true }, [])
    expect(done.outcome).toBe('unchanged')
    expect(text()).toBe(before)
    expect(statSync(fileOf()).mtime.getTime()).toBe(stamp.getTime())
    expect(readdirSync(join(folder, '.kehikot', 'host')).filter((n) => n.includes('.tmp'))).toEqual([])
  })

  test('with no file, a no-op does not create one', () => {
    const done = editTrackers(folder, { kind: 'remotes', on: true }, ORIGIN)
    expect(done.outcome).toBe('changed') // an explicit key is a change from "absent"
    rmSync(fileOf())
    expect(editTrackers(folder, { kind: 'set', ...OWN, list: true }, ORIGIN).outcome).toBe('unchanged')
    expect(existsSync(fileOf())).toBe(false)
  })

  test('one default per tracker: switching moves it', () => {
    editTrackers(folder, { kind: 'add', input: 'Jalez/other', tracker: 'github' }, ORIGIN)
    expect(sourcesOf(readConfig(folder).ok ? (readConfig(folder) as any).config : null, ORIGIN.map((r) => r.url)).find((s) => s.default)?.repo).toBe('Jalez/kehikko')
    editTrackers(folder, { kind: 'set', tracker: 'github', host: 'github.com', repo: 'Jalez/other', default: true }, ORIGIN)
    let read = readConfig(folder)
    if (!read.ok) throw new Error(read.why)
    expect(sourcesOf(read.config, ORIGIN.map((r) => r.url)).filter((s) => s.default).map((s) => s.repo)).toEqual(['Jalez/other'])
    /* Moving it back to the remote's source clears the other's flag. */
    editTrackers(folder, { kind: 'set', ...OWN, default: true }, ORIGIN)
    read = readConfig(folder)
    if (!read.ok) throw new Error(read.why)
    expect(read.config.sources.filter((e) => e.default).map((e) => e.repo)).toEqual(['Jalez/kehikko'])
    expect(sourcesOf(read.config, ORIGIN.map((r) => r.url)).filter((s) => s.default).map((s) => s.repo)).toEqual(['Jalez/kehikko'])
  })

  test('a source from a remote is turned off, and back; one that was added is removed', () => {
    editTrackers(folder, { kind: 'add', input: 'Jalez/other', tracker: 'github' }, ORIGIN)
    const refused = editTrackers(folder, { kind: 'remove', ...OWN }, ORIGIN)
    expect(refused.outcome).toBe('declined')
    expect(refused.why).toContain('git remote origin')
    expect(editTrackers(folder, { kind: 'set', ...OWN, off: true }, ORIGIN).outcome).toBe('changed')
    expect(json().sources).toContainEqual({ tracker: 'github', repo: 'Jalez/kehikko', off: true })
    let read = readConfig(folder)
    if (!read.ok) throw new Error(read.why)
    expect(sourcesOf(read.config, ORIGIN.map((r) => r.url)).map((s) => s.repo)).toEqual(['Jalez/other'])
    const shown = listSources(read.config, ORIGIN)
    expect(shown.map((s) => [s.repo, s.off, s.origin])).toEqual([['Jalez/other', false, 'file'], ['Jalez/kehikko', true, 'remote']])
    expect(rolesOf({ ...shown[1]!, at: null, error: null, issues: null, changes: null })[0]).toContain('turned off')

    expect(editTrackers(folder, { kind: 'set', ...OWN, off: false }, ORIGIN).outcome).toBe('changed')
    /* The entry that said nothing else is gone: the file is as tidy as before. */
    expect(json().sources).toEqual([{ tracker: 'github', repo: 'Jalez/other', list: true }])
    expect(editTrackers(folder, { kind: 'remove', tracker: 'github', host: 'github.com', repo: 'Jalez/other' }, ORIGIN).outcome).toBe('changed')
    expect(json().sources).toEqual([])
    read = readConfig(folder)
    if (!read.ok) throw new Error(read.why)
    expect(sourcesOf(read.config, ORIGIN.map((r) => r.url)).map((s) => s.repo)).toEqual(['Jalez/kehikko'])
  })

  test('off wins: over the remote, over another entry, over a ref that names it outright', () => {
    put(
      JSON.stringify({
        version: 1,
        sources: [
          { tracker: 'github', repo: 'Jalez/kehikko', off: true },
          { tracker: 'github', repo: 'Jalez/kehikko', list: true },
          { tracker: 'github', repo: 'Jalez/more', list: true },
        ],
      }),
    )
    const read = readConfig(folder)
    if (!read.ok) throw new Error(read.why)
    const got = sourcesOf(read.config, ORIGIN.map((r) => r.url), ['gh:Jalez/kehikko#3', 'gh:Jalez/ref#4'])
    expect(got.map((s) => s.repo)).toEqual(['Jalez/more', 'Jalez/ref'])
    expect(got.find((s) => s.repo === 'Jalez/more')?.default).toBe(true)
  })

  test('the schedule and the remotes switch', () => {
    expect(editTrackers(folder, { kind: 'schedule', every: 60 }, ORIGIN).outcome).toBe('changed')
    expect(json()).toEqual({ version: 1, every: 60 })
    expect(editTrackers(folder, { kind: 'schedule', every: 60 }, ORIGIN).outcome).toBe('unchanged')
    expect(editTrackers(folder, { kind: 'schedule', every: 0 }, ORIGIN).outcome).toBe('changed')
    expect(editTrackers(folder, { kind: 'remotes', on: false }, ORIGIN).outcome).toBe('changed')
    expect(json()).toEqual({ version: 1, every: 0, remotes: false })
    expect(Object.keys(json())).toEqual(['version', 'remotes', 'every'])
    const read = readConfig(folder)
    if (!read.ok) throw new Error(read.why)
    expect(read.config.every).toBe(0)
    expect(sourcesOf(read.config, ORIGIN.map((r) => r.url))).toEqual([])
    expect(editTrackers(folder, { kind: 'schedule', every: 7.5 as number }, ORIGIN).outcome).toBe('declined')
  })

  test('a broken file is never written over', () => {
    put('{"version": 1, "sources": [{"tracker": "jira", "repo": "x/y"}]}')
    const before = text()
    const done = editTrackers(folder, { kind: 'add', input: 'Jalez/x', tracker: 'github' }, [])
    expect(done.outcome).toBe('declined')
    expect(done.why).toContain('will not read')
    expect(text()).toBe(before)
  })

  test('an older host reads a file with off in it, and reads the repository', () => {
    /* The schema of before `off`: z.object strips what it does not know. */
    put(JSON.stringify({ version: 1, sources: [{ tracker: 'github', repo: 'Jalez/kehikko', off: true }] }))
    const read = readConfig(folder)
    expect(read.ok).toBe(true)
  })
})

describe('what a failed check says to do', () => {
  test('not logged in is a login in a terminal, once', () => {
    const why = 'The GitHub CLI (gh) is not logged in to github.com: run `gh auth login`.'
    expect(nextStep(why, 'github', 'github.com')).toContain('Run `gh auth login` in a terminal once, then press Check again')
    expect(nextStep('The GitLab CLI (glab) is not logged in to gitlab.example.org: run `glab auth login --hostname gitlab.example.org`.', 'gitlab', 'gitlab.example.org')).toContain(
      'glab auth login --hostname gitlab.example.org',
    )
  })
  test('missing tool, no access, unreachable', () => {
    expect(nextStep('The GitHub CLI (gh) is not installed, so github.com cannot be read from here.', 'github', 'github.com')).toContain('Install it')
    expect(nextStep('github.com has no repository it will show this login under that name.', 'github', 'github.com')).toContain('Check the spelling')
    expect(nextStep('gitlab.example.org could not be reached from this machine — the network, a VPN, or the host is down.', 'gitlab', 'gitlab.example.org')).toContain('press Check again')
  })
})

describe('the words', () => {
  const s = { ...OWN, default: true, listed: true, origin: 'remote' as const, remote: 'origin', off: false, at: '2026-10-05T11:56:00.000Z', error: null, issues: 12, changes: 3 }
  test('roles, in words', () => {
    expect(rolesOf(s)).toEqual(["from this project's git remote origin", 'the default for gh#12', 'recent issues and changes are listed'])
    expect(rolesOf({ ...s, origin: 'file', remote: null, default: false, listed: false, tracker: 'gitlab' })).toEqual(['added by you', 'read only for the refs that name it'])
    expect(rolesOf({ ...s, tracker: 'gitlab' })[1]).toBe('the default for #12 and !7')
  })
  test('what it last read', () => {
    expect(readSaid(s, Date.parse('2026-10-05T12:00:00.000Z'))).toBe('12 issues, 3 changes, 4 min ago')
    expect(readSaid({ ...s, issues: 1, changes: 1 }, Date.parse('2026-10-05T12:00:00.000Z'))).toBe('1 issue, 1 change, 4 min ago')
    expect(readSaid({ ...s, at: null }, 0)).toBe('not read yet')
  })
})

describe('through the reading and the agent’s door', () => {
  const NOW = new Date('2026-10-05T12:00:00.000Z')
  const ok = (out: string): Ran => ({ code: 0, out, err: '' })
  const run: Runner = async (argv) =>
    argv[0] === 'git'
      ? ok('origin\thttps://github.com/Jalez/kehikko.git (fetch)\n')
      : { code: 1, out: '', err: 'nothing' }
  const row = (repo: string, number: number, kind: 'issue' | 'change' = 'issue') => ({
    tracker: 'github' as const,
    host: 'github.com',
    repo,
    ref: `gh#${number}`,
    kind,
    number,
    title: 't',
    state: 'open' as const,
    url: 'u',
    labels: [],
    assignees: [],
    links: [],
    readAt: NOW.toISOString(),
  })
  const adapter = {
    async list(source: Source) {
      return { ok: true as const, rows: [row(source.repo, 1), row(source.repo, 2), row(source.repo, 3, 'change')] as any, notFound: [] }
    },
    async refs() {
      return { ok: true as const, rows: [], notFound: [] }
    },
    async detail() {
      return new Map()
    },
  }

  test('the listing counts what each source read, and a removed source takes its rows', async () => {
    const trackers = new Trackers({ run, adapters: { github: adapter as any }, now: () => NOW })
    await trackers.edit(folder, { kind: 'add', input: 'Jalez/other', tracker: 'github' })
    await trackers.refresh(folder, { project: true })
    const listing = await trackers.describe(folder)
    expect(listing.sources.map((x) => [x.repo, x.origin, x.remote, x.issues, x.changes])).toEqual([
      ['Jalez/kehikko', 'remote', 'origin', 2, 1],
      ['Jalez/other', 'file', null, 2, 1],
    ])
    const text = listingText(listing, NOW.getTime())
    expect(text).toContain("from this project's git remote origin")
    expect(text).toContain('2 issues, 1 change')
    await trackers.edit(folder, { kind: 'set', ...OWN, off: true })
    await trackers.refresh(folder, { project: true })
    const got = trackers.get(folder, { project: true })
    if ('refused' in got) throw new Error(got.refused)
    expect(new Set(got.rows.map((r) => r.repo))).toEqual(new Set(['Jalez/other']))
  })

  test('check reads once and stores nothing', async () => {
    const trackers = new Trackers({ run, adapters: { github: adapter as any }, now: () => NOW })
    const found = await trackers.check({ ...OWN, default: false, listed: false })
    expect(found).toEqual({ ok: true, issues: 2, changes: 1, capped: false })
    expect(existsSync(join(folder, '.kehikot'))).toBe(false)
    const failing = new Trackers({
      run,
      adapters: { github: { ...adapter, list: async () => ({ ok: false as const, why: 'The GitHub CLI (gh) is not logged in to github.com: run `gh auth login`.' }) } as any },
    })
    const bad = await failing.check({ ...OWN, default: false, listed: false })
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.why).toContain('then press Check again')
  })

  test('set_tracker_source: the tool, its refusals, its hints', async () => {
    const db = open(':memory:')
    const added = addProject(db, folder, 'p')
    const project = added.ok ? added.project.id : null
    const made = createCanvas(db, 'k', project)
    editCanvas(db, made.id, { placements: [] })
    if (project !== null) setSubject(db, project, { epic: 'x' })
    const trackers = new Trackers({ run, adapters: { github: adapter as any }, now: () => NOW })
    const door: Door = {
      db,
      which: () => new Openness().open(),
      wake: () => {},
      epicsChanged: () => {},
      dispositionsChanged: () => {},
      seen: async () => [],
      trackers,
    }
    const added2 = await call('set_tracker_source', { kehikko: made.id, action: 'add', source: 'Jalez/other', tracker: 'github' }, door)
    expect(added2.failed).toBe(false)
    expect(added2.text).toContain('Jalez/other: added by you')
    expect(added2.text).toContain('cannot log in')

    const moved = await call('set_tracker_source', { kehikko: made.id, action: 'default', source: 'Jalez/other' }, door)
    expect(moved.failed).toBe(false)
    expect(moved.text).toContain('Jalez/other: added by you; the default for gh#12')

    const removeRemote = await call('set_tracker_source', { kehikko: made.id, action: 'remove', source: 'Jalez/kehikko' }, door)
    expect(removeRemote.failed).toBe(true)
    expect(removeRemote.text).toContain('Turn it off instead')
    expect(removeRemote.text).toContain('Nothing was changed')

    const off = await call('set_tracker_source', { kehikko: made.id, action: 'off', source: 'jalez/kehikko' }, door)
    expect(off.failed).toBe(false)
    expect(off.text).toContain('turned off')

    const stranger = await call('set_tracker_source', { kehikko: made.id, action: 'list', source: 'nobody/nothing' }, door)
    expect(stranger.failed).toBe(true)

    const read = await call('read_tracker', { kehikko: made.id }, door)
    expect(read.text).toContain('Where references like gh#41 or !7 are looked up')
    expect(read.text).toContain('turned off')
    db.close()
    void new Wakes()
  })
})
