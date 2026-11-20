import { describe, expect, test } from 'bun:test'

import { Nursery, type Held, type Runnable, type Started } from '../server/launch.ts'
import { Processes, type ProcessDeps } from '../server/supervisor/processes.ts'
import { ModuleStates } from '../server/supervisor/state.ts'

/*
 * The module processes the host runs (`server/supervisor/processes.ts`), with the spawn, the clock,
 * the log and the nursery's signals faked: nothing here creates or signals a process. What the host
 * does with an end is the supervisor's, pinned from outside in `supervisor.test.ts`.
 */

const RUNNABLE: Runnable = { id: 'kehikot.a', dir: '/m/a', script: '/m/a/run.sh', command: '/m/a/run.sh', url: 'http://127.0.0.1:7001', port: 7001 } as Runnable

function world(overrides: Partial<ProcessDeps> = {}) {
  let now = 1_000
  let pid = 100
  const signals: [number, string][] = []
  const said: string[] = []
  const forgot: string[] = []
  const fresh: string[] = []
  const marks: string[] = []
  const ended: [string, number, number | null][] = []
  const spawned: { run: Runnable; exited: (code: number | null) => void; alive: boolean }[] = []
  const states = new ModuleStates()
  const nursery = new Nursery((p, sig) => void signals.push([p, String(sig)]), () => {})
  const processes = new Processes({
    states,
    nursery,
    addresses: () => false,
    namedPorts: () => new Set(),
    startup: { mark: (step) => void marks.push(step) },
    manifests: { forget: (id) => void forgot.push(id) },
    staleness: { fresh: (id) => void fresh.push(id) },
    onEnded: (id, at, code) => void ended.push([id, at, code]),
    log: (line) => void said.push(line),
    now: () => now,
    logFile: (id) => `/logs/${id}.log`,
    openRun: () => {},
    takesAnyPort: () => false,
    start: (run, exited) => {
      const one = { run, exited: exited!, alive: true }
      spawned.push(one)
      return { ok: true, command: run.command, child: { pid: ++pid, alive: () => one.alive }, token: 'f'.repeat(32) } as Started
    },
    ...overrides,
  })
  return { processes, states, nursery, spawned, signals, said, forgot, fresh, marks, ended, tick: (ms: number) => (now += ms), end: (n: number, code: number | null) => {
    spawned[n]!.alive = false
    spawned[n]!.exited(code)
  } }
}

describe('Processes.run', () => {
  test('runs the script with its log, keeps the child, and stops believing what was believed before', () => {
    const w = world()
    w.states.theirs.set('kehikot.a', 1)
    w.states.sleeping.set('kehikot.a', 1)
    w.states.failures.set('kehikot.a', { line: 'x', detail: [] })
    const ran = w.processes.run('kehikot.a', RUNNABLE)
    expect(ran.ok).toBe(true)
    expect(w.spawned[0]!.run.log).toBe('/logs/kehikot.a.log')
    expect(w.spawned[0]!.run.port).toBe(7001)
    expect(w.nursery.holds('kehikot.a')).toBe(true)
    expect(w.nursery.startedAt('kehikot.a')).toBe(1_000)
    expect(w.nursery.tokenOf('kehikot.a')).toBe('f'.repeat(32))
    expect(w.states.runs.get('kehikot.a')).toBe(1_000)
    expect(w.states.starting.get('kehikot.a')).toBe(1_000)
    expect([w.states.theirs.has('kehikot.a'), w.states.sleeping.has('kehikot.a'), w.states.failures.has('kehikot.a')]).toEqual([false, false, false])
    expect(w.marks).toEqual(['started kehikot.a'])
    expect(w.forgot).toEqual(['kehikot.a'])
    expect(w.fresh).toEqual(['kehikot.a'])
  })

  test('a log that cannot be opened is not a reason to refuse: run without one', () => {
    const w = world({ openRun: () => { throw new Error('read-only') } })
    expect(w.processes.run('kehikot.a', RUNNABLE).ok).toBe(true)
    expect(w.spawned[0]!.run.log).toBeUndefined()
  })

  test('a spawn that failed keeps nothing and believes nothing new, but it is no longer somebody else’s to wait for', () => {
    const w = world({ start: (run) => ({ ok: false, command: run.command, why: 'no such file' }) })
    w.states.theirs.set('kehikot.a', 1)
    w.states.failures.set('kehikot.a', { line: 'x', detail: [] })
    expect(w.processes.run('kehikot.a', RUNNABLE)).toEqual({ ok: false, command: RUNNABLE.command, why: 'no such file' })
    expect(w.nursery.holds('kehikot.a')).toBe(false)
    expect(w.states.runs.has('kehikot.a')).toBe(false)
    expect(w.states.failures.has('kehikot.a')).toBe(true)
    expect(w.states.theirs.has('kehikot.a')).toBe(false)
    expect(w.marks).toEqual([])
  })

  test('a module that takes any port is handed one of the band that no registration names, only with addresses on', () => {
    const on = world({ addresses: () => true, takesAnyPort: () => true, namedPorts: () => new Set([7001]) })
    const ran = on.processes.run('kehikot.a', RUNNABLE)
    const handed = on.spawned[0]!.run.port!
    expect(ran.anyPort).toBe(true)
    expect(handed).not.toBe(7001)
    expect(handed).toBeGreaterThan(0)
    expect(on.spawned[0]!.run.command).toBe(`PORT=${handed} /m/a/run.sh`)

    const off = world({ addresses: () => false, takesAnyPort: () => true })
    off.processes.run('kehikot.a', RUNNABLE)
    expect(off.spawned[0]!.run.port).toBe(7001)
    const plain = world({ addresses: () => true, takesAnyPort: () => false })
    expect(plain.processes.run('kehikot.a', RUNNABLE).anyPort).toBeUndefined()
  })
})

