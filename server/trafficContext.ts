import { AsyncLocalStorage } from 'node:async_hooks'

import { LIMITS } from 'kehikot-module-protocol'

/**
 * The reason the code running now was given (`because`), and whether it is traffic's own plumbing
 * (`untraced`), across awaits (`AsyncLocalStorage`); and the reason each program this host started
 * runs for. The record (`traffic.ts`), the caller lookup (`callers.ts`) and the sampler
 * (`trafficProcesses.ts`) all read it, so it is its own file and imports none of them.
 */

interface Context {
  reason: string | null
  /** True inside `untraced`: the plumbing of traffic itself, which is not recorded. */
  quiet: boolean
}

const context = new AsyncLocalStorage<Context>()

/** Run `work` with every call made inside it filed under `reason`. The innermost reason wins. */
export function because<T>(reason: string, work: () => T): T {
  return context.run({ reason: reason.trim().slice(0, LIMITS.TRAFFIC_REASON) || null, quiet: context.getStore()?.quiet ?? false }, work)
}

/** Run `work` without recording what it calls: reading and noting traffic would otherwise fill the record with itself. */
export function untraced<T>(work: () => T): T {
  return context.run({ reason: context.getStore()?.reason ?? null, quiet: true }, work)
}

/** The reason the code running now was given, or null. */
export const reasonNow = (): string | null => context.getStore()?.reason ?? null

/**
 * The reason each program this host started was started for, by pid, while it runs: a connection the
 * sampler sees on that program (`trafficProcesses.ts`) is filed under it, not as "no reason given".
 */
const spawned = new Map<number, string>()
/** Why the program with this pid was started by this host, while it runs; null when it was not, or said nothing. */
export const spawnedFor = (pid: number): string | null => spawned.get(pid) ?? null
/** True inside `untraced`. */
export const quietNow = (): boolean => context.getStore()?.quiet === true
/** File the program this host just started with this pid under `reason`, while it runs. */
export const rememberSpawned = (pid: number, reason: string): void => void spawned.set(pid, reason)
/** The program with this pid has exited. */
export const forgetSpawned = (pid: number): void => void spawned.delete(pid)
