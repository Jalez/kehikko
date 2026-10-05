import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { blockedBy, hostNeedsRestart, readCheckout, topLevels, update, type Checkout } from '../server/updates.ts'

/*
 * Catching a checkout up with GitHub — against real repositories, because what
 * this does is run git in somebody's working tree, and the properties that
 * matter (behind is counted, a dirty tree is left alone, a fast-forward is the
 * only move) are properties of git, not of this module's arithmetic.
 */

const root = mkdtempSync(join(tmpdir(), 'kehikko-updates-'))
let made = 0

afterAll(() => rmSync(root, { recursive: true, force: true }))

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
}

function run(dir: string, ...args: string[]) {
  const ran = Bun.spawnSync(['git', '-C', dir, ...args], { env })
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`)
  return ran.stdout.toString().trim()
}

/** An origin, a clone that pushes to it, and the checkout under test. */
function repos() {
  const base = join(root, `r${(made += 1)}`)
  const origin = join(base, 'origin.git')
  const other = join(base, 'other')
  const here = join(base, 'here')
  mkdirSync(base, { recursive: true })
  run(base, 'init', '--quiet', '--bare', '-b', 'main', origin)
  run(base, 'clone', '--quiet', origin, other)
  run(other, 'switch', '--quiet', '-c', 'main')
  writeFileSync(join(other, 'a.txt'), 'one\n')
  run(other, 'add', '.')
  run(other, 'commit', '--quiet', '-m', 'first')
  run(other, 'push', '--quiet', '-u', 'origin', 'main')
  run(base, 'clone', '--quiet', origin, here)
  const push = (file: string, text: string, subject: string) => {
    mkdirSync(join(other, file, '..'), { recursive: true })
    writeFileSync(join(other, file), text)
    run(other, 'add', '.')
    run(other, 'commit', '--quiet', '-m', subject)
    run(other, 'push', '--quiet')
  }
  return { here, push, place: { id: 'host', name: 'host', dir: here } }
}

async function read(place: { id: string; name: string; dir: string }, fetch = true): Promise<Checkout> {
  const reading = await readCheckout(place, fetch)
  if ('error' in reading) throw new Error(reading.error)
  return reading
}

describe('reading a checkout', () => {
  test('level with its upstream says so', async () => {
    const { place } = repos()
    const c = await read(place)
    expect(c).toMatchObject({ branch: 'main', upstream: 'origin/main', behind: 0, ahead: 0, dirty: false })
    expect(c.blocked).toBe('already up to date')
  })

  test('behind counts the commits and lists them, newest first', async () => {
    const { place, push } = repos()
    push('a.txt', 'two\n', 'second')
    push('b.txt', 'b\n', 'third')
    const c = await read(place)
    expect(c.behind).toBe(2)
    expect(c.incoming.map((one) => one.subject)).toEqual(['third', 'second'])
    expect(c.blocked).toBeNull()
  })

  test('a folder that is not a checkout is unreadable, with a reason', async () => {
    const dir = join(root, `plain${(made += 1)}`)
    mkdirSync(dir)
    const { places, unreadable } = await topLevels([{ id: 'x', name: 'x', dir }])
    expect(places).toEqual([])
    expect(unreadable[0]?.error).toContain('not a git checkout')
  })
})

describe('updating a checkout', () => {
  test('fast-forwards and says what changed', async () => {
    const { place, push } = repos()
    push('server/x.ts', 'x\n', 'server change')
    await read(place)
    const done = await update(place)
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.changed).toEqual(['server/x.ts'])
    expect(hostNeedsRestart(done.changed)).toBe(true)
    expect((await read(place, false)).behind).toBe(0)
  })

  test('leaves uncommitted changes alone', async () => {
    const { place, push, here } = repos()
    push('a.txt', 'two\n', 'second')
    await read(place)
    writeFileSync(join(here, 'a.txt'), 'mine\n')
    const done = await update(place)
    expect(done).toMatchObject({ ok: false, status: 409 })
    if (done.ok) return
    expect(done.why).toContain('uncommitted')
  })

  test('a bun.lock an install rewrote is reset, merged over and reinstalled', async () => {
    const { place, push, here } = repos()
    push('package.json', '{"name":"x"}\n', 'add package')
    run(here, 'pull', '--quiet')
    push('bun.lock', 'lock one\n', 'add lock')
    run(here, 'pull', '--quiet')
    push('bun.lock', 'lock two\n', 'new lock')
    writeFileSync(join(here, 'bun.lock'), 'rewritten by install\n')
    const reading = await read(place)
    expect(reading).toMatchObject({ dirty: true, staleLock: true, blocked: null })
    const done = await update(place)
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.lockfileReset).toBe(true)
    expect(done.installed).toBe(true)
    /* The real `bun install` ran on the merged tree; whatever it left, the install's rewrite is gone. */
    expect(run(here, 'status', '--porcelain', '--untracked-files=no')).not.toContain('rewritten')
    const lock = join(here, 'bun.lock')
    if (existsSync(lock)) expect(readFileSync(lock, 'utf8')).not.toContain('rewritten by install')
  })

  test('reinstalls after a lock reset even when the incoming commits leave dependencies alone', async () => {
    const { place, push, here } = repos()
    push('bun.lock', 'lock one\n', 'add lock')
    run(here, 'pull', '--quiet')
    push('a.txt', 'two\n', 'second')
    writeFileSync(join(here, 'bun.lock'), 'rewritten\n')
    await read(place)
    const done = await update(place)
    expect(done).toMatchObject({ ok: true, lockfileReset: true })
    if (done.ok) expect(done.changed).toEqual(['a.txt'])
  })

  test('bun.lock plus another modified file still refuses, and touches nothing', async () => {
    const { place, push, here } = repos()
    push('bun.lock', 'lock one\n', 'add lock')
    run(here, 'pull', '--quiet')
    push('a.txt', 'two\n', 'second')
    writeFileSync(join(here, 'bun.lock'), 'rewritten\n')
    writeFileSync(join(here, 'a.txt'), 'mine\n')
    await read(place)
    const done = await update(place)
    expect(done).toMatchObject({ ok: false, status: 409 })
    if (done.ok) return
    expect(done.why).toContain('uncommitted')
    expect(readFileSync(join(here, 'bun.lock'), 'utf8')).toBe('rewritten\n')
  })

  test('untracked files alone do not block, and nothing is reset or reinstalled', async () => {
    const { place, push, here } = repos()
    push('a.txt', 'two\n', 'second')
    writeFileSync(join(here, 'notes.txt'), 'mine\n')
    const reading = await read(place)
    expect(reading).toMatchObject({ dirty: false, staleLock: false, blocked: null })
    const done = await update(place)
    expect(done).toMatchObject({ ok: true, lockfileReset: false, installed: false })
  })

  test('a cancel before the merge changes nothing', async () => {
    const { place, push } = repos()
    push('a.txt', 'two\n', 'second')
    await read(place)
    const cancelled = new AbortController()
    cancelled.abort()
    const done = await update(place, cancelled.signal)
    expect(done).toMatchObject({ ok: false, status: 499 })
    expect((await read(place, false)).behind).toBe(1)
  })

  test('refuses a branch with commits of its own', async () => {
    const { place, push, here } = repos()
    push('a.txt', 'two\n', 'second')
    writeFileSync(join(here, 'c.txt'), 'c\n')
    run(here, 'add', '.')
    run(here, 'commit', '--quiet', '-m', 'local')
    await read(place)
    const done = await update(place)
    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.why).toContain('of its own')
  })
})

describe('the rules, as data', () => {
  test('every refusal is a sentence, and only a clean tracked branch that is behind goes ahead', () => {
    const level = { branch: 'main', upstream: 'origin/main', dirty: false, ahead: 0, behind: 3 }
    expect(blockedBy(level)).toBeNull()
    expect(blockedBy({ ...level, branch: null })).toContain('detached')
    expect(blockedBy({ ...level, upstream: null })).toContain('tracks no remote')
    expect(blockedBy({ ...level, behind: 0 })).toBe('already up to date')
  })

  test('only server-side changes need the host restarted', () => {
    expect(hostNeedsRestart(['src/canvas/Bar.tsx'])).toBe(false)
    expect(hostNeedsRestart(['bun.lock'])).toBe(true)
    expect(hostNeedsRestart(['run.sh'])).toBe(true)
  })
})
