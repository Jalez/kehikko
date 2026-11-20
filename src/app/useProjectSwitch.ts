import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { nodeAt } from 'kehikot-module-protocol'
import type { GotoAnswer, GotoCall } from '@/host/ask.ts'
import { answerPress, inProject, type Canvas, type JumpOrder } from '@/host/canvases.ts'
import type { Entry } from '@/host/inbox.ts'
import type { useInbox } from '@/canvas/useInbox.ts'
import { JUMP_SIGNED, markAfter, markStands, offerAsk, planJump as planAgentJump, sameView, walkAll, walkersOf, walkSoon, type JumpMark as JumpMarkShape, type Place as ViewPlace, type Told } from '@/host/jump.ts'
import { ARRIVAL_WAIT_MS, NAVIGATE_SAYS, shownBy, type HeldShow } from '@/host/navigate.ts'
import type { Presses } from '@/host/presses.ts'
import type { Epics as HeldEpics, Project } from '@/host/projects.ts'
import { subjectOf, type SubjectEdit, type Subjects } from '@/host/subject.ts'
import type { SpaceNode } from 'kehikot-module-protocol'

export interface ProjectSwitchInputs {
  projectId: number | null
  openId: number | null
  /** The open kehikko as drawn: its key, for where the person is. */
  open: { key?: string } | null
  about: ReturnType<typeof subjectOf>
  held: HeldEpics | null
  spaceTree: readonly SpaceNode[]
  projects: readonly Project[]
  subjects: Subjects
  presses: Presses
  openRef: MutableRefObject<{ id: number; placements: readonly { i: string }[] } | null>
  canvasesRef: MutableRefObject<Canvas[]>
  projectRef: MutableRefObject<number | null>
  setOpenId: (next: number | null) => void
  onProject: (id: number) => void
  changeSubjectRef: MutableRefObject<(edit: SubjectEdit) => void>
  setSelectedByRef: MutableRefObject<Dispatch<SetStateAction<Record<number, string | null>>>>
  setShownTo: Dispatch<SetStateAction<HeldShow | null>>
  setTrouble: Dispatch<SetStateAction<string | null>>
  gotoHereRef: MutableRefObject<(call: GotoCall, from?: string) => GotoAnswer>
  walkStepRef: MutableRefObject<(target: { epic: string; step: number }, from: string) => void>
  jumpedRef: MutableRefObject<((order: JumpOrder) => void) | null>
  /**
   * What the page declares further down — the open project's kehikot and the Inbox — each read
   * when it is called, as the code read them when it lived in `App.tsx`.
   */
  later: {
    here: () => readonly Canvas[]
    inbox: () => Pick<ReturnType<typeof useInbox>, 'act'>
  }
}

/**
 * Going places: where the person is now (`placeNow`), going somewhere as the
 * person's own pickers go (`goPlace`, into another project with the calm
 * switch, then `gotoHere` within it, then the step walked), an agent's `jump`
 * and a taken offer made with it and marked with Go back, and Go back itself.
 *
 * Moved out of `App.tsx` as it was. It runs no effect of its own, so where it
 * is called changes no order; the effect that carries an agent's jump on once
 * the other project's epics are read stays in `App.tsx` beside its two
 * siblings, reading `agentArrival` from here.
 */
