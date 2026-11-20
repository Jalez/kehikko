import { describe, expect, test } from 'bun:test'

import type { Presence } from '../server/discover.ts'
import { Nursery, type Runnable, type Started } from '../server/launch.ts'
import {
  EXIT_BACKOFF_MS,
  EXIT_RESTARTS_MAX,
  ExitRestarts,
  GRACE_MS,
  Idleness,
  STARTING_FOR_MS,
  THEIRS_TO_RESTART_MS,
} from '../server/lifecycle.ts'
import type { Waited } from '../server/manifests.ts'
import type { Registration } from '../server/registrations.ts'
import { Processes } from '../server/supervisor/processes.ts'
import { ModuleStates } from '../server/supervisor/state.ts'
import { Supervisor, type Seen, type SupervisorDeps } from '../server/supervisor/supervisor.ts'

/*
 * The module supervisor (`server/supervisor/supervisor.ts`) on an injected clock and timers: the
 * reaper, the starting window, the wait after an end and the window somebody else's module has to
 * come back. Nothing here creates a process, opens a connection or waits for real time; what the
 * whole host does with real modules is pinned from outside in `supervisor.test.ts`.
 */

const ID = 'kehikot.a'
const URL_A = 'http://127.0.0.1:7001'
const RUNNABLE = { id: ID, dir: '/m/a', script: '/m/a/run.sh', command: '/m/a/run.sh', url: URL_A, port: 7001 } as Runnable

function world(options: { keep?: boolean; overrides?: Partial<SupervisorDeps> } = {}) {
  let now = 1_000_000
  const timers: { at: number; fn: () => void }[] = []
  const said: string[] = []
  const wakes: unknown[] = []
  const waits: { within: number }[] = []
  const spawned: { exited: (code: number | null) => void; alive: boolean }[] = []
  /* What a sweep finds: the module answering or not. */
  let reached = false
  /* What the open pages want. */
  let needed = new Set<string>([ID])
  let back = false
  let seen: Promise<Seen> | null = null

  const presence = (): Presence => ({ id: ID, name: 'A', at: URL_A, reached, condition: reached ? 'ready' : 'silent' }) as Presence
  const registration = { id: ID, url: URL_A, dir: '/m/a', ...(options.keep ? { keep: true } : {}) } as Registration
  const registered = new Map([[ID, registration]])
  const states = new ModuleStates(new ExitRestarts(() => now))
  const nursery = new Nursery(() => {}, () => {})
  const after = (ms: number, fn: () => void) => void timers.push({ at: now + ms, fn })

  let supervisor: Supervisor
  const processes = new Processes({
    states,
    nursery,
    addresses: () => false,
    namedPorts: () => new Set(),
    startup: { mark: () => {} },
    manifests: { forget: () => {} },
    staleness: { fresh: () => {} },
    onEnded: (id, at, code) => void supervisor.ended(id, at, code),
    log: () => {},
    now: () => now,
    logFile: (id) => `/logs/${id}.log`,
    openRun: () => {},
    takesAnyPort: () => false,
    start: (run, exited) => {
      const one = { exited: exited!, alive: true }
      spawned.push(one)
      return { ok: true, command: run.command, child: { pid: 100 + spawned.length, alive: () => one.alive } } as Started
    },
  })
  const sweep = () => {
    seen = Promise.resolve({ presences: [presence()] })
    return seen
  }
  supervisor = new Supervisor({
    states,
    processes,
    nursery,
    registered,
    lastPresences: new Map(),
    manifests: {
      wait: (_registration: Registration, within: number) => {
        waits.push({ within })
        /* Gives up at `within`, as the real one does when nothing answers. */
        return new Promise<Waited>((resolve) => after(within, () => resolve({ up: false, presence: null, cancelled: false })))
      },
      forget: () => {},
      read: () => Promise.resolve(presence()),
      readAt: () => null,
      stampOf: () => null,
    } as unknown as SupervisorDeps['manifests'],
    idleness: new Idleness(),
    staleness: { forgetAllBut: () => {} },
    releases: { applying: () => false, forgetAllBut: () => {} },
    builds: { busy: () => false, forgetAllBut: () => {} },
    auto: { pending: () => false, moved: () => Promise.resolve(), forgetAllBut: () => {} },
    development: { owes: () => false },
    pressedStarts: { has: () => false },
    startup: { has: () => true, mark: () => {}, write: () => {} },
    wakes: { registryChanged: (view) => void wakes.push(view ?? null) },
    sweep,
    seen: () => seen,
    sweeping: () => null,
    pageView: () => Promise.resolve('page view'),
    going: () => false,
    wanted: () => ({ needed, warm: new Map() }),
    bootHolds: () => false,
    bootPump: () => {},
    startable: () => ({ ok: true, run: RUNNABLE }),
    startOnce: () => Promise.resolve(null),
    installedPlace: () => null,
    checkWhenUp: () => {},
    backfilled: () => true,
    backfill: () => {},
    runHeldChecks: () => {},
    reconcileVersions: () => {},
    whileStopped: () => Promise.resolve(),
    spokenName: () => 'A',
    now: () => now,
    after,
    every: () => {},
    log: (line) => void said.push(line),
    logs: { file: (id) => `/logs/${id}.log`, tail: () => ['last line'], trim: () => {}, installing: () => false },
    answersAt: () => Promise.resolve(back),
    probe: () => Promise.resolve({ reached, stamp: null }),
    tethers: () => ({ sync: () => {} }),
    ...options.overrides,
  })

  /** Let every promise that can settle, settle. */
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((wake) => setImmediate(wake))
  }
  /** Move the clock on by `ms`, running each timer that falls due, in order, and what it sets off. */
  const advance = async (ms: number) => {
    const until = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > until) break
      timers.shift()
      now = next.at
      next.fn()
      await settle()
    }
    now = until
    await settle()
  }
  /** The page reports what it sees: a sweep, and the decision from it. */
  const look = async () => {
    supervisor.govern((await sweep()).presences)
    await settle()
  }
  /** The process the host ran last ends. */
  const end = async (code: number | null = 0) => {
    const one = spawned.at(-1)!
    one.alive = false
    one.exited(code)
    await settle()
  }
  return {
    supervisor,
    states,
    nursery,
    spawned,
    said,
    wakes,
    waits,
    timers,
    advance,
    look,
    end,
    settle,
    now: () => now,
    setReached: (value: boolean) => void (reached = value),
    setNeeded: (ids: string[]) => void (needed = new Set(ids)),
    setBack: (value: boolean) => void (back = value),
  }
}

