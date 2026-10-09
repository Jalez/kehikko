import { describe, expect, test } from 'bun:test'

import { leaving, Nursery, TERM_GRACE_MS } from '../server/launch.ts'
import {
  asleepLine,
  GRACE_MS,
  Idleness,
  startingLine,
  exitedLine,
  inFlight,
  INSTALLING_FOR_MS,
  lifecycleLine,
  lifecycleOf,
  STARTING_FOR_MS,
  toStart,
  type Doing,
  toStop,
  toWatch,
  theirsLine,
  THEIRS_TO_RESTART_MS,
  WATCH_EVERY_MS,
  type Standing,
} from '../server/lifecycle.ts'
import { readRegistration } from '../server/registrations.ts'

/**
 * When a module runs and when it does not.
 *
 * Every one of these is a decision that, got wrong, either wastes a gigabyte or
 * kills somebody's shell mid-command. So the policy is a pure function of flat
 * facts and a clock, and this file exercises it exhaustively without a single
 * process being created — which is the entire reason it was written that way.
 *
 * The one impure thing here is `Nursery`, and its signal and its timer are
 * injected, so even "the host refuses to stop what it did not start" is tested
 * by watching what it would have signalled rather than by killing something.
 */

const standing = (over: Partial<Standing> = {}): Standing => ({
  id: 'kehikot.thing',
  needed: false,
  answering: true,
  startable: true,
  ours: false,
  keep: false,
  idleSince: null,
  starting: false,
  ...over,
})

const NOW = 1_700_000_000_000

describe('what the host starts', () => {
  test('a module on an open kehikko that nothing is answering for', () => {
    expect(toStart([standing({ needed: true, answering: false })])).toEqual(['kehikot.thing'])
  })

  test('nothing, for a module no open kehikko has', () => {
    /* The whole saving. A module that is registered, startable and down stays
       down until somebody is looking at a canvas with it on. */
    expect(toStart([standing({ needed: false, answering: false })])).toEqual([])
  })

  test('nothing, for a module that is already answering', () => {
    expect(toStart([standing({ needed: true, answering: true })])).toEqual([])
  })

  test('nothing, when something else has taken the port', () => {
    /* `answering` is "anything replied at all", not "a manifest read". Three
       different failures are spelled `silent` and two of them are a process
       holding that port; starting on top of one would spawn a server that
       cannot bind, once per sweep, forever. */
    expect(toStart([standing({ needed: true, answering: true, startable: true })])).toEqual([])
  })

  test('nothing, for a module whose registration says no directory', () => {
    expect(toStart([standing({ needed: true, answering: false, startable: false })])).toEqual([])
  })

  test('nothing, for a module already being started', () => {
    expect(toStart([standing({ needed: true, answering: false, starting: true })])).toEqual([])
  })
})

describe('what the host stops', () => {
  const idle = (over: Partial<Standing> = {}) =>
    standing({ ours: true, needed: false, idleSince: NOW - GRACE_MS, ...over })

  test('a module it started, that nothing has needed for the grace period', () => {
    expect(toStop([idle()], NOW)).toEqual(['kehikot.thing'])
  })

  test('never one it did not start, however idle', () => {
    /* The gate that matters most. Every module on this machine was started by
       hand in somebody's terminal, and their process is a foreground job with a
       log somebody is reading. This is doubled: `Nursery.stop` refuses on the
       same fact, from the map that would have to hold the pid. */
    expect(toStop([idle({ ours: false, idleSince: NOW - GRACE_MS * 100 })], NOW)).toEqual([])
  })

  test('never one whose owner wrote keep', () => {
    expect(toStop([idle({ keep: true, idleSince: NOW - GRACE_MS * 100 })], NOW)).toEqual([])
  })

  test('never one on a kehikko somebody has open', () => {
    expect(toStop([idle({ needed: true })], NOW)).toEqual([])
  })

  test('not before the grace period is up', () => {
    expect(toStop([idle({ idleSince: NOW - GRACE_MS + 1 })], NOW)).toEqual([])
  })

  test('not one that is still coming up', () => {
    expect(toStop([idle({ starting: true })], NOW)).toEqual([])
  })

  test('not one that is already down', () => {
    /* There is nothing there to stop, and the pid held for it is a corpse.
       Dropping the entry is `Nursery`'s job, not the policy's. */
    expect(toStop([idle({ answering: false })], NOW)).toEqual([])
  })

  test('not one with no moment to measure idleness from', () => {
    expect(toStop([idle({ idleSince: null })], NOW)).toEqual([])
  })

  test('switching between two kehikot does not cost a restart', () => {
    /* The failure the grace period exists to prevent, written as the case that
       produces it: a module wanted on canvas A, unwanted for the ten seconds
       somebody spends on canvas B, and wanted again. */
    const seconds = 10_000
    expect(toStop([idle({ idleSince: NOW - seconds })], NOW)).toEqual([])
    expect(GRACE_MS).toBeGreaterThan(seconds * 10)
  })
})

