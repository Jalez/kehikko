import { describe, expect, test } from 'bun:test'

import { behindCheckout, Staleness, type CheckoutReader } from '../server/stale.ts'

/**
 * Whether a module's server is behind its checkout: from the build identity it
 * states, and from the host's own record only when it states none.
 */

const HEAD = 'def5678def5678def5678def5678def5678def567'
const build = (commit: string | null) => ({ version: '1.0.0', commit, started: '2026-10-09T10:00:00.000Z', protocol: '0.36.0' })

function reader(over: Partial<CheckoutReader> & { files?: string[] | null } = {}): CheckoutReader {
  return {
    head: async () => HEAD,
    changed: async () => (over.files === undefined ? ['vite.config.ts'] : over.files),
    graph: () => new Set(['vite.config.ts', 'src/doors.ts']),
    ...over,
  }
}

describe('a server compared with its checkout', () => {
  test('started on the commit the checkout is at: not stale', async () => {
    expect(await behindCheckout('Notes', build(HEAD), '/m', reader())).toBeNull()
    /* A build may state a short commit. */
    expect(await behindCheckout('Notes', build('def5678'), '/m', reader())).toBeNull()
  })

  test('the checkout moved, and what changed is loaded by the server: stale, with both commits', async () => {
    const why = await behindCheckout('Notes', build('abc1234abc1234'), '/m', reader({ files: ['src/doors.ts', 'README.md'] }))
    expect(why).toBe(
      'Notes is running older code than its checkout: its server started on abc1234, and the checkout is now at def5678, '
        + 'with changes its server loads (src/doors.ts). Restart it to run them.',
    )
  })

  test('the checkout moved, but only its page did: not stale — Vite serves the page as it is on disk', async () => {
    expect(await behindCheckout('Notes', build('abc1234'), '/m', reader({ files: ['src/App.tsx', 'docs/x.md'] }))).toBeNull()
  })

  test('nothing to compare is unknown, never stale', async () => {
    /* A module from before build identities. */
    expect(await behindCheckout('Notes', null, '/m', reader())).toBeUndefined()
    expect(await behindCheckout('Notes', undefined, '/m', reader())).toBeUndefined()
    /* Not a git checkout when it started. */
    expect(await behindCheckout('Notes', build(null), '/m', reader())).toBeUndefined()
    /* No registered directory. */
    expect(await behindCheckout('Notes', build('abc1234'), undefined, reader())).toBeUndefined()
    /* A checkout that cannot be read, and a commit it does not have. */
    expect(await behindCheckout('Notes', build('abc1234'), '/m', reader({ head: async () => null }))).toBeUndefined()
    expect(await behindCheckout('Notes', build('abc1234'), '/m', reader({ files: null }))).toBeUndefined()
  })
})

describe('what the host says is stale', () => {
  test('a module that states no build is judged by the host’s own record', () => {
    const staleness = new Staleness()
    expect(staleness.staleness('a')).toBeNull()
    staleness.leftBehind('a', 'its registration says to keep it.')
    expect(staleness.staleness('a')).toBe('its registration says to keep it.')
    expect(staleness.all()).toEqual({ a: 'its registration says to keep it.' })
    expect(staleness.older()).toEqual({})
  })

  test('a build that says it runs its checkout overrules the record: no false stale', () => {
    const staleness = new Staleness()
    staleness.leftBehind('a', 'kept')
    staleness.judged('a', null)
    expect(staleness.staleness('a')).toBeNull()
    expect(staleness.all()).toEqual({})
    expect(staleness.older()).toEqual({})
  })

  test('a build that says it is behind is the sentence, apart from the record', () => {
    const staleness = new Staleness()
    staleness.judged('a', 'Notes is running older code than its checkout.')
    expect(staleness.staleness('a')).toBe('Notes is running older code than its checkout.')
    expect(staleness.older()).toEqual({ a: 'Notes is running older code than its checkout.' })
    expect(staleness.all()).toEqual({})
  })

  test('a build that stops saying leaves the record standing, and a start clears both', () => {
    const staleness = new Staleness()
    staleness.leftBehind('a', 'kept')
    staleness.judged('a', null)
    staleness.judged('a', undefined)
    expect(staleness.staleness('a')).toBe('kept')
    staleness.judged('a', 'older')
    staleness.fresh('a')
    expect(staleness.staleness('a')).toBeNull()
    expect(staleness.older()).toEqual({})
  })

  test('a module that is no longer registered is forgotten', () => {
    const staleness = new Staleness()
    staleness.leftBehind('a', 'x')
    staleness.judged('b', 'y')
    staleness.forgetAllBut(['c'])
    expect(staleness.all()).toEqual({})
    expect(staleness.older()).toEqual({})
  })
})
