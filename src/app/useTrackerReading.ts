import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ContentChange, Disposition } from 'kehikot-module-protocol'
import type { TrackerListing } from '@/host/trackerSources.ts'
import { fetchDispositions, fetchTracker, refreshTracker, type TrackerState } from '@/host/projects.ts'

/**
 * What the open project's trackers say, as the page holds it: the people's
 * marks on why refs closed (`context.dispositions`), the shared tracker
 * reading (`context.tracker` and the bar), and what changed in the material
 * kept for its epics (`context.content`).
 *
 * Moved out of `App.tsx` as it was: read on a project switch, read again when
 * the host's stream says so (`heard`, handed to `watchCanvases`), and asked of
 * the host by "Refresh all" and Settings › Trackers. Every answer is for the
 * project it was asked about, and one that lands after a switch is dropped —
 * `projectRef`, assigned on render as `App.tsx` assigns its own.
 */
export interface TrackerReading {
  marks: Disposition[]
  tracker: TrackerState
  rewritten: ContentChange[]
  /* "Refresh all". */
  onRefreshTrackers: () => void
  /* An edit in Settings › Trackers. */
  onTrackerListing: (project: number, listing: TrackerListing) => void
  /* The Trackers panel opened. */
  onTrackerOpen: () => void
  /* The host's stream, for the open project only: what `watchCanvases` calls back with. */
  heard: {
    marked: (project: number) => void
    read: (project: number, signal: { at: string | null; refreshing: boolean }) => void
    rewritten: (project: number, changes: ContentChange[]) => void
  }
}

export function useTrackerReading(projectId: number | null): TrackerReading {
  const projectRef = useRef<number | null>(projectId)
  projectRef.current = projectId
  /**
   * The open project's dispositions — people's marks on why refs closed — for
   * `context.dispositions`. Empty while they are read and when nobody has said
   * anything; a module cannot tell those apart and does not need to, since in
   * both it falls back to what its own tracker reading implies.
   */
  const [marks, setMarks] = useState<Disposition[]>([])
  /**
   * The open project's shared tracker reading, as the bar shows it and as
   * `context.tracker` carries it: when it last changed, whether a read is
   * running, and how each source fared. See `server/trackers/reading.ts`.
   */
  const [tracker, setTracker] = useState<TrackerState>({ at: null, refreshing: false, sources: [] })
  /**
   * What has changed in the material kept for the open project's epics, for
   * `context.content`. Empty until the server says something changed: a
   * module loads what it shows when its epic opens, and this is only ever the
   * reason to read it again. See `server/content.ts`.
   */
  const [rewritten, setRewritten] = useState<ContentChange[]>([])

  /* The open project's dispositions, re-read on a project switch. Cleared
     first: another project's marks on refs that happen to share a spelling
     would be verdicts about work this project does not have. */
  useEffect(() => {
    setMarks([])
    if (projectId === null) return
    const stop = new AbortController()
    void (async () => {
      try {
        const found = await fetchDispositions(projectId, stop.signal)
        if (!stop.signal.aborted) setMarks(found)
      } catch {
        /* No marks is what modules fall back from anyway. */
      }
    })()
    return () => stop.abort()
  }, [projectId])

  /* The open project's tracker reading, read on a project switch. Asking is
     what starts the project's first read — never the host's startup. */
  useEffect(() => {
    setTracker({ at: null, refreshing: false, sources: [] })
    /* Another project's changes are not this one's. Nothing is fetched in
       their place: every container reads its material afresh on the switch. */
    setRewritten([])
    if (projectId === null) return
    const stop = new AbortController()
    void (async () => {
      try {
        const found = await fetchTracker(projectId, stop.signal)
        if (!stop.signal.aborted) setTracker(found)
      } catch {
        /* Nothing read is what the context says by default. */
      }
    })()
    return () => stop.abort()
  }, [projectId])

  /* "Refresh all". The bar shows it running from the wake the server sends
     when the read starts, so this only has to ask; the answer is the outcome,
     and the sentence about any source that failed arrives with the re-read. */
  const onRefreshTrackers = useCallback(() => {
    const project = projectRef.current
    if (project === null) return
    setTracker((was) => ({ ...was, refreshing: true }))
    void refreshTracker(project)
      .catch(() => null)
      .then(async () => {
        try {
          const found = await fetchTracker(project)
          if (project === projectRef.current) setTracker(found)
        } catch {
          if (project === projectRef.current) setTracker((was) => ({ ...was, refreshing: false }))
        }
      })
  }, [])

  /* An edit in Settings › Trackers is kept by the page, not by the panel (which closing Settings unmounts). */
  const onTrackerListing = useCallback((project: number, listing: TrackerListing) => {
    if (project === projectRef.current) setTracker((was) => ({ ...was, project, listing }))
  }, [])
  /* The panel opened: read what the host holds, so the panel shows what is on disk. */
  const onTrackerOpen = useCallback(() => {
    const project = projectRef.current
    if (project === null) return
    void fetchTracker(project)
      .then((found) => project === projectRef.current && setTracker(found))
      .catch(() => undefined)
  }, [])

  const heard = useMemo<TrackerReading['heard']>(
    () => ({
      /* A mark changed — a module's press, or an agent at the door. Re-read
         and let the context carry it to every frame, for `epics`' reason only
         when it is this page's project. */
      marked: (project) => {
        if (project !== projectRef.current) return
        void (async () => {
          try {
            const found = await fetchDispositions(project)
            if (project === projectRef.current) setMarks(found)
          } catch {
            /* The marks the page has are the marks it had. */
          }
        })()
      },
      /* The project's tracker reading started or landed a read. The signal
         came with the news and goes straight into the context; when a read
         lands, the sources are re-read for the bar's sentence about them. */
      read: (project, signal) => {
        if (project !== projectRef.current) return
        setTracker((was) => ({ ...was, ...signal }))
        if (signal.refreshing) return
        void (async () => {
          try {
            const found = await fetchTracker(project)
            if (project === projectRef.current) setTracker(found)
          } catch {
            /* The bar keeps what it had. */
          }
        })()
      },
      /* Material kept for the project's epics changed. The list came with
         the news and goes straight into the context. */
      rewritten: (project, changes) => {
        if (project !== projectRef.current) return
        setRewritten(changes)
      },
    }),
    [],
  )

  return { marks, tracker, rewritten, onRefreshTrackers, onTrackerListing, onTrackerOpen, heard }
}