describe('when a module was last needed', () => {
  test('a module on an open kehikko is needed now', () => {
    const idleness = new Idleness()
    idleness.noted(['kehikot.thing'], NOW)
    expect(idleness.since('kehikot.thing', null)).toBe(NOW)
  })

  test('one that has never been needed is measured from when the host started it', () => {
    /* Otherwise a module started for a kehikko that was closed a second later
       has no "last needed" at all, and measuring from zero would stop it on the
       very next tick. */
    const idleness = new Idleness()
    expect(idleness.since('kehikot.thing', NOW)).toBe(NOW)
  })

  test('the later of the two, never the earlier', () => {
    const idleness = new Idleness()
    idleness.noted(['kehikot.thing'], NOW - 1000)
    expect(idleness.since('kehikot.thing', NOW)).toBe(NOW)
  })

  test('a module that is no longer registered is forgotten', () => {
    const idleness = new Idleness()
    idleness.noted(['kehikot.gone'], NOW)
    idleness.forgetAllBut(['kehikot.thing'])
    expect(idleness.since('kehikot.gone', null)).toBe(null)
  })
})

/** A nursery whose signals are recorded rather than sent. */
function watched() {
  const sent: { pid: number; signal: string }[] = []
  const timers: (() => void)[] = []
  const nursery = new Nursery(
    (pid, signal) => sent.push({ pid, signal: String(signal) }),
    (_ms, run) => timers.push(run),
  )
  return { nursery, sent, timers }
}

/**
 * A child this "host" started, with a switch for whether it is still alive.
 *
 * The point of the whole `Child` interface: `alive` is not "a process with this
 * number exists", it is "the process I started has not exited". A fake that
 * answered the first question would test nothing, because the first question is
 * the one the design refuses to ask.
 */
function child(pid: number) {
  const handle = { pid, alive: () => handle.living, living: true }
  return handle
}

const held = (pid: number) => ({ child: child(pid), at: NOW, url: `http://127.0.0.1:${pid}` })

describe('the only processes the host may stop', () => {
  test('a module it never started cannot be stopped at all', () => {
    /* Not "is refused by a check" — there is nowhere for the pid to come from.
       No port, url, registration or request reaches a signal. */
    const { nursery, sent } = watched()
    expect(nursery.stop('kehikot.terminal')).toBe('not-ours')
    expect(sent).toEqual([])
  })

  test('one it started is signalled, as a group, gently first', () => {
    const { nursery, sent } = watched()
    nursery.keep('kehikot.thing', held(4242))
    expect(nursery.stop('kehikot.thing')).toBe('stopped')
    /* The negative pid is the process group. A run.sh is a shell that runs a
       dev server that spawns workers, and signalling the shell alone leaves the
       server up and the port held — which is the memory this whole thing is
       about, not coming back. */
    expect(sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }])
  })

  test('and killed outright if it ignores the first signal', () => {
    const { nursery, sent, timers } = watched()
    nursery.keep('kehikot.thing', held(4242))
    nursery.stop('kehikot.thing')
    timers.forEach((run) => run())
    expect(sent.map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(TERM_GRACE_MS).toBeGreaterThan(0)
  })

  test('a module that exits on the first signal is not killed', () => {
    const { nursery, sent, timers } = watched()
    const it = held(4242)
    nursery.keep('kehikot.thing', it)
    nursery.stop('kehikot.thing')
    it.child.living = false
    timers.forEach((run) => run())
    expect(sent.map((s) => s.signal)).toEqual(['SIGTERM'])
  })

  test('the second signal does not follow a number the child no longer wears', () => {
    /* The worst failure this feature can have, and it is not hypothetical:
       while this was written, eleven of the thirteen modules on this machine
       were restarted by somebody else. Between SIGTERM and SIGKILL the child can
       exit and its number be handed to a stranger — somebody's build, somebody's
       shell — so the delayed signal asks the HANDLE again and not the number. */
    const { nursery, sent, timers } = watched()
    const it = held(4242)
    nursery.keep('kehikot.thing', it)
    nursery.stop('kehikot.thing')
    it.child.living = false
    timers.forEach((run) => run())
    expect(sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }])
  })

  test('a module restarted by hand stops belonging to the host', () => {
    /* The case that happens constantly while somebody works on their modules:
       the host's child dies, they start it again in a terminal, and the port is
       answering — by a process the host has no claim on. What is asked is
       whether OUR child is alive, not whether that number is in use, so a
       recycled pid answers no. */
    const { nursery, sent } = watched()
    const it = held(4242)
    nursery.keep('kehikot.thing', it)
    it.child.living = false
    expect(nursery.holds('kehikot.thing')).toBe(false)
    expect(nursery.stop('kehikot.thing')).toBe('not-ours')
    expect(sent).toEqual([])
  })

  test('a child that has exited is forgotten rather than signalled', () => {
    const { nursery, sent } = watched()
    const it = held(4242)
    nursery.keep('kehikot.thing', it)
    it.child.living = false
    expect(nursery.startedAt('kehikot.thing')).toBe(null)
    expect(nursery.holds('kehikot.thing')).toBe(false)
    expect(nursery.stop('kehikot.thing')).toBe('not-ours')
    expect(sent).toEqual([])
  })

  test('only what it holds is listed as its own', () => {
    const { nursery } = watched()
    const a = held(1)
    const b = held(2)
    nursery.keep('a.module', a)
    nursery.keep('b.module', b)
    b.child.living = false
    expect(nursery.ids).toEqual(['a.module'])
  })
})

