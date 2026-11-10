import { stableEntry } from './moduleAddress.ts'

/**
 * Whether THIS page frames modules on their stable frame addresses (`moduleAddress.ts`).
 *
 * A frame's address is `<label>.kehikot.localhost:<port>`. `*.localhost` is loopback by rule, but
 * how a webview resolves it — `::1` or `127.0.0.1` first, at all — is the webview's, and only the
 * page can find out. So once per page, before the first reading of the modules is used, it asks:
 *
 *  1. `/host/module-addresses` (its own host, as every route): are the addresses on, may frames
 *     have them (`frames`: the host holds `::1` too), and where to check;
 *  2. the check address, a name under `kehikot.localhost`: is the answer the host's own
 *     (`host`, minted per start)?
 *
 * Only when both say yes does a module's `entry` move onto its `address`. Anything else — the
 * addresses off, the name not resolving, a refusal, another program answering, no answer within
 * `CHECK_TIMEOUT_MS` — leaves every frame on its module's own origin, and the reason is said once
 * in the console and in the host's log (`/host/module-addresses/check`). Decided once per page: a
 * frame never moves under a person mid-session.
 */

/** How long the check address gets to answer. A loopback answer is a few milliseconds. */
export const CHECK_TIMEOUT_MS = 2_500

type State = { usable: boolean; why: string | null }

let state: State | null = null
let checking: Promise<State> | null = null

/** What the host says about the addresses, as far as the check reads it. */
interface Said {
  on?: boolean
  frames?: boolean
  why?: string
  check?: { url?: unknown; host?: unknown }
}

/** Find out, once per page. Never throws; resolves when it is known. */
export function checkAddresses(fetchImpl: typeof fetch = fetch): Promise<State> {
  if (state) return Promise.resolve(state)
  checking ??= run(fetchImpl).then((found) => {
    state = found
    if (!found.usable && found.why) tell(found.why, fetchImpl)
    return found
  })
  return checking
}

async function run(fetchImpl: typeof fetch): Promise<State> {
  let said: Said
  try {
    const response = await fetchImpl('/host/module-addresses', { cache: 'no-store' })
    /* An older host has no such route: frames stay where they always were, and nothing to say. */
    if (!response.ok) return { usable: false, why: null }
    said = (await response.json()) as Said
  } catch {
    return { usable: false, why: null }
  }
  if (!said.on) return { usable: false, why: null }
  if (!said.frames) return { usable: false, why: said.why ?? 'The host cannot give frames their own addresses here.' }
  const url = typeof said.check?.url === 'string' ? said.check.url : null
  const host = typeof said.check?.host === 'string' ? said.check.host : null
  if (!url || !host) return { usable: false, why: 'The host did not say where to check a frame address.' }
  try {
    const response = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })
    if (!response.ok) return { usable: false, why: `${url} answered ${response.status}, so it is not this host answering there.` }
    const body = (await response.json().catch(() => null)) as { host?: unknown } | null
    if (body?.host !== host) return { usable: false, why: `Another program answered at ${url}, not this host.` }
    return { usable: true, why: null }
  } catch (error) {
    const name = (error as Error)?.name
    return {
      usable: false,
      why: name === 'TimeoutError' || name === 'AbortError' ? `${url} did not answer within ${CHECK_TIMEOUT_MS / 1000} s.` : `${url} could not be reached from this page (${(error as Error)?.message ?? 'no reason'}).`,
    }
  }
}

function tell(why: string, fetchImpl: typeof fetch): void {
  console.warn(`Kehikot: modules are framed on their own origins, not their stable addresses: ${why}`)
  void fetchImpl('/host/module-addresses/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: false, why }),
  }).catch(() => {})
}

/** Whether this page frames modules on their stable addresses. False until the check said yes. */
export function addressesUsable(): boolean {
  return state?.usable === true
}

/** A module, as framed by this page: `entry` on its address when the check said yes, as it came otherwise. */
export function framedOn<T extends { entry: string; address?: string }>(module: T): T {
  if (!module.address || !addressesUsable()) return module
  const entry = stableEntry(module.entry, module.address)
  return entry ? { ...module, entry } : module
}

/** A reading of the modules with every framed module's entry where this page frames it. */
export function onAddresses<V extends { presences: Array<{ module?: { entry: string; address?: string } }>; pins?: Array<{ presence: { module?: { entry: string; address?: string } } | null }> }>(view: V): V {
  if (!addressesUsable()) return view
  return {
    ...view,
    presences: view.presences.map((presence) => (presence.module ? { ...presence, module: framedOn(presence.module) } : presence)),
    ...(view.pins
      ? { pins: view.pins.map((pin) => (pin.presence?.module ? { ...pin, presence: { ...pin.presence, module: framedOn(pin.presence.module) } } : pin)) }
      : {}),
  }
}

/** For tests. */
export function resetAddressCheck(): void {
  state = null
  checking = null
}
