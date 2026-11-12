import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installDesk } from '../server/installs.ts'
import { gitFraction, JobSteps, STALLED_AFTER_MS } from '../server/jobSteps.ts'
import type { Official } from '../server/official.ts'
import { update } from '../server/updates.ts'
import { run, type Ran, type Runner } from '../server/versions.ts'

/*
 * An install and an update said step by step (`server/jobSteps.ts`): the steps
 * in order, git's progress as a fraction, a stall said after a minute, and
 * Cancel stopping the processes of that one job and nothing else.
 */

const root = mkdtempSync(join(tmpdir(), 'kehikko-steps-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('git progress as a fraction', () => {
  test('receiving is most of the bar, resolving the rest; the last line counts', () => {
    expect(gitFraction('Cloning into x...\nremote: Counting objects: 100% (12/12), done.\r')).toBeCloseTo(0.05)
    expect(gitFraction('Receiving objects:   0% (0/400)\rReceiving objects:  50% (200/400), 1.2 MiB | 2 MiB/s\r')).toBeCloseTo(0.475)
    expect(gitFraction('Receiving objects: 100% (400/400), done.\nResolving deltas:  40% (40/100)\r')).toBeCloseTo(0.91)
    expect(gitFraction('Resolving deltas: 100% (100/100), done.\n')).toBeCloseTo(1)
    expect(gitFraction('remote: Compressing objects:  50% (5/10)\r')).toBeCloseTo(0.075)
  })

  test('text with no progress in it is no fraction', () => {
    expect(gitFraction('Cloning into x...\n')).toBeNull()
    expect(gitFraction('')).toBeNull()
  })
})

describe('a job', () => {
  test('says each step with its time, and the steps before it', () => {
    let now = 1_000
    const steps = new JobSteps({ now: () => now })
    const job = steps.begin('kehikot.notes', 'Notes', 'install')
    job.to('cloning')
    now += 2_000
    job.fraction(0.5)
    expect(steps.said()['kehikot.notes']).toMatchObject({ step: 'cloning', fraction: 0.5, stepMs: 2_000, totalMs: 2_000 })
    job.to('installing')
    now += 12_000
    const said = steps.said()['kehikot.notes']!
    expect(said).toMatchObject({ step: 'installing', fraction: null, stepMs: 12_000, totalMs: 14_000, stalled: false, cancellable: true })
    expect(said.steps).toEqual([
      { step: 'queued', ms: 0 },
      { step: 'cloning', ms: 2_000 },
    ])
    job.done()
    expect(steps.said()['kehikot.notes']).toMatchObject({ step: 'done', cancellable: false, totalMs: 14_000 })
  })

  test('nothing moving for a minute is said as stalled; output or a new fraction is moving', () => {
    let now = 0
    const steps = new JobSteps({ now: () => now })
    const job = steps.begin('kehikot.notes', 'Notes', 'update')
    job.to('installing')
    now += STALLED_AFTER_MS - 1
    expect(steps.said()['kehikot.notes']!.stalled).toBe(false)
    now += 1
    expect(steps.said()['kehikot.notes']!.stalled).toBe(true)
    job.watch().output?.('resolving…')
    expect(steps.said()['kehikot.notes']!.stalled).toBe(false)
    now += STALLED_AFTER_MS
    expect(steps.said()['kehikot.notes']!.stalled).toBe(true)
    job.fail('it stopped')
    expect(steps.said()['kehikot.notes']).toMatchObject({ stalled: false, step: 'failed', failed: { step: 'installing', why: 'it stopped' } })
  })

  test('a failure names the step it failed at', () => {
    const steps = new JobSteps()
    const job = steps.begin('kehikot.notes', 'Notes', 'install')
    job.to('building')
    job.fail('the build did not finish')
    expect(steps.said()['kehikot.notes']!.failed).toEqual({ step: 'building', why: 'the build did not finish' })
  })

  test('a third one waits its turn, and says how many are ahead', async () => {
    const steps = new JobSteps()
    const a = steps.begin('a', 'A', 'update')
    const b = steps.begin('b', 'B', 'update')
    const c = steps.begin('c', 'C', 'update')
    const giveA = await steps.slots.take(a)
    const giveB = await steps.slots.take(b)
    let cGot = false
    const cTurn = steps.slots.take(c).then((give) => {
      cGot = true
      return give
    })
    await Bun.sleep(1)
    expect(cGot).toBe(false)
    expect(steps.said()['c']).toMatchObject({ step: 'queued', detail: '2 ahead' })
    giveA()
    ;(await cTurn)()
    expect(cGot).toBe(true)
    giveB()
  })
})

describe('Cancel', () => {
  test("stops only that job's processes, by pid", async () => {
    const steps = new JobSteps()
    const job = steps.begin('kehikot.notes', 'Notes', 'install')
    const other = steps.begin('kehikot.slides', 'Slides', 'install')
    job.to('installing')
    other.to('installing')
    const mine = run(['sleep', '30'], { timeoutMs: 60_000, watch: job.watch() })
    const theirs = run(['sleep', '30'], { timeoutMs: 60_000, watch: other.watch() })
    /* And a process nobody's job started. */
    const bystander = Bun.spawn(['sleep', '30'])
    await Bun.sleep(50)
    expect(job.children).toHaveLength(1)
    const [minePid] = job.children
    const [theirPid] = other.children
    expect(steps.cancel('kehikot.notes')).toBe(true)
    const ended = await mine
    expect(ended.ok).toBe(false)
    expect(job.signal.aborted).toBe(true)
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    expect(alive(minePid!)).toBe(false)
    expect(alive(theirPid!)).toBe(true)
    expect(alive(bystander.pid)).toBe(true)
    expect(other.signal.aborted).toBe(false)
    other.cancel()
    await theirs
    bystander.kill()
  }, 10_000)
})