/**
 * Which modules the host asks about after everything has gone quiet.
 *
 * The fault: a terminal module's server was gone, its page said the connection
 * had ended, and its container still showed a green light. `Presence.condition`
 * is what the host found out by ASKING, and after startup the host had stopped
 * asking. These say what it now asks about, and — just as importantly — what it
 * does not, because the whole defence of this check is its scope.
 */
describe('what the host keeps asking about', () => {
  test('a module on a kehikko somebody has open, even a green one', () => {
    /* The bug in one line. `answering: true` is what the host believes, and the
       belief is exactly what has to be re-examined; filtering on it here would
       reproduce the fault this exists to fix. */
    expect(toWatch([standing({ needed: true, answering: true })])).toEqual(['kehikot.thing'])
  })

  test('and a silent one, because a person may have started it by hand', () => {
    expect(toWatch([standing({ needed: true, answering: false })])).toEqual(['kehikot.thing'])
  })

  test('nothing, for a module no open kehikko has', () => {
    /* The scope that makes this a check rather than a heartbeat. A host with no
       page reporting a kehikko asks nobody anything. */
    expect(toWatch([standing({ needed: false, answering: true })])).toEqual([])
    expect(toWatch([standing({ needed: false, answering: false })])).toEqual([])
  })

  test('nothing, for a module already being started', () => {
    /* `App.tsx` has a faster loop for exactly those seconds, and the answer
       during them is "not yet", which the container is already saying. */
    expect(toWatch([standing({ needed: true, answering: false, starting: true })])).toEqual([])
  })

  test('a kept module is asked about like any other', () => {
    /* `keep` says the host may not STOP it. It has never said anything about
       looking at it, and the module this fault was found on is a kept one. */
    expect(toWatch([standing({ needed: true, answering: true, keep: true })])).toEqual([
      'kehikot.thing',
    ])
  })

  test('slowly enough to be a check and not a heartbeat', () => {
    /* Not a magic-number test: the number is argued in `lifecycle.ts` and the
       argument has a floor. Anything under a few seconds would be the
       request-per-tick this host refuses everywhere else, and lowering this
       constant without rewriting that essay should fail here first. */
    expect(WATCH_EVERY_MS).toBeGreaterThanOrEqual(10_000)
  })
})

/**
 * The second half of the same fault, and the reason to check it separately.
 *
 * The terminal was the only module down while five were up, and its
 * registration carries `keep: true`. If `keep` also stopped the host STARTING a
 * dead module, the stale light would have been hiding a module that could never
 * come back on its own — one symptom, two faults. It does not, and these say so
 * in the one place that decides.
 */
