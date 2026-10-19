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

/** A project as the Inbox needs it: what a tagged item names (`path`) and what a person reads (`name`). */
export interface ProjectRef {
  id: number
  name: string
  path: string
}
const NO_PROJECTS: readonly ProjectRef[] = []

/** A folder as it is compared: without a trailing slash. */
const folder = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path)

/**
 * A tagged list (protocol 1.8.0) as one complete list per project: each item
 * under the project whose folder its `project` names — the open one when it
 * names none — without the field; every project in `before` (where the module
 * reported last time) that it names nothing in now gets `[]`. An item naming a
 * folder no project is in is counted in `unknown` and kept nowhere.
 */
export function byProject(
  list: readonly ActivityItem[],
  open: number | null,
  projects: readonly ProjectRef[],
  before: readonly number[] = [],
): { lists: Map<number, ActivityItem[]>; unknown: number } {
  const byFolder = new Map(projects.map((one) => [folder(one.path), one.id]))
  const lists = new Map<number, ActivityItem[]>()
  let unknown = 0
  for (const { project: path, ...item } of list) {
    const id = path === undefined ? open : (byFolder.get(folder(path)) ?? null)
    if (id === null) {
      unknown += 1
      continue
    }
    lists.set(id, [...(lists.get(id) ?? []), item])
  }
  for (const id of before) if (!lists.has(id)) lists.set(id, [])
  return { lists, unknown }
}

/** Another project's live entries, for the Inbox to show under that project's name. */
export interface Elsewhere {
  project: ProjectRef
  entries: readonly Entry[]
}

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
 * (the server decides what is news), unless its place is open on screen. An
 * entry of another project is told with that project's id.
 *
 * ## Every project, not only the open one
 *
 * Switching project used to silence the others: their wake-ups were dropped
 * and only the open project's record was read. Now every project's record is
 * held (`others`), read again whenever the server says it changed, and what
 * enters attention or done there is news like any other.
 *
 * A module whose things span projects (an agent session keeps running after
 * the person switches project) tags each item with its project's folder
 * (protocol 1.8.0, `ActivityItem.project`). Its list is then its complete list
 * across every project: each item is filed under the project it names, and a
 * project it reported to before and names nothing in now is told `[]`. The
 * answer says `projects: true`, which is how the module learns it may.
 */
