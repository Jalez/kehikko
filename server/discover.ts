import {
  LIMITS,
  manifestSchema,
  PROTOCOL,
  speaks,
  WELL_KNOWN,
  type Manifest,
  type ModuleCondition,
} from 'roadmap-module-protocol'
import type { Registration } from './registrations.ts'

/**
 * Ask each registered program what it is, and decide whether it can be
 * honoured.
 *
 * This runs on the server rather than in the page, and not for tidiness. A
 * module answers on its own origin; a page fetching `/.well-known/...` across
 * that boundary needs the module to have opted into CORS, and a module author
 * who has not thought about CORS would be a module that "does not exist"
 * according to a host that never reached it. The server has no such boundary,
 * so the one place a manifest is read is the one place that can read every
 * manifest.
 *
 * Everything below is the host's own decision, made over material the module
 * cannot reach: which origin the document arrived from, how many bytes it was
 * allowed to be, how long it was allowed to take. The protocol package supplies
 * the shapes and the reading (`manifestSchema`, `speaks`); it supplies none of
 * this, on purpose, and a host that imported a decision from it would be
 * importing a decision a module author can publish a patched copy of.
 */

/**
 * What the host concluded about one registered program.
 *
 * `condition` is one of the protocol's three words and nothing else, because
 * three words that a person can learn are worth more than an accurate taxonomy
 * they cannot. `line` is the sentence shown beside it, and it is where every
 * distinction the three words cannot carry actually lives.
 */
export interface Presence {
  id: string
  /** The origin the registration named. Always shown: it is where to go looking. */
  at: string
  condition: ModuleCondition
  /** The sentence the host puts on screen. Written here so there is one of it. */
  line: string
  /**
   * What the module calls itself, when the host got far enough to find out.
   *
   * Carried separately from `module`, which exists only for a module that will
   * actually be framed. An incompatible module has a name — the host read its
   * manifest, that is HOW it knows the module is incompatible — and putting the
   * registration id on the container instead would mean the header and the sentence
   * under it naming the same program two different ways.
   */
  name?: string
  /** Present exactly when the condition is `ready`. URLs already resolved. */
  module?: FramedModule
  /** Both numbers, whenever the host had both. The reason `incompatible` is legible. */
  protocols?: { host: number; module: number | null; range: string }
}

/** A manifest the host will honour, with every URL resolved and re-checked. */
export interface FramedModule {
  id: string
  name: string
  version: string
  summary: string
  /** What this module says its presence obliges an agent to do. */
  guidance: string
  /** Absolute, on the module's own origin, ready to be a frame's `src`. */
  entry: string
  icon: string | null
  health: string | null
  mcp: { url: string; transport: string; about: string } | null
  modes: Manifest['modes']
  extensions: Manifest['extensions']
  declares: Manifest['declares']
}

/** How long the host waits for a manifest before calling the program silent. */
export const MANIFEST_TIMEOUT_MS = 2500

/**
 * Fetch one manifest, bounded in both time and size.
 *
 * Bounded in time because a program that accepts a connection and then never
 * writes is the exact failure `silent` exists to name, and a host without a
 * deadline would hang on it rather than report it. Bounded in size because
 * `LIMITS.MANIFEST_BYTES` is the protocol's own answer to "as much of a
 * document as anyone should read from a stranger on a port", and reading past
 * it would mean the bounds inside the schema were guarding a string the host
 * had already committed a megabyte to holding.
 */
