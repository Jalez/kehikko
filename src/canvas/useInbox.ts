import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityItem } from 'kehikot-module-protocol'

import { clearStored, placeOpened, storedFor, type Where } from '@/host/activity.ts'
import {
  applyList,
  isLive,
  isOpen,
  isSeen,
  rowKey,
  type Entry,
  type NoticeLine,
} from '@/host/inbox.ts'
import {
  fetchInbox,
  postAct,
  postMigrate,
  postNotice,
  postReport,
  type Narrowing,
  type Snapshot,
} from '@/host/inboxClient.ts'

const NONE: readonly Entry[] = []

/**
 * How long a module may be out of the live set before what it had open
 * closes: a sweep that failed once is not a death.
 */
export const DROP_GRACE_MS = 6000

/**
 * The Inbox as the page holds it: a replica of the server's record of the
 * open project (`server/inbox.ts`), kept in step by posting each module's list
 * and by the server's word that something changed.
 *
 * What a module reports goes to the server, which owns the timeline (the same
 * pure `applyList` runs here for an immediate mark and there for the record).
 * What the server answers replaces what this page guessed. A person's seeing,
 * dismissing and forgetting go the same road.
 *
 * `alive` is the set of modules whose container is on a kehikko of the
 * project AND whose server is answering, or `null` while not known. A module
 * with open entries that stays outside it for the grace has them closed as
 * silent — a server that died must not leave `working` standing — and they
 * stay in the log.
 *
 * `at` is where the person is. A `done` item is seen when they ARRIVE at its
 * place (a change of epic, parts or kehikko) or press it; one that finishes
 * while its place is already open stays green until one of those.
 *
 * `notify` is told once for each entry that ENTERS attention or done as news
 * (the server decides what is news), unless its place is open on screen.
 */
