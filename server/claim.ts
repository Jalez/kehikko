#!/usr/bin/env bun
/**
 * Decide where this host goes, before anything binds anything.
 *
 * Run by `run.sh` as its first act. Prints the pair it claimed on stdout as
 * `<api> <page>`, so the shell can read two numbers and export them; everything
 * a person should read goes to stderr, which is why the two are separated at
 * all.
 *
 * The policy is in `ports.ts` and is a pure function of a probe; this file is
 * the probe and the exit codes. That split is the same one `lifecycle.ts` and
 * `discover.ts` keep, and for the same reason: the interesting part is the
 * decision, and a decision that can only be exercised by starting servers is a
 * decision nobody tests.
 *
 * Exit codes, which `run.sh` reads:
 *
 *   0  the pair is on stdout; go and start
 *   3  a host is already running; its address has been printed, stop here
 *   4  nowhere to go
 *
 * `3` rather than `1` because this is not a failure. Somebody asked for a host
 * and there is one — the request has been satisfied by something that happened
 * earlier, and a shell that treated that as an error would print a stack trace
 * at a person who did nothing wrong.
 */
import { claimPair, PREFERRED_API, type Occupant } from './ports.ts'

/** How long to wait for an answer before deciding nothing is there. */
const ASK_MS = 700

/**
 * What is on a port.
 *
 * A connection that is refused means free. Anything that answers is occupied,
 * and the only thing that makes it US is `/host/hello` saying so — a program
 * that merely answers 404 on that path is a stranger, which is exactly what a
 * misconfigured proxy or somebody else's dev server would be.
 */
async function ask(port: number): Promise<Occupant> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/host/hello`, {
      signal: AbortSignal.timeout(ASK_MS),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return { kind: 'stranger' }
    const said = (await response.json()) as { kehikko?: unknown; version?: unknown }
    if (said?.kehikko !== true) return { kind: 'stranger' }
    return { kind: 'host', version: typeof said.version === 'string' ? said.version : null }
  } catch (error) {
    /* Refused is free. A timeout is NOT: something took the socket and did not
       answer, and starting on top of that would be the collision this exists to
       avoid. The distinction is the same one `discover.ts` draws with
       `reached`. */
    const name = (error as Error)?.name
    if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'stranger' }
    return { kind: 'free' }
  }
}

const prefer = Number(process.env.PORT ?? PREFERRED_API)
const claimed = await claimPair(ask, Number.isInteger(prefer) && prefer > 0 ? prefer : PREFERRED_API)

if (claimed.kind === 'already') {
  console.error(`kehikko: ${claimed.why}`)
  process.exit(3)
}

if (claimed.kind === 'nowhere') {
  console.error(`kehikko: ${claimed.why}`)
  process.exit(4)
}

if (claimed.moved) console.error(`kehikko: ${claimed.why}`)
console.log(`${claimed.api} ${claimed.page}`)
