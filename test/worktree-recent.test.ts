import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { factsOf, newestReflogEntry, parseWorktrees, type BranchStates } from '../server/worktrees.ts'
import { run } from '../server/versions.ts'
import { RECENT_MS } from '../src/host/worktrees.ts'

/* Issue #271: "changed recently" is read from the work, never from git's own housekeeping. */

const WEEK_AGO = Math.floor((Date.now() - 7 * 24 * 60 * 60_000) / 1000)
const OLD_ENV = { GIT_COMMITTER_DATE: `${WEEK_AGO} +0000`, GIT_AUTHOR_DATE: `${WEEK_AGO} +0000` }

let dir = ''
let repo = ''

function git(cwd: string, args: string[], env: Record<string, string> = OLD_ENV): string {
  const ran = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`)
  return ran.stdout.toString().trim()
}

/** Every file and folder under `path`, `.git` included, set a week back. */
function age(path: string): void {
  const then = new Date(WEEK_AGO * 1000)
  for (const name of readdirSync(path)) {
    const full = join(path, name)
    if (statSync(full).isDirectory()) age(full)
    utimesSync(full, then, then)
  }
  utimesSync(path, then, then)
}

/** A worktree whose last commit, checkout and files are all a week old. */
function oldWorktree(name: string): string {
  const path = join(dir, name)
  git(repo, ['worktree', 'add', '-q', '-b', name, path, 'main'])
  writeFileSync(join(path, `${name}.txt`), name)
  git(path, ['add', '.'])
  git(path, ['commit', '-q', '-m', name])
  age(path)
  age(join(repo, '.git', 'worktrees', name))
  return path
}

/** git's own housekeeping, now: the reflog expired and rewritten, the index and HEAD touched. */
function housekeeping(name: string): void {
  git(repo, ['reflog', 'expire', '--expire=now', '--all'], {})
  const own = join(repo, '.git', 'worktrees', name)
  const now = new Date()
  for (const file of ['index', 'HEAD', join('logs', 'HEAD')]) {
    try {
      utimesSync(join(own, file), now, now)
    } catch {
      writeFileSync(join(own, file), '')
    }
  }
}

const NONE: BranchStates = { changes: [], issues: [] }

async function changedAt(path: string): Promise<number> {
  const ran = await run(['git', '-C', repo, 'worktree', 'list', '--porcelain'])
  if (!ran.ok) throw new Error(ran.why)
  const listed = parseWorktrees(ran.out)
  const entry = listed.find((e) => e.path === path)!
  const facts = await factsOf(entry, repo, 'main', NONE, new Map(), run)
  return facts!.changedAt
}

const recent = (at: number) => Date.now() - at < RECENT_MS

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'kehikot-worktree-recent-')))
  repo = join(dir, 'project')
  mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'README'), 'readme')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'first'])
})

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('when a worktree last changed', () => {
  test('a week-old worktree is not recent', async () => {
    const path = oldWorktree('quiet')
    expect(recent(await changedAt(path))).toBe(false)
  })

  test('git rewriting its reflog, index and HEAD is not a change', async () => {
    const path = oldWorktree('housekept')
    housekeeping('housekept')
    expect(recent(await changedAt(path))).toBe(false)
  })

  test('a tracked file edited now is a change, even with git status clean', async () => {
    const path = oldWorktree('edited')
    const now = new Date()
    utimesSync(join(path, 'README'), now, now)
    expect(recent(await changedAt(path))).toBe(true)
  })

  test('a file nobody added is a change; a generated folder is not', async () => {
    const generatedOnly = oldWorktree('installed')
    mkdirSync(join(generatedOnly, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(generatedOnly, 'node_modules', 'x', 'index.js'), '')
    mkdirSync(join(generatedOnly, 'dist'))
    writeFileSync(join(generatedOnly, 'dist', 'out.js'), '')
    expect(recent(await changedAt(generatedOnly))).toBe(false)

    const loose = oldWorktree('loose')
    writeFileSync(join(loose, 'notes.md'), 'mine')
    expect(recent(await changedAt(loose))).toBe(true)
  })

  test('a commit made now is a change', async () => {
    const path = oldWorktree('committed')
    writeFileSync(join(path, 'more.txt'), 'more')
    git(path, ['add', '.'], {})
    git(path, ['commit', '-q', '-m', 'more'], {})
    age(path)
    expect(recent(await changedAt(path))).toBe(true)
  })

  test('a checkout made now is a change, read from the reflog entry, not the file', async () => {
    const path = oldWorktree('checkedout')
    git(path, ['checkout', '-q', '-b', 'checkedout-2'], {})
    age(path)
    age(join(repo, '.git', 'worktrees', 'checkedout'))
    expect(recent(await changedAt(path))).toBe(true)
  })
})

describe('the newest reflog entry', () => {
  test('is the newest time written in a line, and nothing for an empty or unreadable reflog', () => {
    const z = '0'.repeat(40)
    const text = [`${z} ${'a'.repeat(40)} t <t@t> 1700000000 +0200\tcommit: a`, `${'a'.repeat(40)} ${'b'.repeat(40)} t <t@t> 1700000500 -0500\tcheckout: b`, ''].join('\n')
    expect(newestReflogEntry(text)).toBe(1700000500 * 1000)
    expect(newestReflogEntry('')).toBe(0)
    expect(newestReflogEntry('garbage\n')).toBe(0)
  })
})