export function useInbox(options: {
  project: number | null
  alive: ReadonlySet<string> | null
  at: Where
  nameOf: (module: string) => string
  graceMs?: number
  notify?: (entry: Entry) => void
}) {
  const { project, alive, at, graceMs = DROP_GRACE_MS } = options
  const [snaps, setSnaps] = useState<Record<number, Snapshot>>({})
  const snapsRef = useRef<Record<number, Snapshot>>({})
  const setSnap = useCallback((id: number, next: Snapshot | ((was: Snapshot | undefined) => Snapshot)) => {
    const value = typeof next === 'function' ? next(snapsRef.current[id]) : next
    snapsRef.current = { ...snapsRef.current, [id]: value }
    setSnaps(snapsRef.current)
  }, [])

  const projectRef = useRef(project)
  projectRef.current = project
  const atRef = useRef(at)
  atRef.current = at
  const nameRef = useRef(options.nameOf)
  nameRef.current = options.nameOf
  const notifyRef = useRef(options.notify)
  notifyRef.current = options.notify
  const loadedAt = useRef(Date.now())
  /** The last list sent for each (project, module), to send an identical one once. */
  const sent = useRef(new Map<string, string>())
  /** Posts out; a server answer replaces the page's guess only when none is waiting. */
  const waiting = useRef(0)
  const chain = useRef<Promise<unknown>>(Promise.resolve())

  const adopt = useCallback(
    (id: number, snap: Snapshot | null) => {
      if (!snap) return
      if (waiting.current > 0) return
      setSnap(id, snap)
    },
    [setSnap],
  )
  const queue = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    waiting.current += 1
    const run = chain.current.then(work, work)
    chain.current = run.then(
      () => undefined,
      () => undefined,
    )
    return run.finally(() => {
      waiting.current -= 1
    })
  }, [])

  const open = useMemo<readonly Entry[]>(() => (project === null ? NONE : (snaps[project]?.open ?? NONE)), [project, snaps])
  const openRef = useRef(open)
  openRef.current = open
  const rev = project === null ? 0 : (snaps[project]?.rev ?? 0)
  const earlier = project === null ? 0 : (snaps[project]?.earlier ?? 0)

  /* Read on a project switch; the storage of the page before the Inbox is
     handed over once and then removed. */
  useEffect(() => {
    if (project === null) return
    let cancelled = false
    void (async () => {
      const stored = storedFor(typeof window === 'undefined' ? null : window.localStorage, project)
      if (stored) {
        const done = await postMigrate(project, stored.seen, stored.told)
        if (done) clearStored(window.localStorage, project)
        if (!cancelled && done) adopt(project, done)
      }
      const got = await fetchInbox(project)
      if (!cancelled) adopt(project, got)
    })()
    return () => {
      cancelled = true
    }
  }, [project, adopt])

  /** Read again: the server said something changed, or the stream reopened. */
  const refresh = useCallback(
    (id?: number) => {
      const which = id ?? projectRef.current
      if (which === null || which !== projectRef.current) return
      void fetchInbox(which).then((got) => {
        if (got && got.rev !== snapsRef.current[which]?.rev) adopt(which, got)
      })
    },
    [adopt],
  )

  const forward = useCallback((news: readonly Entry[]) => {
    for (const entry of news) {
      if (placeOpened(entry.place, atRef.current)) continue
      notifyRef.current?.(entry)
    }
  }, [])

  /** `activity.set` from one module. Declined, with the reason, when no project is open. */
  const receive = useCallback(
    (from: string, list: ActivityItem[]) => {
      const id = projectRef.current
      if (id === null) {
        return { outcome: 'declined' as const, taken: 0, why: 'No project is open, so there is nothing for this to be about.' }
      }
      const key = `${id}\u0000${from}`
      const json = JSON.stringify(list)
      if (sent.current.get(key) === json) return { outcome: 'taken' as const, taken: list.length, why: '' }
      sent.current.set(key, json)
      const name = nameRef.current(from)
      /* Marked now by the same rule the server applies; replaced by its answer. */
      const now = Date.now()
      setSnap(id, (was) => {
        const base = was ?? { rev: 0, open: [], earlier: 0 }
        const mine = base.open.filter((one) => one.module === from)
        const applied = applyList(mine, from, name, list, { now, loadedAt: loadedAt.current })
        const rest = base.open.filter((one) => one.module !== from)
        return { rev: base.rev, earlier: base.earlier, open: [...rest, ...applied.puts.filter((one) => one.closed === null)] }
      })
      void queue(() => postReport({ project: id, module: from, name, items: list, loadedAt: loadedAt.current })).then(
        (got) => {
          if (!got) {
            sent.current.delete(key)
            return
          }
          forward(got.news)
          adopt(id, got)
        },
      )
      return { outcome: 'taken' as const, taken: list.length, why: '' }
    },
    [adopt, forward, queue, setSnap],
  )

  /** One legacy `kehikot.notifications@1` line, kept as an entry born closed. */
  const notice = useCallback(
    (from: string, line: NoticeLine, kehikko?: string) => {
      const id = projectRef.current
      if (id === null) return
      void queue(() =>
        postNotice({ project: id, module: from, name: nameRef.current(from), line, ...(kehikko ? { kehikko } : {}) }),
      ).then((got) => adopt(id, got))
    },
    [adopt, queue],
  )

  const act = useCallback(
    (
      what: 'seen' | 'dismiss' | 'forget' | 'seen-all',
      keys: readonly { module: string; id: string }[] | undefined,
      narrowing?: Narrowing | null,
    ) => {
      const id = projectRef.current
      if (id === null) return
      /* The guess, so the dot goes at once. */
      if (keys && (what === 'seen' || what === 'dismiss')) {
        const named = new Set(keys.map(rowKey))
        setSnap(id, (was) => {
          const base = was ?? { rev: 0, open: [], earlier: 0 }
          return {
            rev: base.rev,
            earlier: base.earlier,
            open: base.open.map((one) =>
              !named.has(rowKey(one))
                ? one
                : what === 'seen' && one.state === 'done'
                  ? { ...one, seen: one.entered }
                  : what === 'dismiss' && one.state !== 'working'
                    ? { ...one, dismissed: one.entered }
                    : one,
            ),
          }
        })
      }
      void queue(() => postAct({ project: id, do: what, ...(keys ? { keys } : {}), narrowing: narrowing ?? null })).then((got) =>
        adopt(id, got),
      )
    },
    [adopt, queue, setSnap],
  )

  const see = useCallback((entries: readonly Entry[]) => {
    const fresh = entries.filter((one) => one.state === 'done' && !isSeen(one))
    if (fresh.length) act('seen', fresh.map((one) => ({ module: one.module, id: one.id })))
  }, [act])
  const dismiss = useCallback(
    (entries: readonly Entry[]) => {
      if (entries.length) act('dismiss', entries.map((one) => ({ module: one.module, id: one.id })))
    },
    [act],
  )

  /* What a module that stopped answering had open is closed, after the grace. */
  const modules = useMemo(
    () => [...new Set(open.filter(isOpen).map((one) => one.module))].sort().join('\u0001'),
    [open],
  )
  useEffect(() => {
    const id = project
    if (!alive || id === null || !modules) return
    const gone = modules.split('\u0001').filter((module) => !alive.has(module))
    if (!gone.length) return
    const close = () => {
      for (const module of gone) {
        sent.current.delete(`${id}\u0000${module}`)
        setSnap(id, (was) => {
          const base = was ?? { rev: 0, open: [], earlier: 0 }
          return { rev: base.rev, earlier: base.earlier, open: base.open.filter((one) => one.module !== module) }
        })
        void queue(() =>
          postReport({ project: id, module, name: nameRef.current(module), items: [], silent: true, loadedAt: loadedAt.current }),
        ).then((got) => adopt(id, got))
      }
    }
    if (graceMs <= 0) {
      close()
      return
    }
    const timer = setTimeout(close, graceMs)
    return () => clearTimeout(timer)
  }, [alive, modules, project, graceMs, adopt, queue, setSnap])

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
    const arrived = openRef.current.filter(
      (one) => one.state === 'done' && !isSeen(one) && placeOpened(one.place, atRef.current),
    )
    if (arrived.length) see(arrived)
  }, [here, see])

  const live = useMemo(() => open.filter(isLive), [open])

  return { open, live, rev, earlier, receive, notice, see, dismiss, act, refresh }
}