describe('an end', () => {
  test('of the run the host is waiting on is news: its exit is kept, what it served forgotten, and the supervisor told once', () => {
    const w = world()
    w.processes.run('kehikot.a', RUNNABLE)
    w.forgot.length = 0
    w.end(0, 1)
    expect(w.states.exits.get('kehikot.a')).toBe(1)
    expect(w.states.runs.has('kehikot.a')).toBe(false)
    expect(w.forgot).toEqual(['kehikot.a'])
    expect(w.ended).toEqual([['kehikot.a', 1_000, 1]])
  })

  test('of a run the host stopped on purpose is not news', () => {
    const w = world()
    w.processes.run('kehikot.a', RUNNABLE)
    expect(w.processes.halt('kehikot.a')).toBe('stopped')
    expect(w.signals).toEqual([[-101, 'SIGTERM']])
    w.end(0, null)
    expect(w.states.exits.get('kehikot.a')).toBeNull()
    expect(w.ended).toEqual([])
  })

  test('of a run that was replaced is not news; the new run’s end is', () => {
    const w = world()
    w.processes.run('kehikot.a', RUNNABLE)
    w.tick(500)
    w.processes.run('kehikot.a', RUNNABLE)
    w.end(0, 1)
    expect(w.ended).toEqual([])
    expect(w.states.runs.get('kehikot.a')).toBe(1_500)
    w.end(1, 2)
    expect(w.ended).toEqual([['kehikot.a', 1_500, 2]])
  })

  test('halt of a module the host does not hold: not ours, nothing signalled, its run forgotten', () => {
    const w = world()
    w.states.runs.set('kehikot.a', 5)
    expect(w.processes.halt('kehikot.a')).toBe('not-ours')
    expect(w.signals).toEqual([])
    expect(w.states.runs.has('kehikot.a')).toBe(false)
  })
})

describe('Processes.leave', () => {
  test('stops what it started except what is kept, says so, and their ends are not news', async () => {
    const stopped: Held[][] = []
    const w = world({ leaving: async (held) => void stopped.push([...held]) })
    w.processes.run('kehikot.a', RUNNABLE)
    w.processes.run('kehikot.kept', { ...RUNNABLE, id: 'kehikot.kept' } as Runnable)
    await w.processes.leave('SIGTERM', (id) => id === 'kehikot.kept')
    expect(stopped[0]!.map((one) => one.child.pid)).toEqual([101])
    expect(w.said).toEqual(['kehikko: SIGTERM — the app is stopping this host; stopping the modules it started: kehikot.a'])
    expect(w.states.runs.has('kehikot.a')).toBe(false)
    expect(w.states.runs.has('kehikot.kept')).toBe(true)
    w.end(0, null)
    expect(w.ended).toEqual([])
  })

  test('with nothing to stop, it says that', async () => {
    const w = world({ leaving: async () => {} })
    await w.processes.leave('SIGHUP', () => false)
    expect(w.said).toEqual(['kehikko: SIGHUP — the app is stopping this host; it holds no modules to stop'])
  })
})
