/**
 * Which ports this host should take, and whether it should start at all.
 *
 * ## Three parties can start this program and nothing arbitrated between them
 *
 * The desktop app spawns a host. A person runs `./run.sh`. An agent doing
 * something else entirely can kill one, and did — a background command was
 * stopped mid-flight and left the machine with no host at all, so the app in
 * front of somebody went dead. Starting a replacement then made it worse: the
 * app can no longer start its own, because the port it wants is held by a
 * process it does not own and cannot see.
 *
 * Modules already have an answer to exactly this. `roadmap-module-protocol/serve`
 * asks who is on a port before taking it, exits cleanly when the answer is "a
 * copy of me", and moves when the answer is "a stranger". The host — the one
 * process everything else depends on — had none of it, which is the joke this
 * file exists to stop telling.
 *
 * ## Why a PAIR and not a port
 *
 * This host is two processes: an API and the page that proxies to it. The page
 * is `api + 1` and Vite is told the API's port so its proxy can find it. They
 * are not independently placeable — a page pointed at somebody else's API is
 * worse than no page, because it looks like it is working. So the unit of
 * claiming is both, together, and a pair is only free when both halves are.
 *
 * ## The three answers, and why "already running" is not an error
 *
 * A person who runs `./run.sh` while their app is up has not made a mistake.
 * They have asked for a host and there is one; the useful response is its
 * address, not a stack trace and not a second host quietly competing for the
 * same database. So that exits successfully and says where to look.
 *
 * A stranger on the port is different: nothing is wrong with the request, only
 * with the address, so the pair moves and says so loudly. Loudly matters — a
 * host that moved silently would leave a person typing 4181 into a browser and
 * finding somebody else's program.
 */

/** Where a host puts itself unless told otherwise. The page is always the next port up. */
export const PREFERRED_API = 4180

/** How many pairs to try before giving up. Far more than anybody has hosts. */
const TRIES = 8

/** What a probe found at an address. */
export type Occupant =
  /** Nothing is listening. */
  | { kind: 'free' }
  /** A Kehikot host, which is to say a copy of this program. */
  | { kind: 'host'; version: string | null }
  /** Something is listening and it is not this. */
  | { kind: 'stranger' }

export type Claim =
  | { kind: 'take'; api: number; page: number; moved: boolean; why: string }
  | { kind: 'already'; api: number; page: number; why: string }
  | { kind: 'nowhere'; why: string }

/**
 * How a pair is asked about. Injected, so the whole policy is testable without
 * binding a socket — the same split `lifecycle.ts` keeps between deciding and
 * doing.
 */
export type Ask = (port: number) => Promise<Occupant>

/**
 * Decide, given a way to ask.
 *
 * The preferred pair is examined first and the answer for it is the only one
 * that can be `already`: a host on some OTHER pair is not this host's business
 * and must not stop it starting. That matters for the case somebody will
 * eventually want — two hosts on two databases, deliberately — and it costs
 * nothing to leave open now.
 */
export async function claimPair(ask: Ask, prefer = PREFERRED_API): Promise<Claim> {
  for (let step = 0; step < TRIES; step += 1) {
    /* Pairs are two apart, not one: a pair at 4180/4181 and another at
       4181/4182 would have the second host's API answering on the first host's
       page port, which is the confusion this is meant to prevent. */
    const api = prefer + step * 2
    const page = api + 1

    const onApi = await ask(api)

    if (onApi.kind === 'host') {
      /* Only at the preferred pair. Further out it means somebody else moved
         here first, and the honest response is to keep looking rather than to
         report their host as the answer to this request. */
      if (step === 0) {
        return {
          kind: 'already',
          api,
          page,
          why:
            `Kehikot is already running. Open http://127.0.0.1:${page} — nothing was started, `
            + 'and a second host would be a second program writing the same canvases.',
        }
      }
      continue
    }

    if (onApi.kind === 'stranger') continue

    const onPage = await ask(page)
    if (onPage.kind !== 'free') continue

    return {
      kind: 'take',
      api,
      page,
      moved: step > 0,
      why:
        step === 0
          ? `Kehikot is at http://127.0.0.1:${page}`
          : `PORTS MOVED: ${prefer}/${prefer + 1} was taken by something else. `
            + `Kehikot is at http://127.0.0.1:${page} instead, with its API on ${api}.`,
    }
  }

  return {
    kind: 'nowhere',
    why:
      `Every port from ${prefer} to ${prefer + TRIES * 2} is taken, so there is nowhere to put a host. `
      + 'Something is holding a lot of ports, or a previous host did not shut down.',
  }
}
