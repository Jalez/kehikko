import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MODULE_ID } from 'roadmap-module-protocol'

/**
 * Where the host looks, and the whole of what it is told.
 *
 * A registration is a file in a directory. Its NAME is the module's id and its
 * CONTENTS say where that module answers. Nothing else about a module is known
 * before the manifest is fetched, and that is deliberate: the host installs
 * nothing, downloads nothing, and holds no catalogue. A program is present
 * because somebody put a file here, and absent because they did not.
 *
 * The id comes from the file name rather than from a field inside the file for
 * one reason: a registration must not be able to claim to be for a module it is
 * not. If the id were a field, two files could name the same module and the
 * second would silently shadow the first — a program running under a name
 * somebody else chose, with no trace of the collision anywhere. A file system
 * already refuses two files with one name, so the file system is where the
 * uniqueness is enforced and there is nothing to re-enforce here.
 */

/** What one registration says. Nothing here is trusted; it is only read. */
export interface Registration {
  /** From the file name, minus its extension. Matched against `MODULE_ID`. */
  id: string
  /** The origin the module answers on. Loopback only — see `readRegistrations`. */
  url: string
  /** Where the file came from, so a complaint can name it. */
  file: string
}

/** A registration file the host read and would not use, with the reason. */
export interface RejectedRegistration {
  file: string
  why: string
}

export interface RegistrationSweep {
  registrations: Registration[]
  rejected: RejectedRegistration[]
  /** The directory swept, always reported so an empty result can be explained. */
  dir: string
}

/**
 * The directory registrations live in.
 *
 * `ROADMAP_MODULES_DIR` overrides it, which is what makes the host testable
 * without a person's real modules directory taking part in a test run.
 */
export function registryDir(env: Record<string, string | undefined> = process.env): string {
  return env.ROADMAP_MODULES_DIR ?? join(homedir(), '.roadmap', 'modules')
}

/**
 * A registration file's body: JSON, or the flat `key: value` YAML the example
 * registration in this repository is written in.
 *
 * The YAML reader handles scalars at the top level and nothing else — no
 * nesting, no lists, no anchors, no multi-line strings. That is not a
 * limitation working around a missing dependency; it is the entire grammar a
 * registration has. A file that needs more than this is a file saying something
 * the host has no field for, and reading it with a full parser would only mean
 * failing later and less clearly.
 */
export function parseRegistrationBody(text: string, file: string): Record<string, string> {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    const value: unknown = JSON.parse(trimmed)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${file} is JSON but not an object`)
    }
    const out: Record<string, string> = Object.create(null)
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' || typeof v === 'number') out[k] = String(v)
    }
    return out
  }

  const out: Record<string, string> = Object.create(null)
  for (const raw of trimmed.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const at = line.indexOf(':')
    if (at < 1) continue
    const key = line.slice(0, at).trim()
    let val = line.slice(at + 1).trim()
    const hash = val.indexOf(' #')
    if (hash >= 0) val = val.slice(0, hash).trim()
    val = val.replace(/^['"]|['"]$/g, '')
    if (val) out[key] = val
  }
  return out
}

/**
 * Turn one file's name and body into a registration, or say why not.
 *
 * Split out from the directory sweep so it can be reasoned about — and tested —
 * without a directory. Every refusal here produces a sentence naming the file,
 * because a registration the host silently skipped is the worst failure this
 * whole design has: the person wrote a file, nothing appeared, and there is
 * nowhere to look.
 */
export function readRegistration(
  fileName: string,
  body: string,
): { ok: true; registration: Omit<Registration, 'file'> } | { ok: false; why: string } {
  const id = fileName.replace(/\.(json|ya?ml)$/i, '')
  if (!MODULE_ID.test(id)) {
    return {
      ok: false,
      why: `"${id}" is not a module id: lowercase letters, digits, dots and dashes, 3 to 64 characters.`,
    }
  }

  let fields: Record<string, string>
  try {
    fields = parseRegistrationBody(body, fileName)
  } catch (error) {
    return { ok: false, why: `could not be read: ${(error as Error).message}` }
  }

  /* `own`-style lookup by construction: `parseRegistrationBody` builds its
     result with a null prototype, so `fields.constructor` is undefined rather
     than a function. The id in a registration is a stranger's string and so are
     its keys; see the essay on MODULE_ID in the protocol package. */
  const explicit = fields.url
  const port = fields.port

  let url: string
  if (explicit) url = explicit
  else if (port) url = `http://127.0.0.1:${port}`
  else return { ok: false, why: 'says neither a url nor a port, so there is nowhere to look.' }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, why: `"${url}" is not a URL.` }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, why: `"${url}" is not http or https.` }
  }

  /* Loopback only.

     Not a permission and not a trust boundary — the host has no notion of an
     untrusted publisher and everything here belongs to the same person. It is a
     statement about what this program IS: a host for the small programs
     somebody runs on their own machine. A registration pointing at a machine
     across the internet is asking this host to be something else, and the
     honest answer is that it is not that, said here, once, rather than
     discovered later as a frame nobody expected. */
  if (!isLoopback(parsed.hostname)) {
    return {
      ok: false,
      why: `"${parsed.hostname}" is not this machine. This host frames programs running here, on loopback.`,
    }
  }

  return { ok: true, registration: { id, url: parsed.origin } }
}

/** localhost, 127.0.0.0/8, and ::1, written out rather than guessed at. */
export function isLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  return v4 !== null && v4[1] === '127'
}

/**
 * Sweep the directory once.
 *
 * A missing directory is not an error and not an empty answer either: it is
 * reported as a sweep of zero files over a named directory, so the page can say
 * where it looked. "No modules" and "no such directory" are two different
 * things to be told, and only one of them is fixed by starting a program.
 */
export async function readRegistrations(dir = registryDir()): Promise<RegistrationSweep> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return { registrations: [], rejected: [], dir }
  }

  const registrations: Registration[] = []
  const rejected: RejectedRegistration[] = []

  for (const name of names.sort()) {
    if (!/\.(json|ya?ml)$/i.test(name)) continue
    const file = join(dir, name)
    let body: string
    try {
      body = await readFile(file, 'utf8')
    } catch (error) {
      rejected.push({ file, why: `could not be read: ${(error as Error).message}` })
      continue
    }
    const read = readRegistration(name, body)
    if (read.ok) registrations.push({ ...read.registration, file })
    else rejected.push({ file, why: read.why })
  }

  return { registrations, rejected, dir }
}
