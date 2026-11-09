import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureSettings, settingsRoute } from '../server/agentSettings.ts'
import { PAGE_ONLY } from '../server/guard.ts'
import { branchChangesOf } from '../server/trackers/github.ts'
import { mergeChangesOf } from '../server/trackers/gitlab.ts'
import { parseWorktrees, readWorktreeAuto, Worktrees, type Output, type WorktreeDeps } from '../server/worktrees.ts'
import { decide, doneSaid, generated, keptSaid, RECENT_MS, WORKTREE_CLEANUP_DEFAULT, type Facts } from '../src/host/worktrees.ts'

/**
 * Cleaning up finished worktrees (`src/host/worktrees.ts`, `server/worktrees.ts`):
 * the rule, each reason a worktree is left alone, and the scan and removal
 * against real repositories in a temporary folder — never a real project.
 */

const DAY = 24 * 60 * 60_000
const NOW = Date.UTC(2026, 10, 4, 12)

const facts = (more: Partial<Facts> = {}): Facts => ({
  path: '/p/wt',
  repo: '/p',
  branch: 'feature',
  head: 'a'.repeat(40),
  base: 'origin/main',
  locked: false,
  tracked: 0,
  untracked: [],
  unpushed: 0,
  contained: false,
  changedAt: NOW - 3 * DAY,
  busy: null,
  changes: [{ sign: '#', number: 12, state: 'merged' }],
  issues: [],
  ...more,
})

describe('the rule', () => {
  test('finished by a merged or closed request, by the default branch, or by closed issues', () => {
    const merged = decide(facts(), NOW)
    expect(merged.offer && doneSaid(merged.done)).toBe('PR #12 merged')
    const closed = decide(facts({ changes: [{ sign: '!', number: 3, state: 'closed' }] }), NOW)
    expect(closed.offer && doneSaid(closed.done)).toBe('MR !3 closed')
    const contained = decide(facts({ changes: [], contained: true }), NOW)
    expect(contained.offer && doneSaid(contained.done)).toBe('contained in main')
    const issue = decide(facts({ changes: [], issues: [{ number: 7, state: 'closed' }] }), NOW)
    expect(issue.offer && doneSaid(issue.done)).toBe('issue #7 closed')
    expect(issue.offer && issue.deleteBranch).toBe(false)
    expect(merged.offer && merged.deleteBranch).toBe(true)
  })

  test('an open request keeps it, even when an older one merged', () => {
    const d = decide(facts({ changes: [{ sign: '#', number: 12, state: 'merged' }, { sign: '#', number: 13, state: 'open' }], contained: true }), NOW)
    expect(d.offer).toBe(false)
    expect(!d.offer && keptSaid(d.kept)).toBe('PR #13 is still open')
  })

  test('not finished: nothing merged, closed or contained', () => {
    const d = decide(facts({ changes: [], issues: [{ number: 7, state: 'open' }] }), NOW)
    expect(!d.offer && d.kept.kind).toBe('not-done')
  })

  const kept = (more: Partial<Facts>) => {
    const d = decide(facts(more), NOW)
    expect(d.offer).toBe(false)
    return d.offer ? '' : d.kept.kind
  }

  test('each safety rule keeps a finished worktree', () => {
    expect(kept({ locked: true })).toBe('locked')
    expect(kept({ tracked: 2 })).toBe('tracked')
    expect(kept({ untracked: ['notes.md'] })).toBe('untracked')
    expect(kept({ unpushed: 1 })).toBe('unpushed')
    expect(kept({ changedAt: NOW - RECENT_MS + 60_000 })).toBe('recent')
    expect(kept({ busy: 4242 })).toBe('busy')
  })

  test('generated folders alone are removed with force; commits that are the request’s head are not unpushed', () => {
    const d = decide(facts({ untracked: ['node_modules', 'packages/a/dist'] }), NOW)
    expect(d.offer && d.force).toBe(true)
    expect(decide(facts(), NOW).offer && (decide(facts(), NOW) as { force: boolean }).force).toBe(false)
    const head = 'b'.repeat(40)
    expect(decide(facts({ unpushed: 2, head, changes: [{ sign: '#', number: 1, state: 'closed', head }] }), NOW).offer).toBe(true)
    expect(generated('src/node_modules/x')).toBe(true)
    expect(generated('src/index.ts')).toBe(false)
  })

  test('the words name no reason twice and say each one', () => {
    expect(keptSaid({ kind: 'busy', pid: 9 })).toBe('a running process (pid 9) works in it')
    expect(keptSaid({ kind: 'unpushed', count: 1 })).toBe('1 commit is not pushed anywhere')
    expect(keptSaid({ kind: 'tracked', count: 3 })).toBe('3 tracked files have changes')
  })
})

