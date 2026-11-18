import { stableEntry } from './moduleAddress.ts'
import { decide } from './pageLog.ts'

/**
 * Whether THIS page frames modules on their stable frame addresses (`moduleAddress.ts`).
 *
 * A frame's address is `<label>.kehikot.localhost:<port>`. `*.localhost` is loopback by rule, but
 * how a webview resolves it — `::1` or `127.0.0.1` first, at all, and how long a name takes — is the
 * webview's and the machine's, and only the page can find out. So it asks:
 *
 *  1. `/host/module-addresses` (its own host, as every route): are the addresses on, may frames
 *     have them (`frames`: the host holds `::1` too), and where to check;
 *  2. the check address, a name under `kehikot.localhost`: is the answer the host's own
 *     (`host`, minted per start)?
 *
 * Only when both say yes does a module's `entry` move onto its `address`.
 *
 * ## One slow answer does not decide the session
 *
 * The first try is made before the first reading of the modules is used, and gets
 * `CHECK_TIMEOUT_MS`. On a busy machine at a restart a name can take longer than that to answer the
 * first time: each new `*.kehikot.localhost` name is a lookup of its own (measured in WebKit: a few
 * ms for a name already looked up, 25–220 ms for a new one under heavy load, and slower again where
 * something inspects every lookup), while the host's own address answered in 2–3 ms throughout.
 * It used to be decided once, so one slow first lookup kept every frame on its port for the whole
 * session. The frames work there; it is the stable address that keeps a frame on its module when
 * the module's port changes.
 *
 * Now a try that failed for a reason that can pass (no answer in time, not reachable, another
 * answer) is made again in the background, `RETRY_MS` apart and each with a longer timeout
 * (`TRY_TIMEOUT_MS`), the last spacing repeated for as long as the page lives. What the host SAID
 * (addresses off, frames may not have them, an older host) is final and not asked again.
 *
 * When a later try passes, frames move onto their stable addresses, never under a person
 * (`settleFrames`): a frame on a new origin is a new document, so the module's page is loaded again
 * (its view is kept: the host hands it its state again in its greeting, as at any reload). A module
 * with no frame on the page moves at once; a frame moves when it does not have the person's focus;
 * a module whose restart ends live sessions (`holds: ['live-sessions']`: a terminal, an agent
 * conversation) stays on its port while its frame is on the page, since a reload would end them.
 *
 * Every try, its timeout and how long the host's own address took go to the page log (area
 * `addresses`): the own address slow as well means the host was busy; only the check slow means the
 * name lookup was.
 */

/** How long the first try's check address gets to answer. A loopback answer is a few milliseconds. */
export const CHECK_TIMEOUT_MS = 2_500

/** How long after a failed try the next one is made: then the last, for as long as the page lives. */
export const RETRY_MS: readonly number[] = [2_000, 5_000, 15_000, 60_000]

/** The timeout of each try, the first included: then the last. A later try is given longer. */
export const TRY_TIMEOUT_MS: readonly number[] = [CHECK_TIMEOUT_MS, 5_000, 10_000, 15_000]

/** How often frames kept on their ports after a late pass are looked at again. */
export const SETTLE_MS = 5_000

type State = { usable: boolean; why: string | null }

/** One try's result, with whether trying again can change it. */
interface Tried extends State {
  /** False: the host said so (off, frames may not, an older host). Not asked again. */
  again: boolean
  /** How long the host's own address took to answer `/host/module-addresses`, when it did. */
  ownMs: number | null
}

interface Deps {
  fetch: typeof fetch
  log: (area: string, message: string) => void
  clock: () => number
  /** Calls `then` after `ms`; returns the function that cancels it. */
  later: (then: () => void, ms: number) => () => void
}

const realLater = (then: () => void, ms: number) => {
  const timer = setTimeout(then, ms)
  return () => clearTimeout(timer)
}

let state: State | null = null
let checking: Promise<State> | null = null
let deps: Deps | null = null
let tries = 0
let cancel: (() => void) | null = null
/** A try after the first passed: frames that were framed on their ports move only as `settleFrames` lets them. */
let late = false
/** `settleFrames` has run since the late pass. Until it has, every frame stays where it is. */
let settled = false
/** The stable addresses whose frames stay on their modules' ports for now (see `settleFrames`). */
const stay = new Set<string>()
const listeners = new Set<() => void>()

/** What the host says about the addresses, as far as the check reads it. */
interface Said {
  on?: boolean
  frames?: boolean
  why?: string
  check?: { url?: unknown; host?: unknown }
}

/**
 * Find out. Never throws; resolves when the FIRST try is known. A try that failed for a reason
 * that can pass is made again in the background (`RETRY_MS`); `onAddressesChange` hears when a
 * later one passes.
 */