const STOPPED = `kehikko: stopped ${ID} — no open kehikko or project has had it for the grace period`

describe('the reaper', () => {
  test('stops a module of ours that nothing has needed for the grace period, and not before', async () => {
    const w = world()
    await w.look()
    expect(w.spawned).toHaveLength(1)
    w.setReached(true)
    await w.look()
    /* The kehikko closes: from now on nothing needs it. */
    w.setNeeded([])
    await w.advance(GRACE_MS - 1_000)
    await w.supervisor.tick()
    expect(w.said).not.toContain(STOPPED)
    expect(w.nursery.holds(ID)).toBe(true)
    await w.advance(1_000)
    await w.supervisor.tick()
    expect(w.said).toContain(STOPPED)
    expect(w.nursery.holds(ID)).toBe(false)
    expect(w.states.sleeping.get(ID)).toBe(w.now())
  })

  test('the grace period counts from when it was last needed, not from when it started', async () => {
    const w = world()
    await w.look()
    w.setReached(true)
    await w.look()
    /* Still on screen for a while after it started. */
    await w.advance(GRACE_MS)
    await w.supervisor.tick()
    w.setNeeded([])
    await w.advance(GRACE_MS / 2)
    await w.supervisor.tick()
    expect(w.said).not.toContain(STOPPED)
    await w.advance(GRACE_MS / 2)
    await w.supervisor.tick()
    expect(w.said).toContain(STOPPED)
  })

  test('never stops a module its registration keeps', async () => {
    const w = world({ keep: true })
    await w.look()
    w.setReached(true)
    await w.look()
    w.setNeeded([])
    await w.advance(GRACE_MS * 3)
    await w.supervisor.tick()
    expect(w.said).not.toContain(STOPPED)
    expect(w.nursery.holds(ID)).toBe(true)
  })

  test('decides nothing before the first sweep', async () => {
    const w = world()
    await w.supervisor.tick()
    expect(w.spawned).toHaveLength(0)
    expect(w.said).toEqual([])
  })
})