describe('reading the tracker and git', () => {
  test('requests by branch leave out forks', () => {
    expect(
      branchChangesOf([
        { number: 1, state: 'MERGED', headRefName: 'a', headRefOid: 'c'.repeat(40), isCrossRepository: false },
        { number: 2, state: 'OPEN', headRefName: 'b', isCrossRepository: true },
      ]),
    ).toEqual([{ branch: 'a', number: 1, state: 'merged', head: 'c'.repeat(40) }])
    expect(
      mergeChangesOf([
        { iid: 4, state: 'opened', source_branch: 'x', source_project_id: 1, target_project_id: 1 },
        { iid: 5, state: 'merged', source_branch: 'y', source_project_id: 2, target_project_id: 1 },
      ]),
    ).toEqual([{ branch: 'x', number: 4, state: 'open' }])
  })

  test('the porcelain list', () => {
    const listed = parseWorktrees('worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /w\nHEAD def\ndetached\nlocked why\n\nworktree /gone\nHEAD 123\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n')
    expect(listed.map((l) => [l.path, l.branch, l.locked, l.prunable])).toEqual([
      ['/r', 'main', false, false],
      ['/w', null, true, false],
      ['/gone', 'x', false, true],
    ])
  })
})

/* ------------------------------------------------------------------ *
 * Real repositories in a temporary folder
 * ------------------------------------------------------------------ */

let dir = ''
let repo = ''
let wts = ''

