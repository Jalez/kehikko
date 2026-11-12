import type { ModuleCondition } from 'kehikot-module-protocol'

import type { Presence } from './registry.ts'

/**
 * What a condition dot means, in words, and what a row may do about it.
 *
 * The dot is drawn in `canvas/Conditions.tsx` (`ConditionDot`) and on a row of
 * the Kehikko modules menu. This file holds the rules so they can be read and
 * tested without a DOM: which state a module is in, the sentence for it (the
 * tooltip and the aria-label), and the one colour and shape it is drawn with.
 *
 * ## Never colour alone
 *
 * Every state has a sentence, and the ones that share a colour have a different
 * shape: green is only ever "Running"; grey is the states that are not running
 * (a ring for asleep, a square for stopped or not running, a dashed ring for
 * not installed, a pulsing dot for on its way); amber is the one that needs a
 * person (a diamond).
 *
 * ## Stop and Start
 *
 * Stop is for a module that is running AND started by this host, which holds
 * its child. It stops that child by its handle, as Restart does, and nothing
 * else. A module started outside Kehikot gets the same row, disabled, with the
 * reason. A module that is not running gets Start. Both are a person's press on
 * the page: the routes are page-only and there is no tool for either.
 */

export type RunState =
  | 'running'
  | 'starting'
  | 'asleep'
  | 'stopped'
  | 'not-running'
  | 'not-answering'
  | 'not-installed'

export type RunShape = 'disc' | 'ring' | 'square' | 'diamond' | 'dashed'

export interface RunLook {
  state: RunState
  /** The word for the tooltip and the aria-label. */
  label: string
  /** Tailwind classes: colour and, for the ones that pulse, the pulse. */
  colour: string
  shape: RunShape
}

export const RUN_LABELS: Record<RunState, string> = {
  running: 'Running',
  starting: 'Starting…',
  asleep: 'Asleep: starts when a kehikko uses it',
  stopped: 'Stopped: press Start to run it',
  'not-running': 'Not running',
  'not-answering': 'Not answering',
  'not-installed': 'Not installed',
}

const COLOURS: Record<RunState, string> = {
  running: 'bg-emerald-400 border-emerald-400',
  starting: 'bg-neutral-400 border-neutral-400 animate-pulse',
  asleep: 'border-neutral-500',
  stopped: 'bg-neutral-500 border-neutral-500',
  'not-running': 'bg-neutral-500 border-neutral-500',
  'not-answering': 'bg-amber-400 border-amber-400',
  'not-installed': 'border-muted-foreground/60',
}

const SHAPES: Record<RunState, RunShape> = {
  running: 'disc',
  starting: 'disc',
  asleep: 'ring',
  stopped: 'square',
  'not-running': 'square',
  'not-answering': 'diamond',
  'not-installed': 'dashed',
}

export function lookOf(state: RunState): RunLook {
  return { state, label: RUN_LABELS[state], colour: COLOURS[state], shape: SHAPES[state] }
}

/** What the dot needs of a module: the condition, what the host is doing, and what it knows about the address. */
export interface DotFacts {
  condition: ModuleCondition
  lifecycle?: Presence['lifecycle'] | 'loading'
  /** Something at all answered at the address. */
  reached?: boolean
  /** A person stopped it and has not pressed Start since. */
  stopped?: boolean
}

/**
 * The state a module is in.
 *
 * `ready` is running. Silent with a word from the host is that word (asleep, or on its way). Silent
 * and something answers is not answering: the address is held by something that is not the module.
 * `incompatible` is not answering too, said by the host's line. Plain silent is not running.
 */
export function runStateOf(facts: DotFacts): RunState {
  if (facts.condition === 'ready') return 'running'
  if (facts.lifecycle === 'asleep') return 'asleep'
  if (facts.lifecycle) return 'starting'
  if (facts.stopped) return 'stopped'
  if (facts.condition === 'incompatible' || facts.reached) return 'not-answering'
  return 'not-running'
}

export function dotOf(facts: DotFacts): RunLook {
  return lookOf(runStateOf(facts))
}

/** The dot of a presence. */
export function dotOfPresence(presence: Pick<Presence, 'condition' | 'lifecycle' | 'reached' | 'stopped'>): RunLook {
  return dotOf({ condition: presence.condition, lifecycle: presence.lifecycle, reached: presence.reached, stopped: presence.stopped })
}

export const STOP_LABEL = 'Stop'
export const START_LABEL = 'Start'

/** Said on the row of a module this host did not start. Also the server's sentence. */
export const STARTED_OUTSIDE_STOP = 'Started outside Kehikot: stop it where it runs'

export type RunControl =
  | { kind: 'stop' }
  | { kind: 'stop-disabled'; why: string }
  | { kind: 'start' }
  | null

/**
 * What the row offers, from what the sweep said of the module.
 *
 * `run` is set only while this host holds the module's process, so that is the one that can be
 * stopped (and a start still coming up is stopped the same way). Something answering that this
 * host does not hold is somebody else's. Nothing answering and a directory to start from: Start.
 * No directory and nothing answering: nothing to offer. The server judges again at the press.
 */
export function runControl(presence: Pick<Presence, 'run' | 'dir' | 'reached' | 'condition'>): RunControl {
  if (presence.run !== undefined) return { kind: 'stop' }
  const answering = presence.reached ?? presence.condition !== 'silent'
  if (answering) return { kind: 'stop-disabled', why: STARTED_OUTSIDE_STOP }
  if (presence.dir === undefined) return null
  return { kind: 'start' }
}

export type StopAnswer = { ok: true } | { ok: false; why: string }

async function post(route: string, id: string): Promise<StopAnswer> {
  const response = await fetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ module: id }),
  })
  const body = (await response.json().catch(() => null)) as { ok?: boolean; why?: string } | null
  if (body?.ok) return { ok: true }
  return { ok: false, why: typeof body?.why === 'string' ? body.why : 'Kehikot did not say why' }
}

/** `POST /host/stop-module`: stops only the child the host holds. */
export const askStop = (id: string) => post('/host/stop-module', id)

/** `POST /host/start`: the same Start every container has. It clears "stopped". */
export const askStart = (id: string) => post('/host/start', id)
