import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityItem } from 'kehikot-module-protocol'

import {
  boundDerived,
  counted,
  deriveNotices,
  dropped,
  readDerived,
  writeDerived,
  replaced,
  readSeen,
  sawItems,
  visited,
  writeSeen,
  type Held,
  type HeldItem,
  type Seen,
  type Where,
} from '@/host/activity.ts'

const NONE: readonly HeldItem[] = []
const NO_SEEN: Seen = {}

/**
 * What the modules of the open project say they are doing, and which of the
 * finished ones the person has been told of. See `host/activity.ts`.
 *
 * `alive` is the set of modules whose container is on a kehikko of the project
 * AND whose server is answering; `null` while that is not known (nothing is
 * dropped then). A module outside it loses its list: a server that died must
 * not leave `working` standing.
 *
 * `at` is where the person is. A `done` item is seen when they ARRIVE at its
 * place — a change of epic, of picked parts or of kehikko — or press it; one
 * that arrives while its place is already open stays green until one of
 * those, so that a session finishing in front of them is still seen to finish.
 */
/** How long a module may be out of the live set before its list goes: a sweep that failed once is not a death. */
export const DROP_GRACE_MS = 6000

export function useActivity(
  project: number | null,
  alive: ReadonlySet<string> | null,
  at: Where,
  graceMs: number = DROP_GRACE_MS,
  /** Told once for each item that ENTERS attention or done, unless it is on screen. See `deriveNotices`. */
  notify?: (item: HeldItem) => void,
) {
  const [held, setHeldState] = useState<Held>({})
  const heldRef = useRef<Held>({})
  /** The only writer of `held`, so that a list can be compared with the one before it outside a render. */
  const setHeld = useCallback((change: (was: Held) => Held) => {
    heldRef.current = change(heldRef.current)
    setHeldState(heldRef.current)
  }, [])
  const notifyRef = useRef(notify)
  notifyRef.current = notify
  const atRef = useRef(at)
  atRef.current = at
  const loadedAt = useRef(Date.now())
  /** Modules that have sent a list since this page loaded, per project. */
  const greeted = useRef(new Set<string>())
  const derivedBy = useRef<Record<number, Record<string, number>>>({})
  const [seenBy, setSeenBy] = useState<Record<number, Seen>>({})
  const projectRef = useRef(project)
  projectRef.current = project

  const storage = typeof window === 'undefined' ? null : window.localStorage
  const seen = useMemo<Seen>(
    () => (project === null ? NO_SEEN : (seenBy[project] ?? readSeen(storage, project))),
    [project, seenBy, storage],
  )
  const seenRef = useRef(seen)
  seenRef.current = seen

  const items = useMemo<readonly HeldItem[]>(() => {
    if (project === null) return NONE
    const lists = held[project]
    return lists ? Object.values(lists).flat() : NONE
  }, [held, project])
  const itemsRef = useRef(items)
  itemsRef.current = items

  /** `activity.set` from one module. Declined, with the reason, when no project is open. */
  const receive = useCallback((from: string, list: ActivityItem[]) => {
    const id = projectRef.current
    if (id === null) {
      return { outcome: 'declined' as const, taken: 0, why: 'No project is open, so there is nothing for this to be about.' }
    }
    const now = Date.now()
    setHeld((was) => replaced(was, id, from, list, now))
    /* Derived from what is held (so `entered` is the host's), not from the list. */
    const mine = heldRef.current[id]?.[from] ?? []
    const baselineKey = `${id}\u0000${from}`
    const baseline = !greeted.current.has(baselineKey)
    greeted.current.add(baselineKey)
    const storage = typeof window === 'undefined' ? null : window.localStorage
    const known = derivedBy.current[id] ?? readDerived(storage, id)
    const out = deriveNotices(mine, known, atRef.current, baseline, loadedAt.current)
    if (out.derived !== known) {
      derivedBy.current[id] = boundDerived(out.derived)
      writeDerived(storage, id, derivedBy.current[id]!)
    }
    for (const item of out.fire) notifyRef.current?.(item)
    return { outcome: 'taken' as const, taken: list.length, why: '' }
  }, [setHeld])

  /* The updater is pure — a strict render runs it twice, and one that wrote
     storage would make its second run see its first run's work and decline. */
  const markSeen = useCallback((these: readonly HeldItem[]) => {
    const id = projectRef.current
    if (id === null) return
    setSeenBy((was) => {
      const base = was[id] ?? readSeen(window.localStorage, id)
      const next = sawItems(base, these)
      return next === base && was[id] !== undefined ? was : { ...was, [id]: next }
    })
  }, [])

  /* Remembered across a reload, per browser and project. */
  useEffect(() => {
    const kept = project === null ? undefined : seenBy[project]
    if (project !== null && kept) writeSeen(storage, project, kept)
  }, [project, seenBy, storage])

  /* A module's list goes once it has stayed out of `alive` for the grace: its
     server died, or its container went. */
  useEffect(() => {
    if (!alive) return
    const out = (was: Held) => {
      const next = dropped(was, (module) => alive.has(module))
      if (next !== was) {
        /* A module that comes back greets again: that list is a baseline, so a restart does not re-tell. */
        for (const [project, lists] of Object.entries(was)) {
          for (const module of Object.keys(lists)) {
            if (!alive.has(module)) greeted.current.delete(`${project}\u0000${module}`)
          }
        }
      }
      return next
    }
    if (graceMs <= 0) {
      setHeld(out)
      return
    }
    const timer = setTimeout(() => setHeld(out), graceMs)
    return () => clearTimeout(timer)
  }, [alive, graceMs, setHeld])

  /* Arriving. The first value is where the page opened, not an arrival. */
  const here = `${at.epic ?? ''}|${[...at.parts].sort().join(',')}|${at.kehikko ?? ''}`
  const was = useRef<string | null>(null)
  useEffect(() => {
    if (was.current === null) {
      was.current = here
      return
    }
    if (was.current === here) return
    was.current = here
    const arrived = visited(itemsRef.current, seenRef.current, at)
    if (arrived.length) markSeen(arrived)
    // `at` is read through `here`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here, markSeen])

  const live = useMemo(() => counted(items, seen), [items, seen])

  return { items, seen, live, receive, markSeen }
}