export function useInbox(options: {
  project: number | null
  /** Every project the host knows, to file a tagged item under and to read the record of. */
  projects?: readonly ProjectRef[]
  alive: ReadonlySet<string> | null
  at: Where
  nameOf: (module: string) => string
  graceMs?: number
  notify?: (entry: Entry, project: number) => void
}) {
  const { project, alive, at, graceMs = DROP_GRACE_MS } = options
  const projects = options.projects ?? NO_PROJECTS
  const projectsRef = useRef(projects)
  projectsRef.current = projects
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

  /** What has been told as news, so a report's answer and a wake-up's read do not tell one thing twice. */
  const told = useRef(new Set<string>())
  const forward = useCallback((id: number, news: readonly Entry[]) => {
    for (const entry of news) {
      const said = `${id}\u0000${rowKey(entry)}\u0000${entry.state}\u0000${entry.entered}`
      if (told.current.has(said)) continue
      told.current.add(said)
      /* A place can only be open on screen in the open project. */
      if (id === projectRef.current && placeOpened(entry.place, atRef.current)) continue
      notifyRef.current?.(entry, id)
    }
  }, [])

  /** Read again: the server said something changed, or the stream reopened. Any project, not only the open one. */
  const refresh = useCallback(
    (id?: number, rev?: number | null) => {
      /* No id: the stream reopened, and anything may have changed anywhere. */
      const which = id === undefined ? [...new Set([...(projectRef.current === null ? [] : [projectRef.current]), ...projectsRef.current.map((one) => one.id)])] : [id]
      for (const one of which) {
        /* The news names the revision it is about; this page may hold it already. */
        if (rev != null && rev <= (snapsRef.current[one]?.rev ?? -1)) continue
        void fetchInbox(one).then((got) => {
          const was = snapsRef.current[one]
          if (!got || got.rev === was?.rev) return
          /* Another project's record has no report of this page's behind it to say what is news:
             what entered attention or done since the last read is. The first read is not news. */
          if (one !== projectRef.current && was) {
            const before = new Map(was.open.map((entry) => [rowKey(entry), entry]))
            forward(
              one,
              got.open.filter((entry) => {
                if (entry.state === 'working' || !isLive(entry)) return false
                const prior = before.get(rowKey(entry))
                return !prior || prior.state !== entry.state || prior.entered !== entry.entered
              }),
            )
          }
          adopt(one, got)
        })
      }
    },
    [adopt, forward],
  )

  /* Every project's record, read once each project is known: what is going on elsewhere is the point. */
  const known = projects.map((one) => one.id).join(',')
  useEffect(() => {
    let cancelled = false
    for (const one of projectsRef.current) {
      if (one.id === projectRef.current || snapsRef.current[one.id]) continue
      void fetchInbox(one.id).then((got) => {
        if (!cancelled && !snapsRef.current[one.id]) adopt(one.id, got)
      })
    }
    return () => {
      cancelled = true
    }
  }, [known, adopt])

  /** One module's complete list for one project: marked now, posted, and the server's answer adopted. */
  const reportTo = useCallback(
    (id: number, from: string, list: ActivityItem[]) => {
      const key = `${id}\u0000${from}`
      const json = JSON.stringify(list)
      if (sent.current.get(key) === json) return
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
          forward(id, got.news)
          adopt(id, got)
        },
      )
    },
    [adopt, forward, queue, setSnap],
  )

  /**
   * `activity.set` from one module. A list with no `project` on any item is the
   * open project's, and is declined, with the reason, when none is open. One
   * that tags its items is filed by project (see the top).
   */
  const receive = useCallback(
    (from: string, list: ActivityItem[]) => {
      const open = projectRef.current
      if (!list.some((item) => item.project !== undefined)) {
        if (open === null) {
          return { outcome: 'declined' as const, taken: 0, why: 'No project is open, so there is nothing for this to be about.', projects: true }
        }
        reportTo(open, from, list)
        return { outcome: 'taken' as const, taken: list.length, why: '', projects: true }
      }
      const before = [...sent.current.keys()].flatMap((key) => {
        const [id, module] = key.split('\u0000')
        return module === from ? [Number(id)] : []
      })
      const { lists, unknown } = byProject(list, open, projectsRef.current, before)
      for (const [id, items] of lists) reportTo(id, from, items)
      const taken = list.length - unknown
      return {
        outcome: 'taken' as const,
        taken,
        why: unknown ? `${unknown} of these name a project this host does not know, and were not kept.` : '',
        projects: true,
      }
    },
    [reportTo],
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
      /** Another project's record; the open one's when absent. */
      inProject?: number,
    ) => {
      const id = inProject ?? projectRef.current
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

  const see = useCallback((entries: readonly Entry[], inProject?: number) => {
    const fresh = entries.filter((one) => one.state === 'done' && !isSeen(one))
    if (fresh.length) act('seen', fresh.map((one) => ({ module: one.module, id: one.id })), null, inProject)
  }, [act])
  const dismiss = useCallback(
    (entries: readonly Entry[], inProject?: number) => {
      if (entries.length) act('dismiss', entries.map((one) => ({ module: one.module, id: one.id })), null, inProject)
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

  /* The other projects' live entries, each under its project; the ones with nothing live are left out. */
  const others = useMemo<readonly Elsewhere[]>(
    () =>
      projects
        .filter((one) => one.id !== project)
        .map((one) => ({ project: one, entries: (snaps[one.id]?.open ?? NONE).filter(isLive) }))
        .filter((one) => one.entries.length > 0),
    [projects, project, snaps],
  )

  return { open, live, others, rev, earlier, receive, notice, see, dismiss, act, refresh }
}
