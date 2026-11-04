import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { claim, originFor, type Claimed, type ClaimOptions } from 'kehikot-module-protocol/serve'

import { fetchManifest } from './discover.ts'
import type { Proof } from './takeover.ts'

/**
 * A module's port held by a program that is not the module.
 *
 * ## The case this is for
 *
 * A registration names a port, and nothing stops another program from taking
 * that port while the module is not running — a dev server somebody started, a
 * different app, anything. The container then reads "Something is answering
 * at …, but it is not a module", and "start it" used to refuse: this host did
 * not start that program and could not prove it was the module, so it would not
 * stop it — rightly — and there was nothing else it would do. The person was
 * told to stop a program they had never started, or to restart the app.
 *
 * Stopping it stays out of the question. What the host CAN do needs no proof
 * at all, because it touches nothing that is somebody else's: run the module
 * somewhere else. That is what a module does for itself when its port is taken
 * on start (`claim` in the protocol's `serve`), so the host asks the same
 * `claim` for a port, writes it into the module's registration, and starts the
 * module there. The program on the old port is left exactly as it was.
 *
 * ## Which listener is "not the module"
 *
 * `judge` decides, from what `proveListener` found and what the listener says
 * it is, and nothing else:
 *
 *  - proven to run from the module's own directory: it IS the module — an
 *    orphan of an earlier run of this host, healthy or not. The ordinary
 *    restart stops it by its process group (`takeover.ts`) and starts it again,
 *    and the new one is this host's.
 *  - answering as this module but not proven: a copy somebody started from
 *    another folder (their own dev server). Today's refusal, unchanged — the
 *    host neither stops it nor runs a second copy beside it.
 *  - running from the module's directory but in a group the host will not
 *    signal: the module, unstoppable. Refused as before.
 *  - anything else — it serves no manifest, or one with another id, and runs
 *    from somewhere else (or the host could not ask): not the module. Moved.
 */
export type Occupied =
  /** Nothing is listening: start normally. */
  | { kind: 'free' }
  /** The module, running from its own directory: stop it by its group and start it again. */
  | { kind: 'ours' }
  /** Possibly the module, and not the host's to stop: refuse as before. */
  | { kind: 'held' }
  /** Not the module: leave it, and run the module on another port. */
  | { kind: 'foreign' }

/** The registration's id and the one the program answered with name the same module. The pre-rename prefix counts. */
function sameModule(id: string, said: string): boolean {
  const spelled = (one: string) => one.replace(/^roadmap\./, 'kehikot.')
  return spelled(said) === spelled(id)
}

/** The id the program at `url` gives in its manifest, or null when it serves none (not JSON, no id, not answering). */
export async function answersAs(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const got = await fetchManifest(url, fetchImpl)
  if (!got.ok) return null
  try {
    const id = (JSON.parse(got.text) as { id?: unknown } | null)?.id
    return typeof id === 'string' ? id : null
  } catch {
    return null
  }
}

/** The decision. Pure: `answersAs` is the id the listener's manifest gives, or null when it gives none. */
export function judge(id: string, proof: Proof, answersAs: string | null): Occupied {
  if (proof.kind === 'nothing') return { kind: 'free' }
  if (proof.kind === 'proven') return { kind: 'ours' }
  if (answersAs !== null && sameModule(id, answersAs)) return { kind: 'held' }
  return proof.because === 'elsewhere' || proof.because === 'unasked' ? { kind: 'foreign' } : { kind: 'held' }
}

export type NewPort = { ok: true; port: number; url: string } | { ok: false; why: string }

/**
 * Where the module goes instead: its first port (from the official list) when
 * that is free, else the next free one after it, skipping every port another
 * registration names — the protocol's own `claim`, so a module moved by the
 * host lands where it would have moved itself. `first` null: from the taken
 * port up.
 */
export async function newPort(opts: {
  id: string
  taken: number
  first: number | null
  registry: string
  probes?: ClaimOptions['probes']
  claimImpl?: (options: ClaimOptions) => Promise<Claimed>
}): Promise<NewPort> {
  const ask = opts.claimImpl ?? claim
  const prefer = opts.first ?? opts.taken
  const claimed = await ask({ id: opts.id, prefer, registry: opts.registry, ...(opts.probes ? { probes: opts.probes } : {}) })
  if (claimed.status === 'nowhere') {
    return { ok: false, why: `Port ${opts.taken} is taken by another program, and this host found no free port to move ${opts.id} to: ${claimed.why}.` }
  }
  /* `already-running`: the module answers on its first port already, under
     this registration's nose. Pointing the registration there is the fix. */
  if (claimed.port === opts.taken) {
    return { ok: false, why: `Port ${opts.taken} is taken by another program, and this host found no other port to move ${opts.id} to.` }
  }
  return { ok: true, port: claimed.port, url: originFor(claimed.port) }
}

/**
 * Point a registration file at `url`, keeping every other key (`keep`, `dir`).
 *
 * JSON only — every registration this host or a module writes is — and
 * written beside the file and renamed into place, so a sweep never reads half
 * of it. A registration somebody wrote as YAML is theirs to edit.
 */
export function repoint(file: string, url: string): { ok: true } | { ok: false; why: string } {
  if (!/\.json$/i.test(file)) {
    return { ok: false, why: `${file} is not JSON, so this host will not rewrite it. Change its url to ${url} to move the module there.` }
  }
  let kept: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    kept = value as Record<string, unknown>
  } catch (error) {
    return { ok: false, why: `${file} could not be read (${(error as Error).message}), so it was not moved to ${url}.` }
  }
  const { port: _port, ...rest } = kept
  const tmp = `${file}.moving-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify({ ...rest, url }, null, 2)}\n`)
  renameSync(tmp, file)
  return { ok: true }
}

/** What a person is told. Plain, and only about ports. */
export function movedLine(name: string, from: number, to: number): string {
  return `Port ${from} was taken by another program; ${name} now runs on ${to}.`
}
