import { useCallback, useRef, useState } from 'react'

import { planGo, type GoStep, type Here, type Target } from '@/host/goToPlace.ts'
import type { Entry } from '@/host/inbox.ts'

/** What a move by `view.goto` answered: `moved`, or why it did not. */
export interface Moved {
  outcome: string
  why: string
}

export interface GoToPlaceDeps {
  /** Where the person is now. */
  here: Here
  /** What is known of a project: its kehikot (with the modules on them) and, when read, its epics. */
  targetOf(project: number): Target
  /** Open another project; the page calls `go` again for the entry once that project's epics are read. */
  switchProject(project: number, entry: Entry): void
  /** Open a kehikko of this project by its key, as its tab does. */
  openKehikko(key: string): void
  /** `view.goto`: the epic, its parts and (optionally) a kehikko, checked before anything changes. */
  goto(call: { epic: string; parts: string[]; kehikko?: string }): Moved
  /** Light a module's container on the open kehikko; `later` when the screen is still changing. */
  highlight(module: string, later: boolean): void
  /**
   * The host has come to the place of `entry` and its module's container is
   * on the open kehikko: the module is told which item (`kehikot.opened`).
   * `later` as for `highlight`. Not called when the plan stopped short.
   */
  arrived?(entry: Entry, later: boolean): void
}

/** A short line the page shows after a press; `n` makes the same words said twice a new line. */
export interface WentNote {
  text: string
  n: number
}

/**
 * Pressing an Inbox item (and Next, Alt+Shift+N): go to where it happened.
 * The decision is `planGo`; this carries it out with the page's own pickers'
 * functions and says, in `note`, where it stopped short.
 */
export function useGoToPlace(deps: GoToPlaceDeps) {
  const depsRef = useRef(deps)
  depsRef.current = deps
  const [note, setNote] = useState<WentNote | null>(null)
  const say = useCallback((text: string | null) => {
    setNote((was) => (text === null ? null : { text, n: (was?.n ?? 0) + 1 }))
  }, [])

  const go = useCallback(
    (entry: Entry, project: number) => {
      const d = depsRef.current
      const plan = planGo(entry, d.here, d.targetOf(project))
      const first = plan.steps[0]
      if (first?.kind === 'project') {
        /* The rest is planned again on arrival, against what is read there. */
        say(null)
        d.switchProject(first.project, entry)
        return
      }
      const of = <K extends GoStep['kind']>(kind: K) =>
        plan.steps.find((step): step is Extract<GoStep, { kind: K }> => step.kind === kind)
      const kehikko = of('kehikko')
      const epic = of('epic')
      const lit = of('highlight')
      if (epic) {
        const moved = d.goto({ epic: epic.epic, parts: epic.parts, ...(kehikko ? { kehikko: kehikko.key } : {}) })
        if (moved.outcome !== 'moved') {
          say([plan.note, moved.why].filter(Boolean).join(' ') || 'This notice could not be gone to.')
          return
        }
      } else if (kehikko) {
        d.openKehikko(kehikko.key)
      }
      if (lit) {
        d.highlight(lit.module, Boolean(kehikko || epic))
        d.arrived?.(entry, Boolean(kehikko || epic))
      }
      say(plan.note)
    },
    [say],
  )

  const clearNote = useCallback(() => say(null), [say])
  return { go, note, clearNote }
}