export async function fetchManifest(
  origin: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = MANIFEST_TIMEOUT_MS,
): Promise<{ ok: true; text: string } | { ok: false; why: string }> {
  const url = new URL(WELL_KNOWN, origin).toString()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      signal: abort.signal,
      headers: { accept: 'application/json' },
      redirect: 'error',
    })
    if (!response.ok) return { ok: false, why: `answered ${response.status} at ${WELL_KNOWN}` }
    const text = await response.text()
    if (text.length > LIMITS.MANIFEST_BYTES) {
      return { ok: false, why: `served more than ${LIMITS.MANIFEST_BYTES} bytes at ${WELL_KNOWN}` }
    }
    return { ok: true, text }
  } catch (error) {
    const name = (error as Error)?.name
    if (name === 'AbortError' || name === 'TimeoutError') {
      return { ok: false, why: `did not answer within ${timeoutMs}ms` }
    }
    return { ok: false, why: 'nothing is answering' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve one URL out of a manifest against the origin the manifest came from,
 * and refuse it if it leaves.
 *
 * The protocol package is explicit that it does not do this and cannot: it
 * never sees the origin. It is the host's, and it is the check that stops a
 * module using the host as a lever — pointing `entry` at somebody else's page
 * so the host frames it, or `health` at somebody else's server so the host
 * polls it. A module gets to describe itself; it does not get to describe
 * anybody else.
 */
export function resolveOnOrigin(value: string, origin: string): string | null {
  let resolved: URL
  try {
    resolved = new URL(value, origin)
  } catch {
    return null
  }
  return resolved.origin === new URL(origin).origin ? resolved.toString() : null
}

/**
 * The whole decision about one registration, as one function over one fetch.
 *
 * Read the returns in order; they are the four things that can be true, and the
 * comments say why three of them are spelled `silent`.
 */
export async function look(
  registration: Registration,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = MANIFEST_TIMEOUT_MS,
): Promise<Presence> {
  const { id, at } = { id: registration.id, at: registration.url }

  const got = await fetchManifest(at, fetchImpl, timeoutMs)
  if (!got.ok) {
    /* Nothing answered. This is the common case and the one the wording has to
       carry: a program that is not running looks exactly like a program that was
       never installed, and the difference between them is the difference between
       pressing start and searching the internet for something that does not
       exist. So the sentence names the address, says the host expected a module
       there, and says it is not running rather than not found. */
    return {
      id,
      at,
      condition: 'silent',
      line: `${id} is registered at ${at} and ${got.why}. It is not running — it has not gone missing.`,
    }
  }

  let raw: unknown
  try {
    raw = JSON.parse(got.text)
  } catch {
    /* Something is listening and it is not a module.

       Spelled `silent` rather than given a fourth word, because the three
       conditions are a vocabulary a person learns once and a fourth would be
       one more thing to learn for a case that is nearly always a typo in a port
       number. What the host owes here is not a new word but a true sentence,
       and the sentence says exactly what happened: something answered, and it
       was not this. */
    return {
      id,
      at,
      condition: 'silent',
      line: `Something is answering at ${at}, but what it served at ${WELL_KNOWN} is not JSON. No module here answers as ${id}.`,
    }
  }

  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path.length ? first.path.join('.') : 'the document'
    return {
      id,
      at,
      condition: 'silent',
      line: `Something is answering at ${at}, but its manifest is not one this host can read: ${where} — ${first?.message ?? 'malformed'}. No module here answers as ${id}.`,
    }
  }

  const manifest = parsed.data
  const range = manifest.declares.protocol

  /* Two comparisons, not one, and the protocol package says why in `speaks`:
     a permissive range from a module that says it was built against protocol 9
     is not an argument for anything. The range says what the module can speak;
     `manifest.protocol` says what it was built against. Both have to include
     this host. */
  if (manifest.protocol > PROTOCOL) {
    return {
      id,
      at,
      condition: 'incompatible',
      name: manifest.name,
      line: `${manifest.name} was built against protocol ${manifest.protocol}. This host speaks protocol ${PROTOCOL}.`,
      protocols: { host: PROTOCOL, module: manifest.protocol, range },
    }
  }

  if (!speaks(range, PROTOCOL)) {
    return {
      id,
      at,
      condition: 'incompatible',
      name: manifest.name,
      line: `${manifest.name} speaks protocol ${range}. This host speaks protocol ${PROTOCOL}.`,
      protocols: { host: PROTOCOL, module: manifest.protocol, range },
    }
  }

  /* The id in the manifest is the module's own claim about its name. The
     registration's file name is the person's. They disagreeing is a fault worth
     naming rather than an impersonation to defend against — the host never
     identifies a module by a string it was handed — but a host that framed it
     silently would be showing a program under a name nobody chose for it. */
  if (manifest.id !== id) {
    return {
      id,
      at,
      condition: 'silent',
      line: `The program at ${at} calls itself ${manifest.id}, and the registration here is for ${id}. Nothing answers as ${id}.`,
    }
  }

  const entry = resolveOnOrigin(manifest.entry, at)
  if (!entry) {
    return {
      id,
      at,
      condition: 'silent',
      line: `${manifest.name} points its page at ${manifest.entry}, which is not on ${at}. A module may describe itself and not somebody else, so there is nothing here to frame.`,
    }
  }

  return {
    id,
    at,
    condition: 'ready',
    name: manifest.name,
    line: manifest.summary || `${manifest.name} ${manifest.version}`,
    protocols: { host: PROTOCOL, module: manifest.protocol, range },
    module: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      summary: manifest.summary,
      /**
       * What this module says its presence obliges an agent to do.
       *
       * Carried, never read here. The canvas composes it into the prompt every
       * agent on a kehikko is handed, attributed to the module that said it —
       * because a host can vouch that a module said something and never that it
       * is true.
       *
       * How this came to be missing is worth recording, because it is the same
       * lesson three modules learned today. Everything below is a LIST OF NAMED
       * FIELDS, and a list silently falls behind. The module served `guidance`
       * correctly; the host fetched it, parsed it, and then built an object
       * without it — so the field arrived and vanished with nothing erroring
       * anywhere, and it took reading the served manifest side by side with the
       * host's own answer to see it. The URLs below genuinely must be named,
       * since each is resolved against the origin, but every plain field here
       * is a candidate for the same quiet loss.
       */
      guidance: manifest.guidance,
      entry,
      /* Every other URL gets the same treatment as `entry`, and each is dropped
         rather than refusing the whole module: an icon pointing somewhere else
         is a module with no icon, which is a module. `health` is carried,
         resolved, even though nothing polls it yet — the protocol package makes
         the argument for carrying it and it is right: the alternative is
         re-reading the raw JSON later, which is how a second, looser check gets
         written. */
      icon: manifest.icon ? resolveOnOrigin(manifest.icon, at) : null,
      health: manifest.health ? resolveOnOrigin(manifest.health, at) : null,
      mcp: manifest.mcp
        ? (() => {
            const url = resolveOnOrigin(manifest.mcp.url, at)
            return url ? { url, transport: manifest.mcp.transport, about: manifest.mcp.about } : null
          })()
        : null,
      modes: manifest.modes,
      extensions: manifest.extensions,
      declares: manifest.declares,
    },
  }
}
