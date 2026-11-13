import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readBuild, START_HEADER, startVerdict, WELL_KNOWN } from 'kehikot-module-protocol'

/**
 * Starting a module on ANY free port (protocol 2.65.0, `PORT=0`), and finding where it went.
 *
 * With the stable addresses on, nothing that reaches a module names its port: frames, agents'
 * doors and session configs all go through this host (`moduleProxy.ts`). So a module no longer
 * needs a port the host knows in advance. Its port is a number that another program can take,
 * which is the whole failure this work removes. This host hands a module that understands it a
 * port nobody names, from the protocol's band (`modulePorts.ts`; not `PORT=0`, which the system
 * fills from the range it also gives other programs' servers), and the module binds it, or the
 * next free one, and writes that port into its registration, where the host (and the proxy) read it.
 *
 * Only to a module whose INSTALLED protocol package is 2.65.0 or newer (`takesAnyPort`): a module
 * built before then reads `PORT=0` as no port and takes its preferred port and the drift rules (the
 * fallback, exactly as before), and a module that does not use the protocol's serving might bind
 * port 0 without saying where. Read from the checkout the host is about to run, so it is the code
 * that will start, not a manifest from a process that may be older.
 */

/** The protocol package that reads `PORT=0` as any free port. */
export const ANY_PORT_SINCE = '2.65.0'

/** `major.minor.patch` as numbers, or null. */
function parts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/** Whether `version` is `since` or newer. False when either does not read as a version. */
export function atLeast(version: string, since: string): boolean {
  const a = parts(version)
  const b = parts(since)
  if (!a || !b) return false
  for (let i = 0; i < 3; i += 1) if (a[i]! !== b[i]!) return a[i]! > b[i]!
  return true
}

/** The protocol package installed in a module's checkout, or null when there is none to read. */
export function installedProtocol(dir: string, read: (file: string) => string = (file) => readFileSync(file, 'utf8')): string | null {
  try {
    const version = (JSON.parse(read(join(dir, 'node_modules', 'kehikot-module-protocol', 'package.json'))) as { version?: unknown }).version
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

/** Whether the module in `dir` may be started with `PORT=0`. */
export function takesAnyPort(dir: string | undefined, read?: (file: string) => string): boolean {
  if (!dir) return false
  const version = installedProtocol(dir, read)
  return version !== null && atLeast(version, ANY_PORT_SINCE)
}

/**
 * Whether the module answering at `origin` is the process this host started with `token`: its
 * manifest is `id`'s and says that token back. For a start on any port, where the registration
 * may still name the port of the process before, and something else may have it now.
 */
export async function answersAs(origin: string, id: string, token: string, fetchImpl: typeof fetch = fetch, timeoutMs = 600): Promise<boolean> {
  try {
    const response = await fetchImpl(new URL(WELL_KNOWN, origin), { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return false
    const body = (await response.json().catch(() => null)) as { id?: unknown; build?: unknown } | null
    if (!body || body.id !== id) return false
    return startVerdict(token, readBuild(body.build)?.start ?? response.headers.get(START_HEADER)) === 'same'
  } catch {
    return false
  }
}
