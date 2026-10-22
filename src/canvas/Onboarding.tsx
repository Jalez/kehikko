import { useCallback, useEffect, useRef, useState } from 'react'

import { createCanvas, type Canvas, type Placement } from '@/host/canvases.ts'
import { placementsFor, type Available, type Layout } from '@/host/layouts.ts'
import {
  fetchOnboarding,
  introDue,
  onOpenIntro,
  onOpenLayouts,
  onOpenSaveLayout,
  onOpenTour,
  openTour,
  postOnboarding,
  underway,
  type LayoutsMode,
  type Onboarding,
  type OnboardingEdit,
  type TourStart,
} from '@/host/onboarding.ts'
import { installOfficial } from '@/host/official.ts'
import { EXPLORING, NO_FACTS, type Facts } from '@/host/tour.ts'
import { IntroDialog } from './Intro.tsx'
import { LayoutPicker, SaveLayoutDialog } from './Layouts.tsx'
import { Guide, type Drawer } from './Tour.ts'

/**
 * Everything a person meets on their way in: the introduction (shown by
 * itself once), the tour, the layout picker and "save as a layout". Each is
 * opened from anywhere by an event (`src/host/onboarding.ts`) — the "?" menu,
 * the kehikko menu, the empty canvas, the introduction's last slide — and
 * held here, once, beside the rest of the app's windows.
 *
 * The tour is a `Guide` (`Tour.ts`) held for the page's life, told the app's
 * facts whenever they change, and recording where it is through
 * `/host/onboarding`. A tour left running (the page reloaded part way) picks
 * up by itself; a paused one waits for Help → Continue tour.
 */

const INSTALL_POLL_MS = 1500

/** Has Settings' one-time question been answered? True when it cannot be told (an older host). */
async function settingsAsked(): Promise<boolean> {
  try {
    const response = await fetch('/host/settings', { cache: 'no-store' })
    if (!response.ok) return true
    const body = (await response.json()) as { settings?: { asked?: unknown } } | null
    return body?.settings?.asked !== false
  } catch {
    return true
  }
}

/** Call `then` once an element matching `selector` is in the page, or after `wait` ms whatever happens. */
export function whenAppeared(selector: string, then: () => void, wait = 3000, root: Document = document): () => void {
  let done = false
  const finish = () => {
    if (done) return
    done = true
    watch.disconnect()
    clearTimeout(timer)
    then()
  }
  const watch = new MutationObserver(() => root.querySelector(selector) && finish())
  const timer = setTimeout(finish, wait)
  if (root.querySelector(selector)) {
    queueMicrotask(finish)
  } else watch.observe(root.body, { childList: true, subtree: true })
  return () => {
    done = true
    watch.disconnect()
    clearTimeout(timer)
  }
}

/**
 * Call `then` once no dialog is open — at once when none is, else once the
 * last one has closed (and its closing animation has had a moment). Returns
 * the cancel.
 */
