import { useCallback, useEffect, useState } from 'react'
import type { Wished } from '@/host/columns.ts'
import { noted, standing, type FoldMarks, type FoldNote } from '@/host/folds.ts'
import { arrangeNoted, arrangeStands, undoneTo, type ArrangeMark, type ArrangeNote } from '@/host/arrange.ts'

type Drawn<P> = { id: number; placements: readonly P[] } | null

/**
 * The marks on the open kehikko of what somebody other than the person did to
 * its arrangement, with what puts it back: who folded or unfolded which
 * containers (`host/folds.ts`), and what an agent's `arrange_modules` changed
 * (`host/arrange.ts`). The page's alone, never stored: a fact about one screen
 * at one time.
 *
 * Moved out of `App.tsx` as it was. `open` is the open kehikko as drawn: every
 * arrangement drawn is checked against both marks, so a press, a drag, a
 * removal or a switch of kehikko takes a mark with it and nothing has to
 * remember to clear it. Called where `open` is made, so that check runs where
 * it always ran among the page's effects.
 */
export function useAgentMarks<P extends Wished>(open: Drawn<P>) {
  /**
   * Who folded or unfolded which containers on the open kehikko, when it was
   * not the person: an agent at the host's door, or a module asking with
   * `view.fold`. See `host/folds.ts`.
   */
  const [signed, setSigned] = useState<{ kehikko: number; marks: FoldMarks } | null>(null)
  /* What an agent's `arrange_modules` changed on the open kehikko, and what Undo puts back (`host/arrange.ts`). */
  const [arrangeMark, setArrangeMark] = useState<ArrangeMark | null>(null)

  /* A mark stands only while its container is as it was left — `standing` in
     `host/folds.ts`. Run against every arrangement drawn, so the person's
     press on the control, a drag, a removal or a switch of kehikko each take
     the mark with them and nothing has to remember to clear it. */
  useEffect(() => {
    setSigned((was) => {
      if (!was) return was
      if (!open || was.kehikko !== open.id) return null
      const kept = standing(was.marks, open.placements)
      if (kept === was.marks) return was
      return Object.keys(kept).length ? { kehikko: was.kehikko, marks: kept } : null
    })
    /* An agent's arrangement mark stands only while the kehikko is exactly as it left it. */
    setArrangeMark((was) => (was && arrangeStands(was, open?.id ?? null, open?.placements ?? []) ? was : null))
  }, [open])

  /* A fold somebody other than the person made on `kehikko`, signed. */
  const noteFold = useCallback((kehikko: number, note: FoldNote) => {
    setSigned((was) => ({ kehikko, marks: noted(was?.kehikko === kehikko ? was.marks : {}, note) }))
  }, [])
  /* An agent's arrangement of `kehikko`, marked with Undo. */
  const noteArranged = useCallback((kehikko: number, note: ArrangeNote) => {
    setArrangeMark((was) => arrangeNoted(was, kehikko, note))
  }, [])
  const clearArranged = useCallback(() => setArrangeMark(null), [])
  /* Undo an agent's arrangement: the arrangement before, exactly — only while it still stands.
     The mark goes either way; what to put back is returned, `null` when nothing is. */
  const undoArranged = (): P[] | null => {
    const next = undoneTo(arrangeMark, open?.id ?? null, open?.placements ?? [])
    setArrangeMark(null)
    return next
  }

  return { signed, arrangeMark, noteFold, noteArranged, clearArranged, undoArranged }
}
