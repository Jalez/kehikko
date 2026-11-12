import { FileText, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Help, Intro } from 'kehikot-module-protocol'

import { Button } from '@/components/ui/button.tsx'
import { fetchOfficial, installOfficial, type OfficialModule } from '@/host/official.ts'
import { fetchMine, installMine } from '@/host/myModules.ts'
import { needsNewerSaid, releaseVersion, worksSaid, type ModuleRelease } from '@/host/moduleReleases.ts'
import { fetchModuleRelease } from '@/host/updates.ts'
import { appEngine } from '@/host/appUpdate.ts'
import {
  addDisabled,
  addSaid,
  addStateOf,
  fetchIntro,
  introTitle,
  slidesOfModule,
  VERSION_TITLE,
  type AddState,
  type ShownSlide,
} from '@/host/moduleIntro.ts'
import { IntroModal, type ModalSlide } from './IntroModal.tsx'
import { ModuleArt } from './ModuleArt.tsx'
import { ModuleIcon } from './ModuleIcon.tsx'

/**
 * "What <name> is": everything long about a module, in the app's introduction dialog (`IntroModal`) —
 * the same frame, controls and look, the module's icon and name at the top. The modules list's rows
 * say one sentence and send the rest here.
 *
 * Its parts, in this order, each only when the module has it (`slidesOfModule`): what it is (its
 * summary, whole); its introduction (protocol 2.57.0) — from its running manifest, else read by the
 * server without running it (`fetchIntro`: the installed copy, or the release an install would take);
 * its "How to use"; what it works with (what it follows and narrows to, whom it consumes from and
 * provides to); and its version and releases, with its release notes a press away.
 *
 * Opened from the "?" in the modules list, with "Add to this kehikko" in its footer on every slide
 * (`addable`): the picker's own add, or the list's own install followed by the add ("Install and
 * add", with the install's progress). From a container's Help menu the module is already placed,
 * and there is no button.
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

function asModal(slide: ShownSlide, below?: ModalSlide['below']): ModalSlide {
  const art = slide.art
  return {
    id: slide.id,
    title: slide.title,
    body: slide.body,
    ...(slide.points ? { points: slide.points } : {}),
    ...(art ? { art: () => <ModuleArt art={art} /> } : {}),
    ...(below ? { below } : {}),
  }
}

/** The releases an installed module is on and could move to, a line each, with the Kehikot each works with. */
export function releaseLines(release: ModuleRelease | null, have: { app?: string | null; protocol?: string | null }): string[] {
  if (!release) return []
  const line = (label: string, tag: string) => {
    const works = worksSaid(release, tag)
    return `${label} ${releaseVersion(tag)}${works ? ` · ${works}` : ''}`
  }
  const newer = needsNewerSaid(release, have)
  return [
    ...(release.installed ? [line('Release', release.installed)] : []),
    ...(release.newest && release.newest !== release.installed ? [line('Newest', release.newest)] : []),
    ...(newer ? [newer] : []),
  ]
}

/** An installed module's releases, read while the dialog is open. */
function useReleaseLines(id: string, wanted: boolean): string[] {
  const [lines, setLines] = useState<{ id: string; lines: string[] } | null>(null)
  useEffect(() => {
    if (!wanted) return
    const abort = new AbortController()
    void (async () => {
      try {
        const [got, status] = await Promise.all([fetchModuleRelease(id, abort.signal), appEngine()?.status().catch(() => null) ?? Promise.resolve(null)])
        if (!abort.signal.aborted) setLines({ id, lines: releaseLines(got.release, { app: status?.current ?? null, protocol: got.protocol }) })
      } catch {
        /* Said nothing: the version the module gave stands on its own. */
      }
    })()
    return () => abort.abort()
  }, [id, wanted])
  return lines?.id === id ? lines.lines : []
}

/** The list's entry for a module not installed here, read while the dialog is open; polled while it installs. */
export function useListed(id: string, wanted: boolean, asked = 0) {
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
  works,
  version,
  releases = false,
  onNotes,
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
  /** What it works with, a line each (`worksWithOf`); none: no such part. */
  works?: readonly string[]
  /** The version it gives, a line each; with `releases`, its releases are read and follow. */
  version?: readonly string[]
  /** It is installed here: its releases are read while the dialog is open. */
  releases?: boolean
  /** Open its release notes: a button on the version part. */
  onNotes?(): void
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

  const released = useReleaseLines(id, open && releases)

  const shown = slidesOfModule(name, { summary, intro: intro ?? null, help, works, version: [...(version ?? []), ...released] })
  const notes: ModalSlide['below'] = onNotes
    ? (close) => (
        <Button
          size="sm"
          variant="outline"
          data-intro-notes=""
          onClick={() => {
            close()
            onNotes()
          }}
        >
          <FileText className="size-3.5" />
          Release notes
        </Button>
      )
    : undefined
  /* The version part is there whenever release notes can be opened, even with nothing else to say. */
  const withVersion = notes && !shown.some((one) => one.id === 'version') ? [...shown, { id: 'version', title: VERSION_TITLE, body: '' }] : shown
  const slides: ModalSlide[] = withVersion.map((one) => asModal(one, one.id === 'version' ? notes : undefined))
  /* While its introduction is being read, a line says so where it will be. */
  if (intro === undefined) slides.splice(1, 0, { id: 'reading', title: name, body: 'Reading its introduction…' })

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
