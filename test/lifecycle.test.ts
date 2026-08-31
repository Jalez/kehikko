import { describe, expect, test } from 'bun:test'

import { Nursery, TERM_GRACE_MS } from '../server/launch.ts'
import {
  asleepLine,
  GRACE_MS,
  Idleness,
  startingLine,
  toStart,
  toStop,
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
  id: 'roadmap.thing',
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
    expect(toStart([standing({ needed: true, answering: false })])).toEqual(['roadmap.thing'])
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
    expect(toStop([idle()], NOW)).toEqual(['roadmap.thing'])
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
    idleness.noted(['roadmap.thing'], NOW)
    expect(idleness.since('roadmap.thing', null)).toBe(NOW)
  })

  test('one that has never been needed is measured from when the host started it', () => {
    /* Otherwise a module started for a kehikko that was closed a second later
       has no "last needed" at all, and measuring from zero would stop it on the
       very next tick. */
    const idleness = new Idleness()
    expect(idleness.since('roadmap.thing', NOW)).toBe(NOW)
  })

  test('the later of the two, never the earlier', () => {
    const idleness = new Idleness()
    idleness.noted(['roadmap.thing'], NOW - 1000)
    expect(idleness.since('roadmap.thing', NOW)).toBe(NOW)
  })

  test('a module that is no longer registered is forgotten', () => {
    const idleness = new Idleness()
    idleness.noted(['roadmap.gone'], NOW)
    idleness.forgetAllBut(['roadmap.thing'])
    expect(idleness.since('roadmap.gone', null)).toBe(null)
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
    expect(nursery.stop('roadmap.terminal')).toBe('not-ours')
    expect(sent).toEqual([])
  })

  test('one it started is signalled, as a group, gently first', () => {
    const { nursery, sent } = watched()
    nursery.keep('roadmap.thing', held(4242))
    expect(nursery.stop('roadmap.thing')).toBe('stopped')
    /* The negative pid is the process group. A run.sh is a shell that runs a
       dev server that spawns workers, and signalling the shell alone leaves the
       server up and the port held — which is the memory this whole thing is
       about, not coming back. */
    expect(sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }])
  })

  test('and killed outright if it ignores the first signal', () => {
    const { nursery, sent, timers } = watched()
    nursery.keep('roadmap.thing', held(4242))
    nursery.stop('roadmap.thing')
    timers.forEach((run) => run())
    expect(sent.map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(TERM_GRACE_MS).toBeGreaterThan(0)
  })

  test('a module that exits on the first signal is not killed', () => {
    const { nursery, sent, timers } = watched()
    const it = held(4242)
    nursery.keep('roadmap.thing', it)
    nursery.stop('roadmap.thing')
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
    nursery.keep('roadmap.thing', it)
    nursery.stop('roadmap.thing')
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
    nursery.keep('roadmap.thing', it)
    it.child.living = false
    expect(nursery.holds('roadmap.thing')).toBe(false)
    expect(nursery.stop('roadmap.thing')).toBe('not-ours')
    expect(sent).toEqual([])
  })

  test('a child that has exited is forgotten rather than signalled', () => {
    const { nursery, sent } = watched()
    const it = held(4242)
    nursery.keep('roadmap.thing', it)
    it.child.living = false
    expect(nursery.startedAt('roadmap.thing')).toBe(null)
    expect(nursery.holds('roadmap.thing')).toBe(false)
    expect(nursery.stop('roadmap.thing')).toBe('not-ours')
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

describe('an owner saying keep', () => {
  const read = (body: string) => {
    const got = readRegistration('roadmap.terminal.json', body)
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
    const said = asleepLine('roadmap.notes', 'http://127.0.0.1:7860')
    expect(said).toContain('asleep')
    expect(said).toContain('Nothing is wrong with it')
    expect(said).toContain('http://127.0.0.1:7860')
    /* `discover.ts` writes "It is not running" for a program nobody stopped.
       The two sentences must not be the same sentence, because the actions they
       lead to are not the same action. */
    expect(said).not.toContain('It is not running')
  })

  test('and a start in flight says so, and says it will resolve', () => {
    const said = startingLine('roadmap.notes', 'http://127.0.0.1:7860')
    expect(said).toContain('starting')
    expect(said).toContain('resolves on its own')
  })
})
