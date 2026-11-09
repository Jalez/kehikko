import { Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Help, Intro } from 'kehikot-module-protocol'

import { Button } from '@/components/ui/button.tsx'
import { fetchOfficial, installOfficial, type OfficialModule } from '@/host/official.ts'
import { fetchMine, installMine } from '@/host/myModules.ts'
import {
  addDisabled,
  addSaid,
  addStateOf,
  fetchIntro,
  introTitle,
  slidesOfHelp,
  slidesOfIntro,
  slidesOfSummary,
  type AddState,
  type ShownSlide,
} from '@/host/moduleIntro.ts'
import { IntroModal, type ModalSlide } from './IntroModal.tsx'
import { ModuleArt } from './ModuleArt.tsx'
import { ModuleIcon } from './ModuleIcon.tsx'

/**
 * A module's own introduction (protocol 2.57.0), in the app's introduction dialog (`IntroModal`):
 * the same frame, controls and look, the module's icon and name at the top.
 *
 * What it shows, first that there is: the module's introduction — from its running manifest, else
 * read by the server without running it (`fetchIntro`: the installed copy, or the release an install
 * would take) — else its "How to use" as slides, else the one line it says about itself.
 *
 * Opened from the "?" in the modules list, with "Add to this kehikko" in its footer on every slide
 * (`addable`): the picker's own add, or the list's own install followed by the add ("Install and
 * add", with the install's progress). From the Container menu and the offer on a container the
 * module is already placed, and there is no button.
 *
 * Every string is the module's and drawn as text.
 */

/** How often the list is read while an install from here is on its way: the modules list's own pace. */
export const INSTALL_POLL_MS = 1500

export interface Addable {
  /** A kehikko is open to add it to. */
  open: boolean
  placed: boolean
  registered: boolean
  onPlace(): void
  /** The registry is swept again: an install has just registered it. */
  onLookAgain?(): void
}

function asModal(slide: ShownSlide): ModalSlide {
  const art = slide.art
  return { id: slide.id, title: slide.title, body: slide.body, ...(slide.points ? { points: slide.points } : {}), ...(art ? { art: () => <ModuleArt art={art} /> } : {}) }
}

/** The list's entry for a module not installed here, read while the dialog is open; polled while it installs. */
function useListed(id: string, wanted: boolean, asked: number) {
  const [entry, setEntry] = useState<OfficialModule | null>(null)
  useEffect(() => {
    if (!wanted) return
    let alive = true
    void Promise.all([fetchOfficial().then((read) => read.modules).catch(() => []), fetchMine().then((read) => read?.modules ?? []).catch(() => [])]).then(
      ([official, mine]) => {
        if (alive) setEntry([...official, ...mine].find((one) => one.id === id) ?? null)
      },
    )
    return () => {
      alive = false
    }
  }, [id, wanted, asked])
  return entry
}

export function useAddFromIntro(id: string, addable: Addable | undefined): { state: AddState; refused: string | null; onAdd(): void } {
  const [asked, setAsked] = useState(0)
  const [refused, setRefused] = useState<string | null>(null)
  const [pressed, setPressed] = useState(false)
  const notRegistered = addable !== undefined && !addable.registered
  const entry = useListed(id, notRegistered, asked)
  const told = useRef(addable)
  told.current = addable

  const installing = entry?.install?.state === 'installing' ? entry.install.step : null
  const failed = entry?.install?.state === 'failed' ? entry.install.why : null

  /* Polled while the install is on its way; once it is installed, swept and placed — once. */
  useEffect(() => {
    if (!pressed || !entry) return
    if (entry.installed) {
      setPressed(false)
      told.current?.onLookAgain?.()
      told.current?.onPlace()
      return
    }
    if (failed !== null) {
      setPressed(false)
      setRefused(failed)
      return
    }
    const timer = setTimeout(() => setAsked((n) => n + 1), INSTALL_POLL_MS)
    return () => clearTimeout(timer)
  }, [pressed, entry, installing, failed])

  const state = addable
    ? addStateOf({
        open: addable.open,
        placed: addable.placed,
        registered: addable.registered || entry?.installed === true,
        listed: entry && !entry.installed ? { installing: installing ?? (pressed ? 'cloning' : null), newer: entry.newer ? { app: entry.newer.app ?? null } : null } : null,
      })
    : ({ kind: 'none' } as const)

  function onAdd() {
    const now = told.current
    if (!now) return
    setRefused(null)
    if (state.kind === 'add') {
      now.onPlace()
      return
    }
    if (state.kind !== 'install' || !entry) return
    setPressed(true)
    void (entry.mine ? installMine(id) : installOfficial(id))
      .catch((error: unknown) => {
        setPressed(false)
        setRefused((error as Error).message)
      })
      .finally(() => setAsked((n) => n + 1))
  }

  return { state, refused, onAdd }
}

export function ModuleIntroDialog({
  open,
  onOpenChange,
  id,
  name,
  icon,
  summary,
  intro: known,
  help,
  addable,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  id: string
  name: string
  /** The icon key a list entry carries, for a module not installed here. */
  icon?: string | null
  summary?: string | null
  /** What the running module's manifest says; absent or null: the server is asked. */
  intro?: Intro | null
  help?: Help | null
  /** Given: the add button in the footer. */
  addable?: Addable
}) {
  const [read, setRead] = useState<{ id: string; intro: Intro | null } | null>(null)
  useEffect(() => {
    if (!open || known) return
    const abort = new AbortController()
    void fetchIntro(id, abort.signal)
      .then((intro) => setRead({ id, intro }))
      .catch(() => setRead({ id, intro: null }))
    return () => abort.abort()
  }, [open, id, known])
  const intro = known ?? (read?.id === id ? read.intro : undefined)
  const add = useAddFromIntro(id, addable)

  const slides: ModalSlide[] =
    intro === undefined
      ? [{ id: 'reading', title: name, body: 'Reading its introduction…' }]
      : (intro ? slidesOfIntro(intro) : help ? slidesOfHelp(name, help) : slidesOfSummary(name, summary)).map(asModal)

  const said = addSaid(add.state)
  return (
    <IntroModal
      open={open}
      onOpenChange={onOpenChange}
      slides={slides}
      icon={<ModuleIcon id={id} icon={icon} name={name} className="text-muted-foreground size-4" />}
      name={name}
      label={introTitle(name)}
      closeLabel={`Close the introduction to ${name}`}
      action={
        said
          ? (lastSlide) => (
              <span className="contents">
                {add.refused ? (
                  <span role="alert" className="w-full text-xs leading-relaxed text-amber-600 dark:text-amber-400" data-intro-refused="">
                    {add.refused}
                  </span>
                ) : null}
                <Button
                  size="sm"
                  variant={lastSlide ? 'default' : 'secondary'}
                  disabled={addDisabled(add.state)}
                  onClick={add.onAdd}
                  data-intro-add={add.state.kind}
                >
                  {add.state.kind === 'add' || add.state.kind === 'install' ? <Plus className="size-3.5" /> : null}
                  {said}
                </Button>
              </span>
            )
          : undefined
      }
      last={(close) => (
        <Button size="sm" variant={said ? 'ghost' : 'default'} onClick={close} data-intro-done="">
          Done
        </Button>
      )}
    />
  )
}