const notes: Official = { id: 'kehikot.notes', name: 'Notes', repo: 'Jalez/kehikko-notes', port: 7940, summary: 'Notes.', tags: ['reading'] }

describe('an install, step by step', () => {
  function world(answers: (argv: readonly string[]) => Ran | Promise<Ran>) {
    const base = mkdtempSync(join(root, 'install-'))
    const registry = join(base, 'modules')
    const steps = new JobSteps()
    const runner: Runner = async (argv, options) => {
      if (argv[1] === 'clone') options?.watch?.output?.('Receiving objects:  60% (6/10)\r')
      const ran = await answers(argv)
      if (argv[1] === 'clone' && ran.ok) mkdirSync(argv[argv.length - 1]!, { recursive: true })
      return ran
    }
    const desk = installDesk({
      list: [notes],
      run: runner,
      root: join(base, 'installed'),
      registry,
      bun: () => ({ bun: 'bun', env: {} }),
      registered: async () => (existsSync(registry) ? readdirSync(registry).map((name) => ({ id: name.replace(/\.json$/, ''), port: null })) : []),
      releases: { settle: async () => ({ ok: true, tag: 'v1.6.0' }) },
      build: async () => {
        await Bun.sleep(5)
        return null
      },
      steps,
    })
    return { desk, steps }
  }

  async function ended(steps: JobSteps, id: string) {
    for (let i = 0; i < 400; i++) {
      const job = steps.get(id)
      if (job?.ended) return job.said()
      await Bun.sleep(5)
    }
    throw new Error('it never ended')
  }

  test('cloning, checking out the release, installing, building, done — in that order, with the clone a fraction', async () => {
    const slow = async (): Promise<Ran> => {
      await Bun.sleep(5)
      return { ok: true, out: '' }
    }
    const { desk, steps } = world(slow)
    let fraction: number | null = null
    const peek = setInterval(() => {
      const said = steps.said()['kehikot.notes']
      if (said?.step === 'cloning' && said.fraction !== null) fraction = said.fraction
    }, 0)
    await desk.install('kehikot.notes')
    const said = await ended(steps, 'kehikot.notes')
    clearInterval(peek)
    expect(said.step).toBe('done')
    expect(said.steps.map((one) => one.step)).toEqual(['queued', 'cloning', 'checkout', 'installing', 'building'])
    expect(fraction).not.toBeNull()
    expect(fraction!).toBeCloseTo(0.1 + 0.75 * 0.6)
  })

  test('a failure says the step and the reason, in words', async () => {
    const { desk, steps } = world((argv) => (argv.includes('install') ? { ok: false, why: 'lockfile had changes' } : { ok: true, out: '' }))
    await desk.install('kehikot.notes')
    const said = await ended(steps, 'kehikot.notes')
    expect(said.failed?.step).toBe('installing')
    expect(said.failed?.why).toContain('its dependencies could not be installed')
  })

  test('Cancel stops it where it is, and says so', async () => {
    let started: () => void = () => {}
    const cloning = new Promise<void>((done) => (started = done))
    const { desk, steps } = world(async (argv) => {
      if (argv[1] === 'clone') {
        started()
        await Bun.sleep(30)
      }
      return { ok: true, out: '' }
    })
    await desk.install('kehikot.notes')
    await cloning
    expect(steps.cancel('kehikot.notes')).toBe(true)
    const said = await ended(steps, 'kehikot.notes')
    expect(said.failed?.step).toBe('cloning')
    expect(said.failed?.why).toBe('Installing Notes was cancelled while downloading it. Nothing was registered; press Install to try again.')
    expect((await desk.list())[0]!.installed).toBe(false)
  })
})

describe('an update, step by step', () => {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' }
  const git = (dir: string, ...args: string[]) => {
    const ran = Bun.spawnSync(['git', '-C', dir, ...args], { env })
    if (ran.exitCode !== 0) throw new Error(ran.stderr.toString())
  }

  test('checking out, installing dependencies — in that order', async () => {
    const base = mkdtempSync(join(root, 'update-'))
    const origin = join(base, 'origin.git')
    const other = join(base, 'other')
    const here = join(base, 'here')
    git(base, 'init', '--quiet', '--bare', '-b', 'main', origin)
    git(base, 'clone', '--quiet', origin, other)
    git(other, 'switch', '--quiet', '-c', 'main')
    writeFileSync(join(other, 'package.json'), '{"name":"m","version":"1.0.0"}\n')
    writeFileSync(join(other, 'bun.lock'), '{"lockfileVersion":1,"workspaces":{"":{"name":"m"}},"packages":{}}\n')
    git(other, 'add', '.')
    git(other, 'commit', '--quiet', '-m', 'first')
    git(other, 'push', '--quiet', '-u', 'origin', 'main')
    git(base, 'clone', '--quiet', origin, here)
    writeFileSync(join(other, 'package.json'), '{"name":"m","version":"1.1.0"}\n')
    git(other, 'commit', '--quiet', '-am', 'second')
    git(other, 'push', '--quiet')
    git(here, 'fetch', '--quiet')

    const steps = new JobSteps()
    const job = steps.begin('m', 'M', 'update')
    const done = await update({ id: 'm', name: 'M', dir: here }, job.signal, { job })
    expect(done.ok).toBe(true)
    job.done()
    expect(steps.said()['m']!.steps.map((one) => one.step)).toEqual(['queued', 'checkout', 'installing'])
    expect(steps.said()['m']!.step).toBe('done')
  }, 30_000)
})