export function useProjectSwitch({
  projectId,
  openId,
  open,
  about,
  held,
  spaceTree,
  projects,
  subjects,
  presses,
  openRef,
  canvasesRef,
  projectRef,
  setOpenId,
  onProject,
  changeSubjectRef,
  setSelectedByRef,
  setShownTo,
  setTrouble,
  gotoHereRef,
  walkStepRef,
  jumpedRef,
  later,
}: ProjectSwitchInputs) {
  /**
   * An agent's jump of the view (`jump`), with where the person was, and the
   * step the open kehikko was last walked to. The page's alone; see
   * `host/jump.ts`.
   */
  const [jumpMark, setJumpMark] = useState<JumpMarkShape | null>(null)
  const jumpMarkRef = useRef(jumpMark)
  jumpMarkRef.current = jumpMark
  const standingStep = useRef<{ kehikko: number; epic: string; step: number } | null>(null)
  /* An agent's jump into another project, carried on once that project's epics are read there. */
  const agentArrival = useRef<{ project: number; cleared: boolean; timer: number; resolve(answer: GotoAnswer): void; apply(): GotoAnswer } | null>(null)

  /**
   * Where the person is now, as a jump moves it and Go back restores it. The
   * step is the last one the open kehikko was walked to on this epic. Through
   * a ref, so that a jump's later half — after a switch has arrived — reads
   * the screen as it is then. See `host/jump.ts`.
   */
  const placeNow: ViewPlace | null =
    projectId === null
      ? null
      : {
          project: projectId,
          kehikko: open?.key ?? null,
          epic: about.epic,
          ...(about.scope === 'project' ? { scope: 'project' as const } : {}),
          parts: [...about.parts],
          ...(about.space ? { space: [...about.space.ids] } : {}),
          step: standingStep.current && standingStep.current.kehikko === openId && standingStep.current.epic === about.epic ? standingStep.current.step : null,
        }
  const placeRef = useRef(placeNow)
  placeRef.current = placeNow

  /** The containers on the open kehikko, but `except`, walked to a step: a person's press on a step in a module that shows steps. */
  const turnHere = (target: { epic: string; step: number }, except?: string) => {
    const canvas = openRef.current
    if (!canvas) return Promise.resolve([])
    standingStep.current = { kehikko: canvas.id, epic: target.epic, step: target.step }
    return walkAll(presses, walkersOf(canvas.placements.map((placement) => placement.i), () => true, except), target)
  }
  /* A module's `view.goto { epic, step }` — a person's press on a step in a module
     that shows steps: their own step, so an agent's mark goes. */
  walkStepRef.current = (target, from) => {
    setJumpMark(null)
    void turnHere(target, from)
  }

  /** Whether the screen shows `target` (the step aside), polled while a switch settles. */
  const untilThere = async (target: ViewPlace, ms = ARRIVAL_WAIT_MS): Promise<ViewPlace | null> => {
    const until = Date.now() + ms
    for (;;) {
      const now = placeRef.current
      if (now && sameView({ ...target, kehikko: target.kehikko ?? now.kehikko }, now)) return now
      if (Date.now() > until) return null
      await new Promise((done) => window.setTimeout(done, 100))
    }
  }

  /**
   * Go to a place as the person's own pickers go: another project with the
   * calm switch (`onProject`), then the kehikko, epic and parts in it
   * (`gotoHere`, or "All epics"), then the step walked once the frames there
   * are up. Answers where it arrived and who was told of the step.
   */
  const goPlace = async (target: ViewPlace): Promise<{ ok: true; at: ViewPlace; told?: Told[] } | { ok: false; why: string }> => {
    const start = placeRef.current
    if (!start) return { ok: false, why: 'No project is open on this page, so nothing moved.' }
    const apply = (): GotoAnswer => {
      const now = placeRef.current
      if (now && sameView({ ...target, kehikko: target.kehikko ?? now.kehikko }, now)) return { outcome: 'moved', epic: now.epic, why: '' }
      if (target.scope === 'project' || target.epic === null) {
        const canvas = target.kehikko === null ? null : inProject(canvasesRef.current, target.project).find((one) => one.key === target.kehikko)
        if (canvas) setOpenId(canvas.id)
        changeSubjectRef.current(target.scope === 'project' ? { scope: 'project' } : { epic: null })
        return { outcome: 'moved', epic: null, why: '' }
      }
      return gotoHereRef.current({ epic: target.epic, parts: target.parts, ...(target.space ? { space: target.space } : {}), ...(target.kehikko !== null ? { kehikko: target.kehikko } : {}) })
    }
    let went: GotoAnswer
    if (target.project !== start.project) {
      went = await new Promise<GotoAnswer>((resolve) => {
        agentArrival.current?.resolve({ outcome: 'declined', epic: null, why: 'Another jump came first.' })
        const name = projects.find((one) => one.id === target.project)?.name ?? 'that project'
        const timer = window.setTimeout(() => {
          if (agentArrival.current?.timer !== timer) return
          agentArrival.current = null
          resolve({ outcome: 'declined', epic: null, why: NAVIGATE_SAYS.notArrived(name) })
        }, ARRIVAL_WAIT_MS)
        agentArrival.current = { project: target.project, cleared: false, timer, resolve, apply }
        onProject(target.project)
      })
    } else {
      went = apply()
    }
    if (went.outcome !== 'moved') return { ok: false, why: went.why || 'It did not move.' }
    const at = await untilThere(target)
    if (!at) return { ok: false, why: 'The view did not arrive there in time.' }
    if (target.step === null || target.epic === null) return { ok: true, at }
    const epic = target.epic
    const step = target.step
    const told = await walkSoon(
      presses,
      () => {
        const now = placeRef.current
        const canvas = openRef.current
        return now && canvas && sameView(now, at) ? canvas.placements.map((placement) => placement.i) : null
      },
      { epic, step },
    )
    const canvas = openRef.current
    if (canvas) standingStep.current = { kehikko: canvas.id, epic, step }
    return { ok: true, at: { ...at, step }, told }
  }

  /**
   * An agent's `jump`, made by this page: planned from where the person is
   * (`planJump` in `host/jump.ts`, which refuses what this page does not hold
   * and ignores a jump to where they already are), gone to as the person's
   * own pickers go, and marked with Go back. Answered like a press.
   */
  const jumpsMade = useRef<string[]>([])
  jumpedRef.current = (order) => {
    if (jumpsMade.current.includes(order.id)) return
    jumpsMade.current = [...jumpsMade.current.slice(-31), order.id]
    const before = placeRef.current
    if (!before) {
      void answerPress(order.id, { ok: false, why: 'No project is open on the page on screen.' })
      return
    }
    const plan = planAgentJump(order, before, {
      projects,
      kehikotOf: (project) => inProject(canvasesRef.current, project).flatMap((one) => (one.key ? [{ key: one.key, name: one.name }] : [])),
      subjectOf: (project) => subjectOf(subjects, project),
    })
    if (plan.kind !== 'go') {
      void answerPress(order.id, plan.kind === 'ignored' ? { ok: true, ignored: true, why: plan.why } : { ok: false, why: plan.why })
      return
    }
    void (async () => {
      const came = await goPlace(plan.target)
      if (!came.ok) {
        await answerPress(order.id, { ok: false, why: came.why })
        return
      }
      setJumpMark((was) => markAfter(was, before, came.at, order.title))
      await answerPress(order.id, { ok: true, why: '', ...(came.told ? { told: came.told } : {}) })
    })()
  }
  /**
   * An agent's offer, taken on the person's press (protocol 2.87.0, `go`): planned and gone to as the
   * agent's `jump` would have gone (`offerAsk`, `planJump`), marked with Go back, and closed as taken
   * — an offer is done once taken. Already there: taken, nothing moves. Refused or not arrived: the
   * offer stays, and the page says why.
   */
  const takeOfferRef = useRef<(entry: Entry, project: number) => void>(() => {})
  takeOfferRef.current = (entry, project) => {
    const before = placeRef.current
    if (!before) return
    const took = () => later.inbox().act('took', [{ module: entry.module, id: entry.id }], null, project)
    const plan = planAgentJump(offerAsk(entry, project, before.project), before, {
      projects,
      kehikotOf: (one) => inProject(canvasesRef.current, one).flatMap((c) => (c.key ? [{ key: c.key, name: c.name }] : [])),
      subjectOf: (one) => subjectOf(subjects, one),
    })
    if (plan.kind === 'ignored') {
      took()
      return
    }
    if (plan.kind === 'refused') {
      setTrouble(`That offer could not be taken: ${plan.why}`)
      return
    }
    void goPlace(plan.target).then((came) => {
      if (!came.ok) {
        setTrouble(`That offer could not be taken: ${came.why}`)
        return
      }
      setJumpMark((was) => ({ ...markAfter(was, before, came.at, entry.go?.title, entry.name || JUMP_SIGNED), offer: true }))
      took()
    })
  }
  /* Go back: the person's place, exactly — project, kehikko, epic, parts and step. Theirs, so not paced or marked. */
  const jumpBack = () => {
    const mark = jumpMarkRef.current
    setJumpMark(null)
    if (mark) void goPlace(mark.back)
  }
  const shownJumpMark = markStands(jumpMark, placeNow)

  /* The move within the open project: what `view.goto` always did, and what
     the Inbox's press uses. With a `show` (2.28.0), the show is handed to the
     kehikko the move ended on once it moved. */
  const gotoHere = ({ epic, parts, kehikko: key, show, space }: GotoCall & { space?: string[] }, from?: string): GotoAnswer => {
    const now = about.epic
    const row = held?.epics.find((one) => one.slug === epic)
    if (held === null) {
      return { outcome: 'declined', epic: now, why: "This project's epics are still being read. Ask again in a moment." }
    }
    if (!row) return { outcome: 'no-such-target', epic: now, why: `This project has no epic ${epic}.` }
    const known = new Set((row.parts ?? []).map((part) => part.id))
    const missing = (parts ?? []).filter((id) => !known.has(id))
    if (missing.length) {
      return { outcome: 'no-such-target', epic: now, why: `${epic} has no part ${missing.join(', ')}.` }
    }
    const canvas = key === undefined ? null : (later.here().find((one) => one.key === key) ?? null)
    if (key !== undefined && canvas === null) {
      return { outcome: 'no-such-target', epic: now, why: `This project has no kehikko ${key}.` }
    }
    /* A space deeper than a part (protocol 2.89.0): it must be in the tree, and it is where the project stands. */
    if (space && space[0] === epic && !nodeAt(spaceTree, space)) {
      return { outcome: 'no-such-target', epic: now, why: `This project has no space ${space.join('/')}.` }
    }
    if (canvas !== null) setOpenId(canvas.id)
    changeSubjectRef.current(
      space && space[0] === epic
        ? { space: { ids: space }, selection: [] }
        : { epic, selection: [], ...(parts ? { parts: [...new Set(parts)] } : {}) },
    )
    const id = projectRef.current
    if (id !== null) setSelectedByRef.current((was) => (was[id] === null ? was : { ...was, [id]: null }))
    const landed = canvas?.id ?? openId
    if (show && landed !== null) setShownTo({ kehikko: landed, show: shownBy(show, from, new Date()) })
    return { outcome: 'moved', epic, why: '' }
  }
  gotoHereRef.current = gotoHere

  return { placeNow, goPlace, gotoHere, agentArrival, shownJumpMark, jumpBack, setJumpMark, takeOfferRef }
}

/**
 * An agent's jump into another project, carried on once that project's epics
 * are read there: the same rule as the page's other arrivals (`goElsewhere`,
 * and a module's `view.goto`), and called in `App.tsx` between them, where it
 * always ran. The epics of the project left still stand for a render after the
 * switch; the read of the new one clears them (`cleared`), and its landing is
 * the arrival.
 */
export function useAgentArrival(
  agentArrival: ReturnType<typeof useProjectSwitch>['agentArrival'],
  projectId: number | null,
  held: HeldEpics | null,
) {
  useEffect(() => {
    const pending = agentArrival.current
    if (!pending || pending.project !== projectId) return
    if (held === null) {
      pending.cleared = true
      return
    }
    if (!pending.cleared) return
    agentArrival.current = null
    window.clearTimeout(pending.timer)
    pending.resolve(pending.apply())
  }, [projectId, held])
}
