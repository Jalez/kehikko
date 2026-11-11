import { CloudDownload, Moon, PanelTopOpen, Play, PlugZap, RotateCcw, TriangleAlert, Unplug, type LucideIcon } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { cn } from '@/lib/utils'
import { coverLayoutFor, standingHint, type CoverLayout, type Standing, type StandingAction } from '@/host/coverFit.ts'
import type { Presence } from '@/host/registry.ts'
import type { noticeOf, Showing } from '@/host/standing.ts'
import { openUpdates } from '@/host/updates.ts'
import { CoverIcon, ModuleCover } from './Conditions.tsx'
import { Hint } from './Hint.tsx'
import { ContainerNotice } from './Notice.tsx'
import { useStart } from './Start.tsx'

/**
 * The cover or notice, drawn for the room the container has (`host/coverFit.ts`).
 *
 * `StandingBox` fills the body and measures it — the container's own box, with
 * a ResizeObserver, never the window — then draws the full cover, the small
 * one, or one line. `StandingChip` is the folded header's word, and
 * `standingRows` the Container menu rows that carry the press there.
 *
 * The working state is the module's own icon at every size, breathing
 * (`CoverIcon`): tiny in the header and the line, small, full — and alone, with
 * the sentence as its label and tooltip, in a cover under `ICON_ONLY_BELOW`
 * pixels wide. It is still under reduced motion (`index.css`).
 */

/** Under this many pixels of width a cover is its icon alone; the sentence is its label and tooltip. */
export const ICON_ONLY_BELOW = 120

/** The icon for a notice's tone; the working tone is the module's icon, drawn by `ToneMark`. */
const TONE_ICONS: Record<Exclude<Standing['tone'], 'working'>, LucideIcon> = {
  stopped: Unplug,
  asleep: Moon,
  incompatible: PlugZap,
  failed: TriangleAlert,
}

const ACTION_ICONS: Record<StandingAction['kind'], LucideIcon> = {
  start: Play,
  retry: RotateCcw,
  restart: RotateCcw,
  update: CloudDownload,
  fix: CloudDownload,
}

function ToneMark({ tone, className, module, name }: { tone: Standing['tone']; className: string; module: string; name: string }) {
  if (tone === 'working') return <CoverIcon id={module} name={name} className={className} />
  const Icon = TONE_ICONS[tone]
  return <Icon className={cn('shrink-0', tone === 'incompatible' ? 'text-amber-400' : 'text-muted-foreground', className)} aria-hidden />
}

/**
 * The one press of a notice, at any size: start, retry the restart, or open the
 * updates panel. `said` is what a start answered, when it said anything.
 */
export function useStandingPress(
  action: StandingAction | null,
  module: string,
  onStarted: () => void,
  onRestart?: () => void,
): { press: (() => void) | null; running: boolean; said: string | null } {
  const start = useStart(module, onStarted)
  if (!action) return { press: null, running: false, said: null }
  switch (action.kind) {
    case 'start':
      return { press: () => void start.press(), running: start.running, said: start.said }
    case 'retry':
    case 'restart':
      return { press: onRestart ?? null, running: false, said: null }
    case 'update':
      return { press: () => openUpdates(), running: false, said: null }
    case 'fix':
      return { press: () => openUpdates(action.module ? module : undefined), running: false, said: null }
  }
}

/** The body's width and height, kept as the container is resized. `null` until measured. */
function useBox(ref: React.RefObject<HTMLElement | null>): { width: number; height: number } | null {
  const [box, setBox] = useState<{ width: number; height: number } | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () =>
      setBox((was) => {
        const width = element.offsetWidth
        const height = element.offsetHeight
        return was && was.width === width && was.height === height ? was : { width, height }
      })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const watching = new ResizeObserver(measure)
    watching.observe(element)
    return () => watching.disconnect()
  }, [ref])
  return box
}