function git(cwd: string, ...args: string[]): string {
  const ran = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`)
  return ran.stdout.toString().trim()
}

function worktree(name: string, from = 'main'): string {
  const path = join(wts, name)
  git(repo, 'worktree', 'add', '-q', '-b', name, path, from)
  return path
}

function commit(path: string, file: string): string {
  writeFileSync(join(path, file), file)
  git(path, 'add', file)
  git(path, 'commit', '-q', '-m', file)
  return git(path, 'rev-parse', 'HEAD')
}

const heads: Record<string, string> = {}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'kehikot-worktrees-')))
  const origin = join(dir, 'origin.git')
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin)
  repo = join(dir, 'project')
  git(dir, 'clone', '-q', origin, repo)
  git(repo, 'checkout', '-q', '-b', 'main')
  commit(repo, 'README')
  git(repo, 'push', '-q', '-u', 'origin', 'main')
  git(repo, 'remote', 'set-head', 'origin', 'main')
  wts = join(dir, 'wts')
  mkdirSync(wts)

  /* A merged request, pushed. */
  heads.merged = commit(worktree('merged'), 'a.txt')
  git(join(wts, 'merged'), 'push', '-q', 'origin', 'merged')
  /* Nothing on it but main. */
  worktree('contained')
  /* Its issue is closed, pushed. */
  commit(worktree('issue-7'), 'i.txt')
  git(join(wts, 'issue-7'), 'push', '-q', 'origin', 'issue-7')
  /* Still open. */
  commit(worktree('open'), 'o.txt')
  /* Merged, but a tracked file changed since. */
  const dirty = worktree('dirty')
  writeFileSync(join(dirty, 'README'), 'changed')
  /* Contained, with a file nobody added. */
  writeFileSync(join(worktree('loose'), 'notes.md'), 'mine')
  /* Contained, with only node_modules untracked. */
  const modules = worktree('modules')
  mkdirSync(join(modules, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(modules, 'node_modules', 'x', 'index.js'), '')
  /* Closed, with a commit pushed nowhere. */
  commit(worktree('unpushed'), 'u.txt')
  /* Contained and locked. */
  worktree('locked')
  git(repo, 'worktree', 'lock', join(wts, 'locked'))
  /* Contained, and a process works in it. */
  worktree('busy')
  /* Contained, changed an hour before "now". */
  worktree('recent')
})

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/* "Now" is two days after the fixtures were made, so only `recent` is recent. */
const later = () => Date.now() + 2 * DAY

const fakeOutput: Output = async (argv) => {
  if (argv[0] === 'lsof') return `p4242\nn${join(wts, 'busy')}\np1\nn/\n`
  if (argv.includes('du')) return `2048\t${argv[argv.length - 1]}\n`
  return null
}

function deps(db: Database, told: Array<[number, string]> = []): WorktreeDeps {
  return {
    db,
    projects: () => [{ id: 1, name: 'project', path: repo }],
    branchStates: async () => ({
      changes: [
        { branch: 'merged', number: 1, state: 'merged', head: heads.merged, sign: '#' },
        { branch: 'dirty', number: 2, state: 'merged', sign: '#' },
        { branch: 'open', number: 3, state: 'open', sign: '#' },
        { branch: 'unpushed', number: 4, state: 'closed', sign: '#' },
      ],
      issues: [{ branch: 'issue-7', number: 7, state: 'closed' }],
      notes: [],
    }),
    tell: (project, line) => told.push([project, line]),
    output: fakeOutput,
    now: later,
  }
}

describe('the scan and the removal, on real repositories', () => {
  test('offers what is finished and safe, says why the rest are left alone, and never the main checkout', async () => {
    /* A file edited in the working tree is work; the folder's own time is not read. */
    const soon = new Date(later() - 60 * 60_000)
    utimesSync(join(wts, 'recent', 'README'), soon, soon)

    const db = new Database(':memory:')
    const worktrees = new Worktrees(deps(db))
    const scan = await worktrees.scan()
    const rows = scan.projects[0]!.rows
    const by = new Map(rows.map((r) => [r.branch, r]))
    expect([...by.keys()]).not.toContain('main')
    expect(rows.some((r) => r.path === repo)).toBe(false)

    expect(by.get('merged')).toMatchObject({ done: 'PR #1 merged', kept: null, bytes: 2048 * 1024 })
    expect(by.get('contained')).toMatchObject({ done: 'contained in main', kept: null })
    expect(by.get('issue-7')).toMatchObject({ done: 'issue #7 closed', kept: null })
    expect(by.get('modules')).toMatchObject({ kept: null })
    expect(by.get('dirty')?.kept).toBe('1 tracked file has changes')
    expect(by.get('loose')?.kept).toBe('it has files git does not track: notes.md')
    expect(by.get('unpushed')?.kept).toBe('1 commit is not pushed anywhere')
    expect(by.get('locked')?.kept).toBe('it is locked')
    expect(by.get('busy')?.kept).toBe('a running process (pid 4242) works in it')
    expect(by.get('recent')?.kept).toBe('something in it changed in the last 24 hours')
    /* An open request is in progress: not listed, counted. */
    expect(by.has('open')).toBe(false)
    expect(scan.projects[0]!.notes).toContain('1 other worktree is still in progress and not listed.')

    const offered = rows.filter((r) => r.kept === null).map((r) => r.path)
    const answer = await worktrees.remove([...offered, join(wts, 'dirty'), repo])
    expect(answer.removed.map((r) => r.branch).sort()).toEqual(['contained', 'issue-7', 'merged', 'modules'])
    expect(answer.skipped.map((s) => s.path).sort()).toEqual([join(wts, 'dirty'), repo].sort())
    for (const path of offered) expect(existsSync(path)).toBe(false)
    expect(existsSync(join(wts, 'dirty', 'README'))).toBe(true)
    expect(existsSync(join(repo, 'README'))).toBe(true)

    const branches = git(repo, 'branch', '--format=%(refname:short)').split('\n')
    /* Merged, or its request merged: gone. Its issue closed, not merged: kept. */
    expect(branches).not.toContain('merged')
    expect(branches).not.toContain('contained')
    expect(branches).toContain('issue-7')
    expect(branches).toContain('main')
    /* No remote branch is ever deleted. */
    const remote = git(join(dir, 'origin.git'), 'branch', '--format=%(refname:short)').split('\n')
    expect(remote).toEqual(expect.arrayContaining(['main', 'merged', 'issue-7']))
    expect(git(repo, 'worktree', 'list')).not.toContain(join(wts, 'merged'))
  }, 60_000)

  test('a path the last scan did not offer is never removed', async () => {
    const db = new Database(':memory:')
    const worktrees = new Worktrees(deps(db))
    const answer = await worktrees.remove([join(wts, 'locked')])
    expect(answer.removed).toEqual([])
    expect(answer.skipped[0]?.why).toBe('it was not offered by the last scan')
    expect(existsSync(join(wts, 'locked'))).toBe(true)
  })
})

describe('removing them automatically', () => {
  test('is off by default, and off does nothing', async () => {
    expect(WORKTREE_CLEANUP_DEFAULT).toBe(false)
    const db = new Database(':memory:')
    expect(readWorktreeAuto(db)).toBe(false)
    const worktrees = new Worktrees(deps(db))
    expect(await worktrees.tick()).toBeNull()
    expect(worktrees.state().scan).toBeNull()
  })

  test('the settings say it, and a change turns it on; on, it runs once a day and says what it freed', async () => {
    const db = new Database(':memory:')
    ensureSettings(db)
    const route = settingsRoute({ db, status: () => ({}) as never, changed: () => {}, skillsAt: () => '/x', hook: () => ({}) as never })
    const read = await route(new Request('http://h/host/settings'), new URL('http://h/host/settings'))
    expect(((await read!.json()) as { worktrees: { auto: boolean } }).worktrees).toEqual({ auto: false })
    const post = new Request('http://h/host/settings', { method: 'POST', body: JSON.stringify({ worktrees: { auto: true } }) })
    const changed = await route(post, new URL('http://h/host/settings'))
    expect(((await changed!.json()) as { worktrees: { auto: boolean } }).worktrees).toEqual({ auto: true })

    const fresh = worktree('auto-fresh')
    const told: Array<[number, string]> = []
    const worktrees = new Worktrees(deps(db, told))
    const answer = await worktrees.tick()
    expect(answer?.removed.map((r) => r.path)).toContain(fresh)
    expect(existsSync(fresh)).toBe(false)
    expect(told).toHaveLength(1)
    expect(told[0]![1]).toMatch(/^Removed \d+ finished worktrees?, freeing /)
    /* Not again the same day. */
    expect(await worktrees.tick()).toBeNull()
  }, 60_000)

  test('the writes are the page’s alone', () => {
    expect(PAGE_ONLY).toContain('/host/worktrees/scan')
    expect(PAGE_ONLY).toContain('/host/worktrees/remove')
  })
})