describe('keep does not stop a module coming back', () => {
  test('a kept module that has died is started like any other', () => {
    expect(toStart([standing({ needed: true, answering: false, keep: true })])).toEqual([
      'kehikot.thing',
    ])
  })

  test('and is still never stopped', () => {
    expect(
      toStop([standing({ ours: true, keep: true, idleSince: NOW - GRACE_MS * 10 })], NOW),
    ).toEqual([])
  })
})

describe('an owner saying keep', () => {
  const read = (body: string) => {
    const got = readRegistration('kehikot.terminal.json', body)
    if (!got.ok) throw new Error(got.why)
    return got.registration
  }

  test('a JSON boolean', () => {
    expect(read('{"port": 7920, "keep": true}').keep).toBe(true)
  })

  test('the word, in the flat YAML a registration may also be written in', () => {
    expect(read('port: 7920\nkeep: true\n').keep).toBe(true)
    expect(read('port: 7920\nkeep: yes\n').keep).toBe(true)
  })

  test('absent means the host may stop it, which is the default', () => {
    expect(read('port: 7920\n').keep).toBeUndefined()
  })

  test('only the explicit noes are a no', () => {
    expect(read('port: 7920\nkeep: false\n').keep).toBeUndefined()
    expect(read('port: 7920\nkeep: no\n').keep).toBeUndefined()
    expect(read('{"port": 7920, "keep": false}').keep).toBeUndefined()
  })

  test('a typo protects the module rather than exposing it', () => {
    /* Read in one direction on purpose, and the opposite direction to every
       other field here: a `keep` misread as true wastes some memory, and one
       misread as false kills the shell somebody was working in. */
    expect(read('port: 7920\nkeep: ture\n').keep).toBe(true)
  })
})

describe('asleep does not read like broken', () => {
  test('the sentence says the host stopped it and that it comes back', () => {
    const said = asleepLine('kehikot.notes', 'http://127.0.0.1:7860')
    expect(said).toContain('asleep')
    expect(said).toContain('Nothing is wrong with it')
    expect(said).toContain('http://127.0.0.1:7860')
    /* `discover.ts` writes "It is not running" for a program nobody stopped.
       The two sentences must not be the same sentence, because the actions they
       lead to are not the same action. */
    expect(said).not.toContain('It is not running')
  })

  test('and a start in flight says so, and says it will resolve', () => {
    const said = startingLine('kehikot.notes', 'http://127.0.0.1:7860')
    expect(said).toContain('starting')
    expect(said).toContain('resolves on its own')
  })
})

describe('what the host says it is doing', () => {
  const idle: Doing = { work: null, ranAt: null, alive: false, installing: false, asleep: false }

  test('nothing, of a module that answers and that the host is not touching', () => {
    expect(lifecycleOf(false, idle, NOW)).toBeUndefined()
    expect(lifecycleOf(false, { ...idle, ranAt: NOW - 1000, alive: true }, NOW)).toBeUndefined()
  })

  test('an update or a restart in hand is said even while the old process still answers', () => {
    expect(lifecycleOf(false, { ...idle, work: 'updating' }, NOW)).toBe('updating')
    expect(lifecycleOf(true, { ...idle, work: 'restarting' }, NOW)).toBe('restarting')
  })

  test('starting, for as long as that word is true', () => {
    expect(lifecycleOf(true, { ...idle, ranAt: NOW - 1000, alive: true }, NOW)).toBe('starting')
    expect(lifecycleOf(true, { ...idle, ranAt: NOW - STARTING_FOR_MS - 1, alive: true }, NOW)).toBeUndefined()
  })

  test('installing is its own state, and does not lapse to "not running" after thirty seconds', () => {
    const installs: Doing = { ...idle, ranAt: NOW - 1000, alive: true, installing: true }
    expect(lifecycleOf(true, installs, NOW)).toBe('installing')
    expect(lifecycleOf(true, { ...installs, ranAt: NOW - STARTING_FOR_MS * 4 }, NOW)).toBe('installing')
    /* Bounded: ten minutes of silence is not an install any more. */
    expect(lifecycleOf(true, { ...installs, ranAt: NOW - INSTALLING_FOR_MS - 1 }, NOW)).toBeUndefined()
    /* And only of a process that is still there: one that exited mid-install is not installing. */
    expect(lifecycleOf(true, { ...installs, alive: false, ranAt: NOW - STARTING_FOR_MS - 1 }, NOW)).toBeUndefined()
  })

  test('asleep only when nothing is in flight', () => {
    expect(lifecycleOf(true, { ...idle, asleep: true }, NOW)).toBe('asleep')
    expect(lifecycleOf(true, { ...idle, asleep: true, ranAt: NOW - 10 }, NOW)).toBe('starting')
    expect(inFlight('asleep')).toBe(false)
    expect(inFlight(undefined)).toBe(false)
    for (const word of ['starting', 'installing', 'updating', 'restarting'] as const) expect(inFlight(word)).toBe(true)
  })

  test('each word has its own sentence, and a failed start names where the output is', () => {
    const words = ['starting', 'installing', 'updating', 'restarting', 'asleep'] as const
    expect(new Set(words.map((word) => lifecycleLine(word, 'kehikot.thing', 'http://127.0.0.1:7999'))).size).toBe(5)
    expect(exitedLine('kehikot.thing', 'http://127.0.0.1:7999', 1, '/logs/kehikot.thing.log')).toContain('(exit code 1)')
    expect(exitedLine('kehikot.thing', 'http://127.0.0.1:7999', null, '/logs/kehikot.thing.log')).toContain('/logs/kehikot.thing.log')
  })
})