export function StandingBox({
  showing,
  notice,
  standing,
  presence,
  name,
  coverDetail,
  onStarted,
  onRestart,
  restartWhy,
  onReload,
}: {
  showing: Exclude<Showing, { kind: 'page' }>
  notice: ReturnType<typeof noticeOf> | null
  standing: Standing
  presence: Pick<Presence, 'id' | 'at' | 'protocols'>
  /** The module's name: the icon's label, and "Loading <module>…". */
  name: string
  coverDetail?: string
  onStarted(): void
  /** Restart the module. Absent when this host may not, and `restartWhy` says why. */
  onRestart?(): void
  restartWhy?: string | null
  /** A new document for the frame, from the server that answers. */
  onReload?(): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const box = useBox(ref)
  const layout = coverLayoutFor(box?.width ?? null, box?.height ?? null, 0)
  /* A cover too narrow for words is the icon alone, the sentence its name and tooltip. A notice
     always keeps its words and its press. */
  const iconOnly = showing.kind === 'cover' && box !== null && box.width > 0 && box.width < ICON_ONLY_BELOW
  if (iconOnly) {
    return (
      <div ref={ref} className="bg-card pointer-events-auto absolute inset-0 overflow-hidden" data-cover-layout="icon">
        <div
          className="flex h-full items-center justify-center"
          data-testid="module-cover"
          data-state={showing.state}
          role="status"
          aria-label={standing.sentence}
          title={standingHint(standing)}
        >
          <CoverIcon id={presence.id} name={name} className="size-5" />
        </div>
      </div>
    )
  }
  return (
    <div ref={ref} className="bg-card pointer-events-auto absolute inset-0 overflow-hidden" data-cover-layout={layout}>
      {layout === 'full' ? (
        showing.kind === 'cover' ? (
          <ModuleCover state={showing.state} at={presence.at} detail={coverDetail} id={presence.id} name={name} label={showing.label} />
        ) : notice ? (
          <ContainerNotice showing={showing} notice={notice} presence={presence} onStarted={onStarted} onRestart={onRestart} restartWhy={restartWhy} onReload={onReload} />
        ) : null
      ) : (
        <Compact layout={layout === 'small' ? 'small' : 'line'} standing={standing} state={showing.kind === 'cover' ? showing.state : undefined} module={presence.id} name={name} onStarted={onStarted} onRestart={onRestart} />
      )}
    </div>
  )
}

/** The small cover and the one-line cover. Nothing in either is wider than the box: text truncates, the rest does not shrink. */
function Compact({
  layout,
  standing,
  state,
  module,
  name,
  onStarted,
  onRestart,
}: {
  layout: Exclude<CoverLayout, 'full' | 'header'>
  standing: Standing
  state?: string
  module: string
  name: string
  onStarted(): void
  onRestart?(): void
}) {
  const { press, running, said } = useStandingPress(standing.action, module, onStarted, onRestart)
  const hint = standingHint(standing, said)
  const action = standing.action && press ? standing.action : null
  const ActionIcon = action ? ACTION_ICONS[action.kind] : null
  const busy = running ? 'Starting' : null

  if (layout === 'line') {
    return (
      <div
        className="flex h-full min-w-0 items-center gap-2 px-3"
        data-testid={state ? 'module-cover' : 'condition-line'}
        data-state={state}
        role="status"
        title={hint}
      >
        <ToneMark tone={running ? 'working' : standing.tone} className="size-4" module={module} name={name} />
        <span className="text-foreground min-w-0 flex-1 truncate text-xs font-medium" data-testid="standing-word">
          {busy ?? standing.word}
        </span>
        {action && ActionIcon ? (
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-6 shrink-0"
            aria-label={action.label}
            title={action.label}
            data-standing-action={action.kind}
            disabled={running}
            onClick={press!}
          >
            <ActionIcon className="size-3.5" aria-hidden />
          </Button>
        ) : null}
      </div>
    )
  }

  return (
    <div
      className="flex h-full min-w-0 flex-col items-center justify-center gap-1.5 px-3 py-2 text-center"
      data-testid={state ? 'module-cover' : 'condition-small'}
      data-state={state}
      role="status"
    >
      <ToneMark tone={running ? 'working' : standing.tone} className="size-6" module={module} name={name} />
      <div className="flex w-full min-w-0 items-center justify-center gap-2">
        <p className="text-muted-foreground min-w-0 truncate text-xs" title={hint} data-testid="standing-sentence">
          {said ?? standing.sentence}
        </p>
        {action && ActionIcon ? (
          <Button
            variant="secondary"
            size="sm"
            className="h-6 max-w-[50%] shrink-0 px-2 text-xs"
            title={action.label}
            data-standing-action={action.kind}
            disabled={running}
            onClick={press!}
          >
            <ActionIcon className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{running ? 'starting…' : action.label}</span>
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The folded header's word for the state: the mark or icon, tiny, and the
 * short word, which gives way under 240 pixels of container. The sentence and
 * what the body would show are in its tooltip, with where the press went.
 */
export function StandingChip({
  standing,
  said,
  running,
  module,
  name,
}: {
  standing: Standing
  said: string | null
  running: boolean
  module: string
  name: string
}) {
  const word = running ? 'Starting' : standing.word
  const where = standing.action ? `\n${standing.action.label} is in the Container menu.` : ''
  return (
    <Hint label={<span className="whitespace-pre-line">{`${standingHint(standing, said)}${where}`}</span>} side="bottom" align="start">
      <span
        tabIndex={0}
        role="status"
        aria-label={`${word}: ${standing.sentence}`}
        data-testid="standing-chip"
        data-tone={running ? 'working' : standing.tone}
        className="text-muted-foreground flex min-w-0 shrink items-center gap-1 rounded text-[11px] outline-none focus-visible:ring-1"
      >
        <ToneMark tone={running ? 'working' : standing.tone} className="size-3" module={module} name={name} />
        <span className="truncate @max-[240px]/container:hidden">{word}</span>
      </span>
    </Hint>
  )
}

/** One row the folded header's Container menu draws for the state. */
export interface StandingRow {
  key: string
  label: string
  icon: LucideIcon
  title: string
  disabled?: boolean
  onSelect(): void
}

/**
 * The rows a folded container's Container menu carries for its state: the press
 * the body would have offered, and, for a notice, unfolding to read it all.
 */
export function standingRows(
  standing: Standing,
  pressing: { press: (() => void) | null; running: boolean },
  unfold: () => void,
): StandingRow[] {
  const rows: StandingRow[] = []
  if (standing.action && pressing.press) {
    rows.push({
      key: standing.action.kind,
      label: standing.action.label,
      icon: ACTION_ICONS[standing.action.kind],
      title: standing.sentence,
      disabled: pressing.running,
      onSelect: pressing.press,
    })
  }
  if (standing.tone !== 'working') {
    rows.push({ key: 'details', label: 'Show details', icon: PanelTopOpen, title: 'unfold the container to read why, and what it printed', onSelect: unfold })
  }
  return rows
}
