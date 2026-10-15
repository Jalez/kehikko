import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityItem } from 'kehikot-module-protocol'

import {
  counted,
  dropped,
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
) {
  const [held, setHeld] = useState<Held>({})
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
    setHeld((was) => replaced(was, id, from, list, Date.now()))
    return { outcome: 'taken' as const, taken: list.length, why: '' }
  }, [])

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
    const out = (was: Held) => dropped(was, (module) => alive.has(module))
    if (graceMs <= 0) {
      setHeld(out)
      return
    }
    const timer = setTimeout(() => setHeld(out), graceMs)
    return () => clearTimeout(timer)
  }, [alive, graceMs])

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