describe('what is not started again on its own', () => {
  test('a module the host ran that stopped without answering: the container says so, with the button', () => {
    expect(toStart([standing({ needed: true, answering: false, failed: true })])).toEqual([])
  })

  test('a module whose process the host started is still running: a second copy would race it for the port', () => {
    expect(toStart([standing({ needed: true, answering: false, ours: true })])).toEqual([])
  })
})

describe('a host the app is stopping takes what it started with it', () => {
  test('only what the nursery holds can be handed over, and it is held no longer', () => {
    const { nursery } = watched()
    /* A module this host did not start: there is nothing to hand over. */
    expect(nursery.release('kehikot.terminal')).toBeNull()
    const it = held(4242)
    nursery.keep('kehikot.thing', it)
    expect(nursery.release('kehikot.thing')).toBe(it)
    expect(nursery.holds('kehikot.thing')).toBe(false)
    expect(nursery.release('kehikot.thing')).toBeNull()
  })

  test('a process that has already ended is not handed over', () => {
    const { nursery } = watched()
    const it = held(4242)
    nursery.keep('kehikot.thing', it)
    it.child.living = false
    expect(nursery.release('kehikot.thing')).toBeNull()
  })

  test('each group is asked to leave, and the wait ends when they have', async () => {
    const sent: { pid: number; signal: string }[] = []
    const a = held(4242)
    const b = held(4343)
    const before = Date.now()
    await leaving([a, b], 2_000, (pid, signal) => {
      sent.push({ pid, signal })
      /* Both leave on the first signal. */
      if (pid === -4242) a.child.living = false
      if (pid === -4343) b.child.living = false
    })
    expect(sent).toEqual([
      { pid: -4242, signal: 'SIGTERM' },
      { pid: -4343, signal: 'SIGTERM' },
    ])
    expect(Date.now() - before).toBeLessThan(1_000)
  })

  test('one that ignores it is killed when the wait is over, and one that left is not signalled again', async () => {
    const sent: { pid: number; signal: string }[] = []
    const stubborn = held(4242)
    const polite = held(4343)
    await leaving([stubborn, polite], 120, (pid, signal) => {
      sent.push({ pid, signal })
      if (pid === -4343) polite.child.living = false
    })
    expect(sent).toEqual([
      { pid: -4242, signal: 'SIGTERM' },
      { pid: -4343, signal: 'SIGTERM' },
      { pid: -4242, signal: 'SIGKILL' },
    ])
  })
})

describe('a module somebody else was running, just gone', () => {
  test('the sentence says who is expected to bring it back, for how long, and that it can be started now', () => {
    expect(theirsLine('kehikot.notes', 'http://127.0.0.1:7920')).toBe(
      'kehikot.notes stopped answering at http://127.0.0.1:7920 a moment ago. This host did not start it, so it is giving whoever did '
        + '8 seconds to bring it back before it starts it itself — or start it now.',
    )
    /* Longer than a dev server takes to come back, far shorter than the watch. */
    expect(THEIRS_TO_RESTART_MS).toBeGreaterThanOrEqual(6_000)
    expect(THEIRS_TO_RESTART_MS).toBeLessThan(WATCH_EVERY_MS)
  })
})
