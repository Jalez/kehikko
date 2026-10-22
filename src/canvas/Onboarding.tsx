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
  openLayouts,
  openTour,
  postOnboarding,
  type LayoutsMode,
  type Onboarding,
  type TourStart,
} from '@/host/onboarding.ts'
import { installOfficial } from '@/host/official.ts'
import { IntroDialog } from './Intro.tsx'
import { LayoutPicker, SaveLayoutDialog } from './Layouts.tsx'
import { runTour } from './Tour.ts'

/**
 * Everything a person meets on their way in: the introduction (shown by
 * itself once), the tour, the layout picker and "save as a layout". Each is
 * opened from anywhere by an event (`src/host/onboarding.ts`) — the "?" menu,
 * the kehikko menu, the empty canvas, the introduction's last step — and
 * held here, once, beside the rest of the app's windows.
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
  const open = () => root.querySelector('[role="dialog"], [role="alertdialog"]') !== null
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
}: {
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

  /* Once, at start: the introduction opens by itself when this one has not
     been seen — after any window already standing (Settings' one-time
     question) has been answered, never on top of it. */
  useEffect(() => {
    let alive = true
    let stop = () => {}
    void fetchOnboarding().then((got) => {
      if (!alive) return
      setState(got)
      if (!introDue(got)) return
      void settingsAsked().then((asked) => {
        if (!alive) return
        /* Settings' one-time question is about to stand: wait for it to
           appear (a moment at most) and then to be answered or closed. */
        stop = asked ? whenNoDialog(() => alive && setIntro(true)) : whenAppeared('[data-first-question]', () => {
          if (alive) stop = whenNoDialog(() => alive && setIntro(true))
        })
      })
    })
    return () => {
      alive = false
      stop()
    }
  }, [])

  const tour = useCallback((from: TourStart) => {
    const leftAt = from === 'resume' ? (stateRef.current?.tour.at ?? null) : null
    runTour({
      leftAt,
      onAt: (at) => void postOnboarding({ tour: { at } }).then((got) => got && setState(got)),
      onEnd: (finished, at) =>
        void postOnboarding({ tour: finished ? { at: null, finished: true } : { at } }).then((got) => got && setState(got)),
    })
  }, [])

  useEffect(() => {
    const off = [
      onOpenIntro(() => setIntro(true)),
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
        onLayouts={() => openLayouts(open && open.placements.length === 0 ? 'fill' : 'new')}
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
