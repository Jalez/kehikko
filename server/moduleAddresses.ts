import { ADDRESS_CHECK_LABEL, ADDRESS_CHECK_PATH, frameOriginFor, machineBaseFor, MODULE_HOST_SUFFIX } from '../src/host/moduleAddress.ts'

/**
 * Whether modules are reached at stable addresses on this host (`moduleProxy.ts`), and whether a
 * frame may be given one.
 *
 * ON unless `KEHIKOT_MODULE_ADDRESSES=0`, the way out if they break something. With it off this
 * host answers exactly as before the addresses: a frame's name is not one of its own (`guard.ts`
 * refuses it), `/m/…` is not a route, frames are on their modules' own origins and agents' doors
 * on the modules' ports.
 *
 * With it on, agents' doors are written on the program address, and the page frames a module on
 * its frame address once it checked that such an address reaches this host
 * (`src/host/addressCheck.ts`, against `check` below). A page whose check failed frames on the
 * modules' own origins and says why (`checked`).
 */

/** The variable that turns the stable addresses off (`0`). */
export const ADDRESSES_ENV = 'KEHIKOT_MODULE_ADDRESSES'

export function addressesOn(env: Record<string, string | undefined>): boolean {
  return env[ADDRESSES_ENV]?.trim() !== '0'
}

/** What `/host/module-addresses` answers. */
export interface AddressesSaid {
  on: boolean
  /**
   * Whether a frame may be given its `*.kehikot.localhost` address: this host holds `::1` at its
   * port as well as 127.0.0.1, so nothing else can answer one first.
   */
  frames: boolean
  /** Why not, when `on` and not `frames`. */
  why?: string
  /** The addresses, spelled for one example id, so a reader sees the shape. */
  shape?: { frame: string | null; machine: string }
  /** Where the page checks that a frame's address reaches this host, and what this host answers there. */
  check?: { url: string; host: string }
  /** What the last page's check found: null before one reported. */
  checked?: { ok: boolean; why: string | null } | null
}

let state: { port: number; frames: boolean; why?: string } | null = null
let lastCheck: { ok: boolean; why: string | null } | null = null

export const moduleAddresses = {
  /** This host holds `::1` at its port. */
  held(port: number): void {
    state = { port, frames: true }
  },
  /** It could not: a frame given a `*.localhost` address might reach another program on `::1`. */
  notHeld(port: number, error: string): void {
    state = {
      port,
      frames: false,
      why: `This host could not listen on [::1]:${port} (${error}). A module's frame address resolves to [::1] first, so frames keep their ports.`,
    }
    console.log(`kehikko: module addresses: ${state.why}`)
  },
  said(on: boolean, check?: string): AddressesSaid {
    if (!on || !state) return { on: false, frames: false }
    return {
      on: true,
      frames: state.frames,
      ...(state.why ? { why: state.why } : {}),
      shape: { frame: frameOriginFor('kehikot.example', state.port), machine: machineBaseFor('kehikot.example', state.port) },
      ...(check && state.frames ? { check: { url: `http://${ADDRESS_CHECK_LABEL}.${MODULE_HOST_SUFFIX}:${state.port}${ADDRESS_CHECK_PATH}`, host: check } } : {}),
      checked: lastCheck,
    }
  },
  /** What a page's self-check found. A failure is logged with its reason, once per change. */
  checked(ok: boolean, why: string | null): void {
    const before = lastCheck
    lastCheck = { ok, why: why ? why.slice(0, 500) : null }
    if (!ok && (before?.ok !== false || before.why !== lastCheck.why)) {
      console.log(`kehikko: module addresses: the page could not reach this host at a frame's address, so frames keep their modules' own origins: ${lastCheck.why ?? 'no reason given'}`)
    }
  },
  /** For tests. */
  reset(): void {
    state = null
    lastCheck = null
  },
}