export function checkAddresses(
  fetchImpl: typeof fetch = fetch,
  log: (area: string, message: string) => void = decide,
  clock: () => number = () => Date.now(),
  later: (then: () => void, ms: number) => () => void = realLater,
): Promise<State> {
  if (state) return Promise.resolve(state)
  deps ??= { fetch: fetchImpl, log, clock, later }
  checking ??= attempt(deps).then(() => state as State)
  return checking
}

async function attempt(using: Deps): Promise<void> {
  const n = ++tries
  const timeout = TRY_TIMEOUT_MS[Math.min(n - 1, TRY_TIMEOUT_MS.length - 1)]!
  const started = using.clock()
  const found = await run(using.fetch, timeout, using.clock)
  /* Reset while it was out (tests): this try is nobody's any more. */
  if (deps !== using) return
  const ms = using.clock() - started
  const retry = !found.usable && found.again ? RETRY_MS[Math.min(n - 1, RETRY_MS.length - 1)]! : null
  using.log('addresses', checkedLine(found, ms, { try: n, timeout, own: found.ownMs, next: retry }))
  const was = state
  state = { usable: found.usable, why: found.why }
  if (found.usable) {
    if (n > 1) {
      late = true
      settled = false
      tell(true, null, using.fetch)
      for (const listener of [...listeners]) listener()
    }
    return
  }
  /* Said once, and again only when the reason changed: a page retrying all day writes one line a minute, not one warning. */
  if (found.why && (n === 1 || was?.why !== found.why)) tell(false, found.why, using.fetch)
  if (retry !== null) cancel = using.later(() => void attempt(using), retry)
}

/** What one try says in the page log. */
export interface TryTold {
  try: number
  timeout: number
  /** The host's own address (`/host/module-addresses`), in ms. */
  own?: number | null
  /** When the next try is made, in ms; null: none. */
  next?: number | null
}

/** The page log's line for a finished try. */
export function checkedLine(found: State, ms: number, told: TryTold = { try: 1, timeout: CHECK_TIMEOUT_MS }): string {
  const which = told.try > 1 ? `try ${told.try}: ` : ''
  const took = `after ${Math.round(ms)} ms (timeout ${told.timeout} ms)`
  const own = told.own != null ? `; the host's own address answered in ${Math.round(told.own)} ms` : ''
  if (found.usable) {
    const moved = told.try > 1 ? 'frames move onto their stable addresses, each when it is not in use' : 'frames go on their stable addresses (<label>.kehikot.localhost)'
    return `${which}stable addresses usable: the check address answered as this host ${took}${own}; ${moved}`
  }
  const next = told.next != null ? `; tries again in ${Math.round(told.next / 1000)} s` : ''
  return `${which}stable addresses not used ${took}${own}; frames stay on their modules' own ports: ${(found.why ?? 'the host has them off, or did not say').replace(/\.$/, '')}${next}`
}

/**
 * Why a module's frame is at the address it is, for the page log (`frames`). `module` is as the
 * host's reading had it, before `framedOn`.
 */
export function whyFramed(module: { address?: string }): string {
  if (!module.address) return 'its own port: the host gave this module no stable address'
  if (state?.usable && !held(module.address)) return 'its stable address: the check passed'
  if (state?.usable) return 'its own port until it is not in use: the check passed later, and a move loads the frame again'
  if (!state) return 'its own port: the stable-address check has not finished'
  return `its own port: ${state.why ?? 'stable addresses are off on this host'}`
}

async function run(fetchImpl: typeof fetch, timeout: number, clock: () => number): Promise<Tried> {
  let said: Said
  const asked = clock()
  let ownMs: number | null = null
  try {
    const response = await fetchImpl('/host/module-addresses', { cache: 'no-store' })
    ownMs = clock() - asked
    /* An older host has no such route: frames stay where they always were, and nothing to say. */
    if (!response.ok) return { usable: false, why: null, again: false, ownMs }
    said = (await response.json()) as Said
  } catch {
    /* The host itself did not answer (it is restarting): the page says so elsewhere; try again. */
    return { usable: false, why: null, again: true, ownMs }
  }
  if (!said.on) return { usable: false, why: null, again: false, ownMs }
  if (!said.frames) return { usable: false, why: said.why ?? 'The host cannot give frames their own addresses here.', again: false, ownMs }
  const url = typeof said.check?.url === 'string' ? said.check.url : null
  const host = typeof said.check?.host === 'string' ? said.check.host : null
  if (!url || !host) return { usable: false, why: 'The host did not say where to check a frame address.', again: false, ownMs }
  try {
    const response = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(timeout) })
    if (!response.ok) return { usable: false, why: `${url} answered ${response.status}, so it is not this host answering there.`, again: true, ownMs }
    const body = (await response.json().catch(() => null)) as { host?: unknown } | null
    if (body?.host !== host) return { usable: false, why: `Another program answered at ${url}, not this host.`, again: true, ownMs }
    return { usable: true, why: null, again: false, ownMs }
  } catch (error) {
    const name = (error as Error)?.name
    return {
      usable: false,
      why: name === 'TimeoutError' || name === 'AbortError' ? `${url} did not answer within ${timeout / 1000} s.` : `${url} could not be reached from this page (${(error as Error)?.message ?? 'no reason'}).`,
      again: true,
      ownMs,
    }
  }
}

