import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import {
  CALL_NOT_MADE,
  isNotAnswering,
  notAnswering,
  NOT_ANSWERING,
  WHAT_HAPPENS_NEXT,
} from '../src/host/reachable.ts'

/**
 * The host's own server, not answering, said in one place.
 *
 * Four files used to write their own wording of this: the sweep in `App.tsx`,
 * `Tools.tsx` twice, and `Start.tsx`. They agreed by coincidence, none of them
 * told a person what to do, and improving one meant finding the other three.
 *
 * Two things are checked here, and only the second is about strings. The first
 * is that the module which WRITES the sentence recognises it when handed back —
 * which is what lets the footer offer a remedy for this fault and for no other
 * without growing an opinion about which faults are which. The second is that
 * the four call sites really did stop writing their own.
 */

describe('the sentence knows itself', () => {
  test('what it writes, it recognises', () => {
    expect(isNotAnswering(notAnswering(new Error('Failed to fetch')))).toBe(true)
  })

  /*
   * The point of the pair. Every other kind of trouble reaches the same footer
   * — a canvas that could not be saved, a `.gitignore` that was not changed —
   * and re-sweeping the registry would do precisely nothing about either, so
   * the offer must not appear beside them.
   */
  test('and it recognises nothing else', () => {
    expect(isNotAnswering('This canvas could not be saved: 500.')).toBe(false)
    expect(isNotAnswering('That folder was not added: it is a file.')).toBe(false)
    expect(isNotAnswering(null)).toBe(false)
    expect(isNotAnswering(undefined)).toBe(false)
  })

  test('every one of them ends with what happens next', () => {
    expect(notAnswering(new Error('boom'))).toEndWith(WHAT_HAPPENS_NEXT)
    expect(notAnswering(new Error('boom'), 'And something else is true.')).toEndWith(
      WHAT_HAPPENS_NEXT,
    )
  })

  test('and the caller’s own clause sits between the reason and the remedy', () => {
    const said = notAnswering(new Error('Failed to fetch'), 'Nothing is known about what is registered until it does.')
    expect(said.indexOf('Failed to fetch')).toBeLessThan(said.indexOf('Nothing is known'))
    expect(said.indexOf('Nothing is known')).toBeLessThan(said.indexOf(WHAT_HAPPENS_NEXT))
  })
})

/**
 * What is thrown at a page is not always an `Error`.
 *
 * `fetch` rejects with a `TypeError`, but there is a proxy in the middle of
 * every one of these calls — Vite's, sending `/host` to the API — and a body
 * that is not JSON, a reset socket or a rejected non-error all arrive here.
 * `String(undefined)` in the middle of a sentence is how a fault message
 * becomes "This host's own server is not answering: undefined."
 */
describe('whatever was thrown', () => {
  test('a bare string is used as the reason', () => {
    expect(notAnswering('the socket closed')).toContain('the socket closed')
  })

  test('nothing at all still reads as a sentence', () => {
    expect(notAnswering(new Error(''))).toContain('the request did not complete')
    expect(notAnswering(undefined)).toContain('the request did not complete')
    expect(notAnswering(null)).toContain('the request did not complete')
  })

  /*
   * Browsers disagree about whether their network errors end in a full stop.
   * The caller supplies one, so the two spellings of one failure must not read
   * as two failures — or as one with two stops.
   */
  test('and a reason that ends in a stop does not get a second one', () => {
    expect(notAnswering(new Error('Load failed.'))).toContain('Load failed. ')
    expect(notAnswering(new Error('Load failed.'))).not.toContain('..')
  })
})

/**
 * The copies are gone, and stay gone.
 *
 * Source checks, which are a weak kind of check and the only one available:
 * what is being asserted is that nobody wrote the sentence by hand again, and
 * a hand-written sentence passes every behavioural test there is.
 */
describe('nobody writes it by hand any more', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  const callers = [
    '../src/App.tsx',
    '../src/canvas/Tools.tsx',
    '../src/canvas/Start.tsx',
  ]

  test('no call site spells the fault out for itself', () => {
    for (const path of callers) {
      expect(code(source(path))).not.toContain("host's own server did not answer")
      expect(code(source(path))).not.toContain(NOT_ANSWERING)
    }
  })

  test('and every one of them asks this module instead', () => {
    for (const path of callers) {
      expect(code(source(path))).toContain('notAnswering(')
    }
  })

  /*
   * The module-facing one is separate on purpose and must stay so. It carries
   * the fact the human sentences do not — that the call was NOT MADE, so a
   * retry is safe — and it is shown inside somebody else's container, where
   * this host's paragraph about `run.sh` would be an intrusion.
   */
  test('the sentence a module is told is the short one, and it says the call was not made', () => {
    expect(CALL_NOT_MADE).toContain('the call was not made')
    expect(CALL_NOT_MADE).not.toContain('run.sh')
    expect(code(source('../src/host/ask.ts'))).toContain('CALL_NOT_MADE')
  })
})

/**
 * The remedy the sentence promises is one the script actually performs.
 *
 * This is the check that would have caught the original bug, and it is worth
 * being blunt about what it is: `run.sh` used to start the API in the
 * background and then block on Vite, so an API that died was never noticed by
 * anything. The page kept serving, every `/host/*` call was refused, and the
 * only cure was restarting the whole host by hand — which destroys every
 * module's document to replace a process that takes a second to start.
 *
 * The sentence above now tells people the server comes back by itself. If the
 * supervision is ever removed, that sentence becomes a lie, and a lie in a
 * fault message is worse than the fault. So it is asserted here, beside the
 * words that depend on it.
 */
describe('and the script keeps the promise the sentence makes', () => {
  const run = readFileSync(new URL('../run.sh', import.meta.url), 'utf8')

  test('the sentence promises run.sh starts it again', () => {
    expect(WHAT_HAPPENS_NEXT).toContain('run.sh starts the server again by itself')
  })

  test('and run.sh has something that does', () => {
    /* Started from one place, so the restart and the first start cannot drift. */
    expect(run).toContain('start_api()')
    /* And more than once, which is the whole of the fix. */
    expect(run.match(/^\s*start_api$/gm)?.length ?? 0).toBeGreaterThan(1)
  })

  test('and it backs off rather than spinning on a build that cannot load', () => {
    expect(run).toContain('API_BACKOFF_MAX')
    expect(run).toContain('API_HEALTHY_FOR')
  })

  /*
   * The page is NOT restarted the same way, and that asymmetry is deliberate:
   * a restarted Vite is a browser that must reload, and a reload loses every
   * module's document — the loss `Frames.tsx` exists to prevent. The page
   * ending still ends the host.
   */
  test('and the page ending still ends the host', () => {
    expect(run).toContain('kill -0 "$PAGE_PID"')
    expect(run).toContain('exit $PAGE_STATUS')
  })
})
