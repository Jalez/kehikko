import { describe, expect, test } from 'bun:test'

import { claimPair, PREFERRED_API, type Occupant } from '../server/ports.ts'

/**
 * The host had none of the port arbitration its own modules got, which is how
 * an agent's stray kill left a machine with no host and a replacement the
 * desktop app could neither see nor own.
 */

/** A machine, described as what is on each port. Anything unnamed is free. */
function machine(on: Record<number, Occupant>) {
  const asked: number[] = []
  const ask = async (port: number): Promise<Occupant> => {
    asked.push(port)
    return on[port] ?? { kind: 'free' }
  }
  return { ask, asked }
}

const host: Occupant = { kind: 'host', version: '0.1.0' }
const stranger: Occupant = { kind: 'stranger' }

describe('claiming a pair', () => {
  test('an empty machine gets the preferred pair', async () => {
    const { ask } = machine({})
    const got = await claimPair(ask)
    expect(got).toMatchObject({ kind: 'take', api: PREFERRED_API, page: PREFERRED_API + 1, moved: false })
  })

  /* Not an error. Somebody asked for a host and there is one; the useful answer
     is its address, and a second host would be a second program writing the
     same canvases. */
  test('a host already there is reported, not competed with', async () => {
    /* Both halves up, which is what "already running" now requires — see the
       half-a-host tests below. */
    const { ask } = machine({ [PREFERRED_API]: host, [PREFERRED_API + 1]: stranger })
    const got = await claimPair(ask)
    expect(got.kind).toBe('already')
    expect(got.why).toContain(`http://127.0.0.1:${PREFERRED_API + 1}`)
  })

  /*
   * The one that cost somebody a white screen.
   *
   * This host is two processes: `run.sh` starts the API in the background and
   * `exec`s the page, so the page dying leaves the API alive and answering.
   * Asking only the API called that "already running" and exited 0 — so the one
   * command a person reaches for to fix a blank window was the one command
   * guaranteed not to. The more broken the host, the more confidently it
   * refused to start.
   */
  test('an api answering with no page is half a host, not a running one', async () => {
    const { ask } = machine({ [PREFERRED_API]: host })
    const got = await claimPair(ask)
    expect(got.kind).toBe('half')
    expect(got.why).toContain(String(PREFERRED_API))
  })

  test('and it is only "already running" when the page is up too', async () => {
    const { ask } = machine({ [PREFERRED_API]: host, [PREFERRED_API + 1]: stranger })
    const got = await claimPair(ask)
    expect(got.kind).toBe('already')
  })

  /* Half a host is a fault to act on, so it must not be confused with the
     benign case: a person is told what to stop, not that all is well. */
  test('the half answer says what holds the port', async () => {
    const { ask } = machine({ [PREFERRED_API]: host })
    const got = await claimPair(ask)
    expect(got.why).toContain('lsof')
  })

  test('a stranger on the api port moves the pair', async () => {
    const { ask } = machine({ [PREFERRED_API]: stranger })
    const got = await claimPair(ask)
    expect(got).toMatchObject({ kind: 'take', api: PREFERRED_API + 2, moved: true })
    expect(got.why).toContain('PORTS MOVED')
  })

  /*
   * The half that would otherwise be missed. A free API port with a taken PAGE
   * port used to give a host whose page could not start -- an API nobody can
   * look at -- because the two were claimed independently and only one was
   * checked.
   */
  test('a free api port with a taken page port is not a pair', async () => {
    const { ask } = machine({ [PREFERRED_API + 1]: stranger })
    const got = await claimPair(ask)
    expect(got).toMatchObject({ kind: 'take', api: PREFERRED_API + 2, moved: true })
  })

  /* Pairs step by two. Stepping by one would put the second host's API on the
     first host's page port, which is the confusion being prevented. */
  test('pairs never overlap', async () => {
    const { ask } = machine({ [PREFERRED_API]: stranger, [PREFERRED_API + 2]: stranger })
    const got = await claimPair(ask)
    expect(got).toMatchObject({ kind: 'take', api: PREFERRED_API + 4 })
  })

  /* A host somewhere further out is somebody else's deliberate second host, not
     an answer to this request. Keep looking rather than reporting theirs. */
  test('a host on another pair does not answer for this one', async () => {
    const { ask } = machine({ [PREFERRED_API]: stranger, [PREFERRED_API + 2]: host })
    const got = await claimPair(ask)
    expect(got).toMatchObject({ kind: 'take', api: PREFERRED_API + 4 })
  })

  test('a machine with nowhere free says so rather than guessing', async () => {
    const full: Record<number, Occupant> = {}
    for (let p = PREFERRED_API; p < PREFERRED_API + 40; p += 1) full[p] = stranger
    const { ask } = machine(full)
    const got = await claimPair(ask)
    expect(got.kind).toBe('nowhere')
  })

  /* The page port is only asked about once the API port is known free — a probe
     per port per step would double the startup cost for nothing. */
  test('a taken api port is not followed by a pointless page probe', async () => {
    const { ask, asked } = machine({ [PREFERRED_API]: stranger })
    await claimPair(ask)
    expect(asked).not.toContain(PREFERRED_API + 1)
  })

  test('a different preference is honoured', async () => {
    const { ask } = machine({})
    const got = await claimPair(ask, 5000)
    expect(got).toMatchObject({ kind: 'take', api: 5000, page: 5001 })
  })
})
