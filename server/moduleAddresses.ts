import { frameOriginFor, machineBaseFor } from '../src/host/moduleAddress.ts'

/**
 * Whether modules are reached at stable addresses on this host (`moduleProxy.ts`), and whether a
 * frame may be given one.
 *
 * OFF unless `KEHIKOT_MODULE_ADDRESSES=1`. With it off this host answers exactly as before: a
 * frame's name is not one of its own (`guard.ts` refuses it) and `/m/…` is not a route. Nothing
 * hands the addresses out yet. The canvas, the agents' doors and the session MCP configs switch to
 * them in a later step, reading `/host/module-addresses` to know whether they may.
 */

/** The variable that turns the stable addresses on. */
export const ADDRESSES_ENV = 'KEHIKOT_MODULE_ADDRESSES'

export function addressesOn(env: Record<string, string | undefined>): boolean {
  return env[ADDRESSES_ENV]?.trim() === '1'
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
}

let state: { port: number; frames: boolean; why?: string } | null = null

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
  said(on: boolean): AddressesSaid {
    if (!on || !state) return { on: false, frames: false }
    return {
      on: true,
      frames: state.frames,
      ...(state.why ? { why: state.why } : {}),
      shape: { frame: frameOriginFor('kehikot.example', state.port), machine: machineBaseFor('kehikot.example', state.port) },
    }
  },
  /** For tests. */
  reset(): void {
    state = null
  },
}
