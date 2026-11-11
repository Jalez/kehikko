import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clearStaleLocks, gitRunningIn, lockNamedIn, lockSaid, STALE_LOCK_MS } from '../server/gitLocks.ts'
import { update } from '../server/updates.ts'

/* Leftover git locks in an installed copy: cleared when stale and unused, otherwise kept and said plainly. */

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikot-locks-')))
const installs = join(root, 'installed')
const env = { ...process.env, KEHIKOT_INSTALLS_DIR: installs }
let made = 0
afterAll(() => rmSync(root, { recursive: true, force: true }))

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' }
function run(dir: string, ...args: string[]) {
  const ran = Bun.spawnSync(['git', '-C', dir, ...args], { env: gitEnv })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.toString())
  return ran.stdout.toString().trim()
}

/** A repository with an origin one commit ahead, at `parent/<name>`. */
function copy(parent: string) {
  const base = join(root, `r${(made += 1)}`)
  const origin = join(base, 'origin.git')
  const other = join(base, 'other')
  const here = join(parent, `module${made}`)
  mkdirSync(base, { recursive: true })
  mkdirSync(parent, { recursive: true })
  run(base, 'init', '--quiet', '--bare', '-b', 'main', origin)
  run(base, 'clone', '--quiet', origin, other)
  run(other, 'switch', '--quiet', '-c', 'main')
  writeFileSync(join(other, 'a.txt'), 'one\n')
  run(other, 'add', '.')
  run(other, 'commit', '--quiet', '-m', 'first')
  run(other, 'push', '--quiet', '-u', 'origin', 'main')
  run(parent, 'clone', '--quiet', origin, here)
  writeFileSync(join(other, 'a.txt'), 'two\n')
  run(other, 'commit', '--quiet', '-am', 'second')
  run(other, 'push', '--quiet')
  run(here, 'fetch', '--quiet')
  return here
}

function lock(dir: string, name = 'index.lock', ageMs = 4 * 3600_000) {
  const path = join(dir, '.git', name)
  writeFileSync(path, '')
  const when = new Date(Date.now() - ageMs)
  utimesSync(path, when, when)
  return path
}

const quiet = { env, log: () => {} }

describe('leftover git locks', () => {
  test('a stale lock with no git running is removed, and the update goes ahead', async () => {
    const dir = copy(installs)
    const path = lock(dir)
    const saved = process.env.KEHIKOT_INSTALLS_DIR
    process.env.KEHIKOT_INSTALLS_DIR = installs
    try {
      const done = await update({ id: 'm', name: 'Source', dir })
      expect(done.ok).toBe(true)
    } finally {
      process.env.KEHIKOT_INSTALLS_DIR = saved as string
    }
    expect(existsSync(path)).toBe(false)
    expect(run(dir, 'show', '-s', '--format=%s', 'HEAD')).toBe('second')
  })

  test('other locks (HEAD, a ref) are cleared too, and the removal is logged', () => {
    const dir = copy(installs)
    lock(dir, 'HEAD.lock')
    mkdirSync(join(dir, '.git/refs/heads'), { recursive: true })
    lock(dir, 'refs/heads/main.lock')
    const lines: string[] = []
    const left = clearStaleLocks(dir, { env, log: (line) => lines.push(line), busy: () => false })
    expect(left.map((one) => one.removed)).toEqual([true, true])
    expect(lines).toHaveLength(2)
    expect(lines.join('\n')).toContain('HEAD.lock')
  })

  test('a fresh lock is kept', () => {
    const dir = copy(installs)
    const path = lock(dir, 'index.lock', STALE_LOCK_MS - 30_000)
    const left = clearStaleLocks(dir, { ...quiet, busy: () => false })
    expect(left).toEqual([{ path, removed: false, why: 'fresh' }])
    expect(existsSync(path)).toBe(true)
  })

  test('a lock with a git process using the repository is kept', () => {
    const dir = copy(installs)
    const path = lock(dir)
    const left = clearStaleLocks(dir, { ...quiet, busy: () => true })
    expect(left).toEqual([{ path, removed: false, why: 'busy' }])
    expect(existsSync(path)).toBe(true)
  })

  test('a real git process on the repository is seen', async () => {
    const dir = copy(installs)
    const child = Bun.spawn(['git', '-C', dir, 'hash-object', '--stdin'], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' })
    try {
      await Bun.sleep(150)
      expect(gitRunningIn(dir)).toBe(true)
      const path = lock(dir)
      expect(clearStaleLocks(dir, quiet)[0]?.why).toBe('busy')
      expect(existsSync(path)).toBe(true)
    } finally {
      child.kill()
    }
    await child.exited
    expect(gitRunningIn(dir)).toBe(false)
  })

  test('a lock outside the installed-copies folder is never touched', async () => {
    const dir = copy(join(root, 'somebodys-checkouts'))
    const path = lock(dir)
    expect(clearStaleLocks(dir, { ...quiet, busy: () => false })).toEqual([{ path, removed: false, why: 'outside' }])
    expect(existsSync(path)).toBe(true)
    const done = await update({ id: 'm', name: 'Mine', dir })
    expect(done.ok).toBe(false)
    expect(existsSync(path)).toBe(true)
  })

  test('the message is complete: the module, the lock, what Kehikot does, no clipped git text', async () => {
    const dir = copy(installs)
    lock(dir, 'index.lock', 5_000)
    const saved = process.env.KEHIKOT_INSTALLS_DIR
    process.env.KEHIKOT_INSTALLS_DIR = installs
    try {
      const done = await update({ id: 'm', name: 'Source', dir })
      expect(done.ok).toBe(false)
      if (!done.ok) {
        expect(done.why).toContain('git found a leftover lock file in its installed copy')
        expect(done.why).toContain(join(dir, '.git/index.lock'))
        expect(done.why).toContain('Kehikot removes it automatically when no git process is using it')
        expect(done.why).not.toContain('are terminated')
        expect(done.why).not.toContain('was not updated: git found')
      }
    } finally {
      process.env.KEHIKOT_INSTALLS_DIR = saved as string
    }
  })

  test('lockNamedIn reads the path from git, and only for a lock', () => {
    const said = "fatal: Unable to create '/x/.git/index.lock': File exists.\n\nAnother git process seems to be running"
    expect(lockNamedIn(said)).toBe('/x/.git/index.lock')
    expect(lockNamedIn('fatal: not a git repository')).toBeNull()
    expect(lockSaid('/y/.git/index.lock', join(root, 'elsewhere'), env)).toContain('remove it by hand')
  })
})
