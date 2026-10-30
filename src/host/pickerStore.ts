import { useSyncExternalStore } from 'react'

import {
  DEFAULT_SORTS,
  NO_VISITS,
  epicVisitKey,
  kehikkoVisitKey,
  projectVisitKey,
  sortsFrom,
  type Picker,
  type PickerSort,
  type PickerSorts,
  type Visit,
  type Visits,
} from './pickerOrder.ts'
import { forgetRead } from './hostRead.ts'

/**
 * The page's one copy of how the pickers are ordered and when places were last
 * visited, so the three pickers, every window and the thing that records a
 * visit all see the same. The host keeps the truth (`server/pickerOrder.ts`);
 * this is what it last said. Nothing here is written to the browser.
 */

let sorts: PickerSorts = DEFAULT_SORTS
let visits: Visits = NO_VISITS
const listeners = new Set<() => void>()
const tell = () => {
  for (const one of [...listeners]) one()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export const sortsNow = (): PickerSorts => sorts
export const visitsNow = (): Visits => visits
export const usePickerSort = (picker: Picker): PickerSort => useSyncExternalStore(subscribe, () => sorts[picker], () => sorts[picker])
export const useVisits = (): Visits => useSyncExternalStore(subscribe, visitsNow, visitsNow)

/** The settings answer's choices, kept; an older host that says none leaves the defaults. */
export function adoptSorts(stored: unknown): void {
  if (stored === undefined) return
  sorts = sortsFrom(stored)
  tell()
}

function adoptVisits(stored: unknown): void {
  if (typeof stored !== 'object' || stored === null) return
  const one = (v: unknown): Record<string, number> => {
    const out: Record<string, number> = {}
    if (typeof v === 'object' && v !== null) for (const [key, at] of Object.entries(v)) if (typeof at === 'number') out[key] = at
    return out
  }
  const s = stored as Record<string, unknown>
  visits = { projects: one(s.projects), epics: one(s.epics), kehikot: one(s.kehikot) }
  tell()
}

/** Reads when each place was last visited. A host that cannot say leaves what is held. */
export async function loadVisits(): Promise<void> {
  try {
    const response = await globalThis.fetch('/host/visits', { cache: 'no-store' })
    const body = (await response.json()) as { ok?: boolean; visits?: unknown }
    if (response.ok && body.ok) adoptVisits(body.visits)
  } catch {
    /* Ordering is a convenience: with no answer the lists order by name. */
  }
}

/**
 * Change one picker's order. The copy changes at once so the switch answers the
 * press; if the host does not take it, the copy goes back and the error is thrown.
 */
export async function setSort(picker: Picker, sort: PickerSort): Promise<void> {
  const was = sorts
  sorts = { ...sorts, [picker]: sort }
  tell()
  try {
    const response = await globalThis.fetch('/host/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ picker: { [picker]: sort } }),
    })
    const body = (await response.json().catch(() => null)) as { ok?: boolean; why?: string; picker?: unknown } | null
    if (!response.ok || !body?.ok) throw new Error(body?.why ?? 'The host did not take that change.')
    forgetRead('settings')
    adoptSorts(body.picker)
  } catch (error) {
    sorts = was
    tell()
    throw error
  }
}

/** Notes a visit: held at once, and told to the host, which stamps it with its own clock. */
export function noteVisit(visit: Visit, now = Date.now()): void {
  const stamp = (held: Readonly<Record<string, number>>, key: string) => ({ ...held, [key]: now })
  visits = {
    projects: stamp(visits.projects, projectVisitKey(visit.project)),
    epics: visit.epic !== undefined ? stamp(visits.epics, epicVisitKey(visit.project, visit.epic)) : visits.epics,
    kehikot: visit.kehikko !== undefined ? stamp(visits.kehikot, kehikkoVisitKey(visit.project, visit.kehikko)) : visits.kehikot,
  }
  tell()
  void globalThis
    .fetch('/host/visits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(visit) })
    .then((response) => response.json())
    .then((body: { ok?: boolean; visits?: unknown }) => {
      if (body.ok) adoptVisits(body.visits)
    })
    .catch(() => undefined)
}

/** For tests: back to a page that has heard nothing. */
export function resetPickerStore(): void {
  sorts = DEFAULT_SORTS
  visits = NO_VISITS
  tell()
}
