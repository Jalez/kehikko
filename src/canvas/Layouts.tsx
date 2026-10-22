import { Check, LayoutTemplate } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { ScrollArea } from '@/components/ui/scroll-area.tsx'
import { COLUMNS } from '@/host/canvases.ts'
import { CANVAS_ROWS } from '@/host/fit.ts'
import {
  availability,
  availabilitySaid,
  fetchLayouts,
  saveLayout,
  toInstall,
  type Available,
  type Layout,
  type LayoutContainer,
  type OfficialEntry,
  type Shelves,
} from '@/host/layouts.ts'
import type { LayoutsMode } from '@/host/onboarding.ts'

/**
 * Starting a kehikko from a suggested layout, and saving one as a layout.
 *
 * The rules — which layouts there are, what "will install" means — are
 * `src/host/layouts.ts`; this file only draws them. Nothing is installed by
 * choosing a card: a layout naming a module on the official list that is not
 * here says "will install Review", and the press on Create asks once more,
 * naming every module and where it comes from, before the existing install
 * flow is called (`/host/official/install`). "Create without them" leaves
 * those containers out.
 */

/** The blank kehikko, which is always the first card: a picker must never stand between a person and an empty canvas. */
export const BLANK: Layout = { id: 'blank', from: 'builtin', name: 'Blank', summary: 'An empty kehikko. Put modules on it from Kehikko modules.', containers: [] }

/** The rectangles of a layout as a small schematic, drawn with the theme's own colours. */
export function LayoutPreview({
  containers,
  available,
  className = 'h-20 w-full',
}: {
  containers: readonly LayoutContainer[]
  available?: readonly Available[]
  className?: string
}) {
  const state = new Map(available?.map((one) => [one.module, one]) ?? [])
  const rows = Math.max(CANVAS_ROWS, ...containers.map((c) => c.y + c.h))
  return (
    <svg
      viewBox={`0 0 ${COLUMNS * 10} ${rows * 4}`}
      preserveAspectRatio="none"
      className={className}
      role="img"
      aria-label={containers.length ? `${containers.length} containers` : 'an empty kehikko'}
      data-layout-preview=""
    >
      <rect x="0" y="0" width={COLUMNS * 10} height={rows * 4} rx="3" className="fill-muted/40" />
      {containers.map((c) => {
        const one = state.get(c.module)
        const absent = one && one.state !== 'here'
        return (
          <g key={c.module}>
            <rect
              x={c.x * 10 + 1.5}
              y={c.y * 4 + 1.5}
              width={c.w * 10 - 3}
              height={c.h * 4 - 3}
              rx="2.5"
              className={absent ? 'fill-background stroke-muted-foreground/60' : 'fill-card stroke-border'}
              strokeDasharray={absent ? '3 2' : undefined}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              data-preview-module={c.module}
              data-preview-state={one?.state}
            />
            <rect x={c.x * 10 + 1.5} y={c.y * 4 + 1.5} width={c.w * 10 - 3} height="4" rx="2" className={absent ? 'fill-transparent' : 'fill-primary/25'} />
          </g>
        )
      })}
    </svg>
  )
}

function shortName(module: string, available: readonly Available[]): string {
  return available.find((one) => one.module === module)?.name ?? module.replace(/^kehikot\./, '')
}

/** One layout as a card: the picture, its name, what is on it and what using it would take. */
function LayoutCard({
  layout,
  available,
  chosen,
  onChoose,
}: {
  layout: Layout
  available: readonly Available[]
  chosen: boolean
  onChoose(): void
}) {
  const said = availabilitySaid(available)
  const optional = available.filter((one) => one.optional && one.state !== 'here').map((one) => one.name)
  return (
    <button
      type="button"
      onClick={onChoose}
      aria-pressed={chosen}
      data-layout-card={`${layout.from}:${layout.id}`}
      className={
        'group bg-card focus-visible:ring-ring/50 relative flex flex-col gap-1.5 rounded-lg border p-2 text-left outline-none transition-colors focus-visible:ring-[3px] ' +
        (chosen ? 'border-primary ring-primary/40 ring-2' : 'hover:border-foreground/30')
      }
    >
      <LayoutPreview containers={layout.containers} available={available} />
      <span className="flex items-center gap-1.5 text-sm font-medium">
        {layout.name}
        {chosen ? <Check className="text-primary size-3.5" aria-hidden /> : null}
      </span>
      <span className="text-muted-foreground line-clamp-2 text-xs leading-snug">{layout.summary}</span>
      {layout.containers.length ? (
        <span className="text-muted-foreground text-[11px] leading-snug">
          {layout.containers
            .filter((c) => !c.optional || available.find((one) => one.module === c.module)?.state === 'here')
            .map((c) => shortName(c.module, available))
            .join(' · ')}
          {optional.length ? ` · ${optional.join(', ')} if installed` : ''}
        </span>
      ) : null}
      {said ? (
        <span className="text-amber-700 dark:text-amber-400 text-[11px] leading-snug" data-layout-availability="">
          {said}
        </span>
      ) : null}
    </button>
  )
}

