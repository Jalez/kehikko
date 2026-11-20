import { useCallback, useRef, useState } from 'react'
import type { Canvas } from '@/host/canvases.ts'
import type { Project } from '@/host/projects.ts'
import type { Subjects } from '@/host/subject.ts'

/**
 * What the page is showing, as state: every kehikko of every project, which
 * one is open, the projects and which one is open, and what each project is
 * about. Moved out of the top of `App.tsx` as it was; it runs no effect, so
 * the page's log line for a switch (`decide('switch', …)`) stays where it was.
 *
 * `setOpenId` is the one way the open kehikko changes, because the kehikko
 * being left is looked at first (`leavingRef`, assigned by the calm switch far
 * down the page). `setOpenIdNow` is the raw setter, for the one updater that
 * must not touch the page (a kehikko deleted is not faded out).
 */
export function usePageState() {
  const [canvases, setCanvases] = useState<Canvas[]>([])
  const canvasesRef = useRef(canvases)
  canvasesRef.current = canvases
  const [openId, setOpenIdNow] = useState<number | null>(null)
  const openIdRef = useRef(openId)
  openIdRef.current = openId
  /*
   * Which kehikko is open, changed — always through here, because the kehikko
   * being left has to be looked at BEFORE it is gone: `leaving` keeps a still
   * copy of it on screen and holds its pages where they are while the next one
   * is drawn out of sight. See `canvas/useCalmSwitch.ts`. Through a ref because
   * the switch is set up far below, beside the pages it holds.
   */
  const leavingRef = useRef<() => void>(() => undefined)
  const setOpenId = useCallback((next: number | null | ((was: number | null) => number | null)) => {
    const value = typeof next === 'function' ? next(openIdRef.current) : next
    if (value !== openIdRef.current) leavingRef.current()
    openIdRef.current = value
    setOpenIdNow(value)
  }, [])
  /**
   * The projects, and which one is open.
   *
   * Every canvas from every project is held in `canvases`; this is what the
   * header shows a slice of. Keeping the whole set is what makes switching
   * project free — see `fetchCanvases`, and `Frames.tsx` on why a module's page
   * must outlive the container that asked for it.
   */
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<number | null>(null)
  /**
   * What each project is about — its epic and the refs picked out of it — by
   * project id. Beside the projects and NOT inside the kehikot: the kehikko is
   * a layout and switching it must not move the epic. See `host/subject.ts`.
   */
  const [subjects, setSubjects] = useState<Subjects>({})

  return {
    canvases,
    setCanvases,
    canvasesRef,
    openId,
    setOpenId,
    setOpenIdNow,
    leavingRef,
    projects,
    setProjects,
    projectId,
    setProjectId,
    subjects,
    setSubjects,
  }
}