function tell(ok: boolean, why: string | null, fetchImpl: typeof fetch): void {
  if (!ok) console.warn(`Kehikot: modules are framed on their own origins, not their stable addresses: ${why}`)
  void fetchImpl('/host/module-addresses/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok, why }),
  }).catch(() => {})
}

/** Whether this page frames modules on their stable addresses. False until a try said yes. */
export function addressesUsable(): boolean {
  return state?.usable === true
}

/** Told when a later try passed, so the page settles its frames and reads its modules again. Returns the function that stops it. */
export function onAddressesChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** After a late pass and before `settleFrames` ran, every frame stays: nothing moves under a person unasked. */
function held(address: string): boolean {
  return late && (!settled || stay.has(address))
}

/** Whether a module's frame is on this page, as `settleFrames` asks it: none, there, or with the person's focus. */
export type FrameUse = 'none' | 'idle' | 'busy'

/** A framed module, as `settleFrames` reads it: its entry as read, its stable address, what a restart of it ends. */
export interface Movable {
  id: string
  entry: string
  address?: string
  holds?: string[]
}

/** `settleFrames`' question asked of a page: is a frame on this origin there, and does it have the focus? */
export function frameUseIn(doc: Pick<Document, 'querySelectorAll' | 'activeElement' | 'baseURI'>): (origin: string) => FrameUse {
  return (origin) => {
    let found: FrameUse = 'none'
    for (const frame of Array.from(doc.querySelectorAll('iframe'))) {
      let at: string
      try {
        at = new URL(frame.src, doc.baseURI).origin
      } catch {
        continue
      }
      if (at !== origin) continue
      if (doc.activeElement === frame) return 'busy'
      found = 'idle'
    }
    return found
  }
}

/**
 * After a late pass: which frames move onto their stable addresses now, and which stay on their
 * modules' ports for the moment. `use` says, for a module's own origin, whether a frame on the page
 * is there (`idle`), has the person's focus (`busy`), or none is (`none`).
 *
 * - none: moves (nothing is reloaded; its next frame is on its address);
 * - idle: moves, unless a restart of it ends live sessions;
 * - busy, or idle holding live sessions: stays, and is looked at again on the next call.
 *
 * A move takes effect at the next reading of the modules (`onAddresses`). Returns what moved and
 * what stays, with why, for the page log; changes nothing before a late pass.
 */
export function settleFrames(modules: readonly Movable[], use: (origin: string) => FrameUse): { moved: string[]; kept: Array<{ id: string; why: string }> } {
  const moved: string[] = []
  const kept: Array<{ id: string; why: string }> = []
  if (!late || !addressesUsable()) return { moved, kept }
  const first = !settled
  for (const module of modules) {
    if (!module.address) continue
    if (!first && !stay.has(module.address)) continue
    let origin: string
    let target: string
    try {
      origin = new URL(module.entry).origin
      target = new URL(module.address).origin
    } catch {
      continue
    }
    /* Already on its address (read since): nothing on its port to wait for. */
    if (origin === target) {
      stay.delete(module.address)
      continue
    }
    const at = use(origin)
    const why = at === 'busy' ? 'it has the focus' : at === 'idle' && module.holds?.includes('live-sessions') ? 'a reload would end its live sessions' : null
    if (why) {
      stay.add(module.address)
      kept.push({ id: module.id, why })
    } else {
      stay.delete(module.address)
      moved.push(module.id)
    }
  }
  settled = true
  return { moved, kept }
}

/** Whether frames still wait on their ports after a late pass: `settleFrames` is worth calling again. */
export function framesWaiting(): boolean {
  return late && (!settled || stay.size > 0)
}

/** The page log's line for a settling that moved or kept something; null when it did neither. */
export function settledLine(result: { moved: string[]; kept: Array<{ id: string; why: string }> }): string | null {
  if (!result.moved.length && !result.kept.length) return null
  const moved = result.moved.length ? `moved onto their stable addresses: ${result.moved.join(', ')}` : null
  const kept = result.kept.length ? `kept on their ports for now: ${result.kept.map((one) => `${one.id} (${one.why})`).join(', ')}` : null
  return `frames ${[moved, kept].filter(Boolean).join('; ')}`
}

/** A module, as framed by this page: `entry` on its address when the check said yes, as it came otherwise. */
export function framedOn<T extends { entry: string; address?: string }>(module: T): T {
  if (!module.address || !addressesUsable() || held(module.address)) return module
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
  cancel?.()
  cancel = null
  state = null
  checking = null
  deps = null
  tries = 0
  late = false
  settled = false
  stay.clear()
  listeners.clear()
}