export function whenNoDialog(then: () => void, root: Document = document): () => void {
  /* The tour's popover is a dialog to driver.js and not a window to wait for. */
  const open = () => root.querySelector('[role="dialog"]:not(.driver-popover), [role="alertdialog"]') !== null
  if (!open()) {
    then()
    return () => {}
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const watch = new MutationObserver(() => {
    clearTimeout(timer)
    if (open()) return
    timer = setTimeout(() => {
      if (open()) return
      watch.disconnect()
      then()
    }, 250)
  })
  watch.observe(root.body, { childList: true, subtree: true })
  return () => {
    clearTimeout(timer)
    watch.disconnect()
  }
}

export function OnboardingHost({
  project,
  open,
  registered,
  onMade,
  onFill,
  onInstalled,
  facts = NO_FACTS,
  drawer,
  layout = true,
}: {
  /** What the tour's waiting steps wait for: a project open, an epic chosen, a kehikko made. */
  facts?: Facts
  /** How the tour is drawn; driver.js unless a test says otherwise. */
  drawer?: Drawer
  /** False where nothing is measured (a test). */
  layout?: boolean
  /** The open project, for its own layouts and for the new kehikko. */
  project: number | null
  /** The open kehikko: filled from the empty canvas, and the one saved as a layout. */
  open: Canvas | null
  /** What is registered here, id → name. */
  registered: ReadonlyMap<string, string>
  /** A kehikko was made from a layout: put it in the list and open it. */
  onMade(canvas: Canvas): void
  /** Put these containers on the open kehikko. */
  onFill(placements: Placement[]): void
  /** An install the picker started has finished: sweep the registry. */
  onInstalled(): void
}) {
  const [state, setState] = useState<Onboarding | null>(null)
  const [intro, setIntro] = useState(false)
  const [picker, setPicker] = useState<LayoutsMode | null>(null)
  const [saving, setSaving] = useState(false)
  const [installing, setInstalling] = useState<ReadonlySet<string>>(new Set())
  const stateRef = useRef(state)
  stateRef.current = state

  const factsRef = useRef(facts)
  factsRef.current = facts
  const remember = useCallback((edit: OnboardingEdit) => {
    void postOnboarding(edit).then((got) => got && setState(got))
  }, [])
  const guide = useRef<Guide | null>(null)
  const guideOf = useCallback((): Guide => {
    guide.current ??= new Guide({
      facts: () => factsRef.current,
      onStep: (step) => remember({ tour: { step } }),
      onPause: (step) => remember({ tour: { step, paused: true } }),
      onFinish: () => remember({ tour: { step: null, finished: true } }),
      drawer,
      layout,
    })
    return guide.current
  }, [drawer, layout, remember])
  useEffect(
    () => () => {
      guide.current?.stop()
      guide.current = null
    },
    [],
  )
  /* The facts moved — a project opened, an epic made: the tour looks again. */
  useEffect(() => {
    guide.current?.refresh()
  }, [facts.project, facts.projects, facts.epic, facts.parts, facts.kehikko])

  const tour = useCallback(
    (from: TourStart) => {
      const at = from === 'resume' ? (stateRef.current?.tour.step ?? null) : null
      guideOf().start(at)
    },
    [guideOf],
  )

  /* Once, at start: the introduction opens by itself when this one has not
     been seen — after any window already standing (Settings' one-time
     question) has been answered, never on top of it. A tour left running
     picks up the same way. */
  useEffect(() => {
    let alive = true
    let stop = () => {}
    void fetchOnboarding().then((got) => {
      if (!alive) return
      setState(got)
      stateRef.current = got
      const then = introDue(got) ? () => alive && setIntro(true) : underway(got) ? () => alive && tour('resume') : null
      if (!then) return
      void settingsAsked().then((asked) => {
        if (!alive) return
        /* Settings' one-time question is about to stand: wait for it to
           appear (a moment at most) and then to be answered or closed. */
        stop = asked ? whenNoDialog(then) : whenAppeared('[data-first-question]', () => {
          if (alive) stop = whenNoDialog(then)
        })
      })
    })
    return () => {
      alive = false
      stop()
    }
  }, [tour])

  useEffect(() => {
    const off = [
      onOpenIntro(() => {
        guide.current?.stop()
        setIntro(true)
      }),
      /* After whatever menu opened it has closed and given focus back. */
      onOpenTour((from) => setTimeout(() => tour(from), 0)),
      onOpenLayouts((mode) => setPicker(mode)),
      onOpenSaveLayout(() => setSaving(true)),
    ]
    return () => off.forEach((one) => one())
  }, [tour])

  /* While something the picker asked for is installing, the official list is
     read again until it is not, and then the registry is swept — the same
     rhythm as the modules list. */
  const told = useRef(onInstalled)
  told.current = onInstalled
  useEffect(() => {
    if (installing.size === 0) return
    let alive = true
    const timer = setInterval(() => {
      void fetch('/host/official', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { modules?: Array<{ id: string; installed: boolean; install?: { state: string } }> } | null) => {
          if (!alive || !body?.modules) return
          const still = body.modules.filter((one) => installing.has(one.id) && !one.installed && one.install?.state === 'installing')
          if (still.length === 0) {
            setInstalling(new Set())
            told.current()
          }
        })
        .catch(() => undefined)
    }, INSTALL_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [installing])

  const use = useCallback(
    async (layout: Layout, available: Available[], install: string[], name: string): Promise<string | null> => {
      /* Installed only on the press that named them: this one. */
      for (const id of install) {
        try {
          await installOfficial(id)
        } catch (error) {
          return (error as Error).message
        }
      }
      if (install.length) setInstalling(new Set(install))
      const placements = placementsFor(layout, available, new Set(install))
      if (picker === 'fill') {
        onFill(placements)
        return null
      }
      try {
        onMade(await createCanvas(name || undefined, project, placements))
        return null
      } catch (error) {
        return `The kehikko could not be made: ${(error as Error).message}.`
      }
    },
    [picker, project, onFill, onMade],
  )

  return (
    <>
      <IntroDialog
        open={intro}
        onOpenChange={(isOpen) => {
          setIntro(isOpen)
          if (!isOpen && (state === null || introDue(state))) void postOnboarding({ intro: 'seen' }).then((got) => got && setState(got))
        }}
        onTour={() => openTour('over')}
        onExplore={() => setTimeout(() => guideOf().point(EXPLORING), 0)}
      />
      <LayoutPicker
        open={picker !== null}
        mode={picker ?? 'new'}
        onOpenChange={(isOpen) => !isOpen && setPicker(null)}
        project={project}
        registered={registered}
        onUse={use}
      />
      <SaveLayoutDialog open={saving} onOpenChange={setSaving} kehikko={open} />
    </>
  )
}