interface PickerProps {
  open: boolean
  onOpenChange(open: boolean): void
  mode: LayoutsMode
  /** The open project, whose own layouts are offered. */
  project: number | null
  /** What is registered here, id → name. */
  registered: ReadonlyMap<string, string>
  /** Make the kehikko (mode `new`) or fill the open one (`fill`) with these containers. Resolves to a refusal or null. */
  onUse(layout: Layout, available: Available[], install: string[], name: string): Promise<string | null>
  /** Read for the cards; injectable for a test. */
  load?: (project: number | null) => Promise<Shelves>
  loadOfficial?: () => Promise<OfficialEntry[]>
}

async function officialList(): Promise<OfficialEntry[]> {
  const response = await fetch('/host/official', { cache: 'no-store' })
  if (!response.ok) return []
  const body = (await response.json()) as { modules?: OfficialEntry[] }
  return Array.isArray(body.modules) ? body.modules : []
}

/**
 * The picker: Blank first, then ours, the project's and the person's own,
 * each a card with its picture. Create makes the kehikko (or, from the empty
 * canvas, fills it); a layout that needs installs asks first.
 */
const loadShelves = (project: number | null) => fetchLayouts(project)

export function LayoutPicker({ open, onOpenChange, mode, project, registered, onUse, load = loadShelves, loadOfficial = officialList }: PickerProps) {
  const [shelves, setShelves] = useState<Shelves | null>(null)
  const [official, setOfficial] = useState<OfficialEntry[]>([])
  const [chosen, setChosen] = useState<Layout>(BLANK)
  const [name, setName] = useState('')
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    setChosen(BLANK)
    setName('')
    setAsking(false)
    setRefused(null)
    void load(project)
      .then((got) => alive && setShelves(got))
      .catch((error: unknown) => alive && setRefused((error as Error).message))
    void loadOfficial()
      .then((got) => alive && setOfficial(got))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [open, project, load, loadOfficial])

  const availableOf = useMemo(() => {
    const cache = new Map<string, Available[]>()
    return (layout: Layout) => {
      const key = `${layout.from}:${layout.id}`
      let got = cache.get(key)
      if (!got) cache.set(key, (got = availability(layout, registered, official)))
      return got
    }
  }, [registered, official])

  const available = availableOf(chosen)
  const installs = toInstall(available)

  async function use(install: string[]) {
    setBusy(true)
    setRefused(null)
    const why = await onUse(chosen, available, install, name.trim() || (chosen === BLANK ? '' : chosen.name))
    setBusy(false)
    if (why) setRefused(why)
    else {
      setAsking(false)
      onOpenChange(false)
    }
  }

  const sections: Array<{ title: string; note?: string; layouts: Layout[] }> = [
    { title: 'Suggested', layouts: [BLANK, ...(shelves?.builtIn ?? [])] },
    ...(shelves?.project.length ? [{ title: 'This project’s', note: 'kept in .kehikot/host/layouts/, so they travel with the project', layouts: shelves.project }] : []),
    ...(shelves?.mine.length ? [{ title: 'Mine', note: 'kept on this computer, for every project', layouts: shelves.mine }] : []),
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl gap-3" data-layout-picker={mode}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LayoutTemplate className="size-4" />
            {mode === 'fill' ? 'Start this kehikko from a layout' : 'New kehikko'}
          </DialogTitle>
          <DialogDescription>
            A kehikko is one arrangement of modules over the project. Start from a suggested layout, or from nothing — you
            can move, resize and add containers afterwards.
          </DialogDescription>
        </DialogHeader>

        {asking ? (
          <div className="flex flex-col gap-3" data-layout-confirm="">
            <p className="text-sm">
              {chosen.name} uses {installs.length === 1 ? 'a module' : 'modules'} this computer does not have yet:
            </p>
            <ul className="flex flex-col gap-1 text-sm">
              {installs.map((one) => (
                <li key={one.module} className="flex items-baseline gap-2">
                  <span className="font-medium">{one.name}</span>
                  <span className="text-muted-foreground font-mono text-xs">{one.module}</span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-xs leading-relaxed">
              Installing clones each from the official list on GitHub, runs bun install in it and registers it on this
              computer, exactly as the modules list does. Their containers wait on the kehikko until they are ready.
            </p>
            {refused ? <p className="text-destructive text-xs">{refused}</p> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setAsking(false)} disabled={busy}>
                Back
              </Button>
              <Button variant="outline" size="sm" onClick={() => void use([])} disabled={busy} data-layout-without="">
                Create without {installs.length === 1 ? 'it' : 'them'}
              </Button>
              <Button size="sm" onClick={() => void use(installs.map((one) => one.module))} disabled={busy} data-layout-install="">
                Install {installs.length === 1 ? installs[0]!.name : `${installs.length} modules`} and create
              </Button>
            </div>
          </div>
        ) : (
          <>
            <ScrollArea className="max-h-[56vh] pr-2">
              <div className="flex flex-col gap-4">
                {sections.map((section) => (
                  <section key={section.title} aria-label={section.title} className="flex flex-col gap-2">
                    <h3 className="text-muted-foreground text-xs font-medium">
                      {section.title}
                      {section.note ? <span className="font-normal"> — {section.note}</span> : null}
                    </h3>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
                      {section.layouts.map((layout) => (
                        <LayoutCard
                          key={`${layout.from}:${layout.id}`}
                          layout={layout}
                          available={availableOf(layout)}
                          chosen={chosen.from === layout.from && chosen.id === layout.id}
                          onChoose={() => setChosen(layout)}
                        />
                      ))}
                    </div>
                  </section>
                ))}
                {shelves?.trouble.length ? (
                  <ul className="text-muted-foreground text-[11px]">
                    {shelves.trouble.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </ScrollArea>
            <form
              className="flex flex-wrap items-end gap-2 border-t pt-3"
              onSubmit={(event) => {
                event.preventDefault()
                if (installs.length) setAsking(true)
                else void use([])
              }}
            >
              {mode === 'new' ? (
                <div className="flex min-w-48 flex-1 flex-col gap-1">
                  <Label htmlFor="layout-name" className="text-xs">
                    Name
                  </Label>
                  <Input
                    id="layout-name"
                    value={name}
                    maxLength={60}
                    placeholder={chosen === BLANK ? 'kehikko' : chosen.name}
                    onChange={(event) => setName(event.target.value)}
                    className="h-8"
                  />
                </div>
              ) : (
                <span className="flex-1" />
              )}
              {refused ? <p className="text-destructive basis-full text-xs">{refused}</p> : null}
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy || (mode === 'fill' && chosen === BLANK)} data-layout-create="">
                {mode === 'fill' ? 'Use this layout' : 'Create kehikko'}
              </Button>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** "Save this kehikko as a layout…": a name, and whether it is the project's or the person's own. */
export function SaveLayoutDialog({
  open,
  onOpenChange,
  kehikko,
  save = saveLayout,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  kehikko: { id: number; name: string; placements: readonly { i: string; x: number; y: number; w: number; h: number; wish: number }[] } | null
  save?: typeof saveLayout
}) {
  const [name, setName] = useState('')
  const [summary, setSummary] = useState('')
  const [where, setWhere] = useState<'project' | 'mine'>('project')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(kehikko?.name ?? '')
    setSummary('')
    setWhere('project')
    setSaid(null)
    setSaved(null)
  }, [open, kehikko?.name])

  const empty = !kehikko || kehikko.placements.length === 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-3" data-save-layout="">
        <DialogHeader>
          <DialogTitle>Save this kehikko as a layout</DialogTitle>
          <DialogDescription>
            A layout is the arrangement only — which modules, where and how big. New kehikot can start from it.
          </DialogDescription>
        </DialogHeader>
        {kehikko ? (
          <LayoutPreview
            containers={kehikko.placements.map((p) => ({ module: p.i, x: p.x, y: p.y, w: p.w, h: p.wish || p.h }))}
            className="h-24 w-full"
          />
        ) : null}
        {saved ? (
          <p className="text-sm" data-layout-saved="">
            {saved}
          </p>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (!kehikko) return
              setBusy(true)
              setSaid(null)
              void save({ kehikko: kehikko.id, name, summary, where })
                .then((layout) =>
                  setSaved(
                    where === 'project'
                      ? `Saved as ${layout.name} in the project’s .kehikot/host/layouts/. Commit it and everybody on the project can start from it.`
                      : `Saved as ${layout.name} for you, on this computer. It is offered in every project.`,
                  ),
                )
                .catch((error: unknown) => setSaid((error as Error).message))
                .finally(() => setBusy(false))
            }}
          >
            <div className="flex flex-col gap-1">
              <Label htmlFor="save-layout-name" className="text-xs">
                Name
              </Label>
              <Input id="save-layout-name" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} className="h-8" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="save-layout-summary" className="text-xs">
                What it is for <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input id="save-layout-summary" value={summary} maxLength={200} onChange={(event) => setSummary(event.target.value)} className="h-8" />
            </div>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-xs font-medium">Keep it for</legend>
              {(
                [
                  ['project', 'This project', 'in .kehikot/host/layouts/ — it travels with the project, for everybody on it'],
                  ['mine', 'Just me', 'on this computer — offered in every project, shared with nobody'],
                ] as const
              ).map(([value, title, note]) => (
                <label key={value} className="hover:bg-accent/50 flex cursor-default items-start gap-2 rounded-md border p-2 text-sm">
                  <input
                    type="radio"
                    name="save-layout-where"
                    value={value}
                    checked={where === value}
                    onChange={() => setWhere(value)}
                    className="accent-primary mt-0.5"
                  />
                  <span className="flex flex-col">
                    <span>{title}</span>
                    <span className="text-muted-foreground text-xs">{note}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {empty ? <p className="text-muted-foreground text-xs">There is nothing on this kehikko to save yet.</p> : null}
            {said ? <p className="text-destructive text-xs">{said}</p> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy || empty || !name.trim()}>
                Save layout
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