describe('the starting window', () => {
  test('a module the host started is starting until STARTING_FOR_MS, and the wait for it gives up then', async () => {
    const w = world()
    await w.look()
    expect(w.spawned).toHaveLength(1)
    expect(w.said[0]).toBe(`kehikko: started ${ID} at ${URL_A} — an open kehikko or project has it (pid 101)`)
    const starting = () => w.supervisor.standings([{ id: ID, reached: false, condition: 'silent' } as Presence], w.now())[0]!.starting
    expect(starting()).toBe(true)
    expect(w.waits).toEqual([{ within: STARTING_FOR_MS }])
    await w.advance(STARTING_FOR_MS - 1)
    expect(starting()).toBe(true)
    expect(w.wakes).toEqual([])
    await w.advance(1)
    expect(starting()).toBe(false)
    /* Given up on: decided again, and the pages told with the reading. */
    expect(w.wakes).toEqual(['page view'])
  })

  test('the wait says nothing for a run that was replaced meanwhile', async () => {
    const w = world()
    await w.look()
    w.states.runs.set(ID, -1)
    await w.advance(STARTING_FOR_MS)
    expect(w.wakes).toEqual([])
  })
})

describe('the wait after an end', () => {
  /** Started, answering, and running past `MIN_RUN_MS`. */
  async function running(w: ReturnType<typeof world>) {
    w.setReached(true)
    await w.look()
    await w.advance(60_000)
    w.setReached(false)
  }

  test('started again at once, then after the backoff, then not again on its own', async () => {
    const w = world()
    await w.look()
    await running(w)

    /* First end: started again at once. */
    await w.end()
    expect(w.said).toContain(`kehikko: ${ID} is no longer running — the process the host started ended`)
    expect(w.spawned).toHaveLength(2)

    /* Second end inside the window: held for the second wait. */
    await running(w)
    await w.end()
    expect(w.said).toContain(`kehikko: ${ID} is no longer running — started again in ${EXIT_BACKOFF_MS[1]! / 1000} s`)
    expect(w.spawned).toHaveLength(2)
    expect(w.states.heldAfterEnd(ID, w.now())).toBe(true)
    /* A look meanwhile does not start it either. */
    await w.look()
    expect(w.spawned).toHaveLength(2)
    await w.advance(EXIT_BACKOFF_MS[1]! - 1)
    expect(w.spawned).toHaveLength(2)
    const told = w.wakes.length
    await w.advance(1)
    /* The timer swept, decided and told the pages. */
    expect(w.spawned).toHaveLength(3)
    expect(w.wakes.length).toBeGreaterThan(told)

    /* Third end: the longest wait. */
    await running(w)
    await w.end()
    expect(w.spawned).toHaveLength(3)
    await w.advance(EXIT_BACKOFF_MS[2]!)
    expect(w.spawned).toHaveLength(4)

    /* One more than EXIT_RESTARTS_MAX: the container says so, and nothing starts it. */
    await running(w)
    await w.end()
    expect(w.said).toContain(`kehikko: ${ID} ended ${EXIT_RESTARTS_MAX + 1} times within 10 minutes — not started again until a press`)
    expect(w.states.failures.get(ID)?.detail).toEqual(['last line'])
    await w.advance(10 * 60_000)
    await w.look()
    expect(w.spawned).toHaveLength(4)
  })

  test('an end before it ever answered is a failed start, not started again', async () => {
    const w = world()
    await w.look()
    await w.end(1)
    expect(w.said).toContain(`kehikko: ${ID} stopped again (exit code 1) without answering — see /logs/${ID}.log`)
    expect(w.states.failures.has(ID)).toBe(true)
    expect(w.states.starting.has(ID)).toBe(false)
    await w.look()
    expect(w.spawned).toHaveLength(1)
  })
})

describe("somebody else's module", () => {
  /** Answering, from a process this host did not start; then gone. */
  async function theirsWent(w: ReturnType<typeof world>) {
    w.setReached(true)
    await w.look()
    expect(w.states.answeredBy.get(ID)).toBe('theirs')
    w.setReached(false)
    await w.look()
  }

  test('is not started until THEIRS_TO_RESTART_MS has passed, then swept and started', async () => {
    const w = world()
    await theirsWent(w)
    expect(w.states.theirs.get(ID)).toBe(w.now())
    expect(w.spawned).toHaveLength(0)
    await w.advance(THEIRS_TO_RESTART_MS - 1_000)
    expect(w.states.theirs.has(ID)).toBe(true)
    expect(w.spawned).toHaveLength(0)
    await w.advance(1_000)
    expect(w.states.theirs.has(ID)).toBe(false)
    expect(w.spawned).toHaveLength(1)
    expect(w.wakes.length).toBeGreaterThan(0)
  })

  test('back inside the window: let go, and not started', async () => {
    const w = world()
    await theirsWent(w)
    w.setBack(true)
    w.setReached(true)
    await w.advance(1_000)
    expect(w.states.theirs.has(ID)).toBe(false)
    expect(w.wakes).toEqual([null])
    await w.advance(THEIRS_TO_RESTART_MS)
    expect(w.spawned).toHaveLength(0)
  })
})
