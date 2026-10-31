import { meterSaid, type FooterItem, type HeaderItem, type PressValue } from 'kehikot-module-protocol'
import { ChevronDown, LoaderCircle, OctagonAlert, TriangleAlert } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { footerRow, type FooterPressable } from '@/host/footer.ts'
import type { Pressed, Pressing } from '@/host/header.ts'
import { DISARM_AFTER_MS } from './Clearing.tsx'
import { HEADER_ICONS, HeaderMenus, SAID_FOR_MS } from './HeaderMenus.tsx'

/**
 * A module's declared footer (protocol 2.38.0), drawn as one row at the bottom
 * of its container in the header's look: the same 32-pixel height at rest
 * (`h-8`), the same card colour and border, the same 11–12 px words and 24 px
 * controls. `host/footer.ts` holds every rule; this file draws.
 *
 * ## One row at every width
 *
 * The layout is the protocol's `footerLayout`, measured on this row's own
 * width (a container is resized one at a time; the window says nothing):
 * words at 300 px and over, the narrow row under 300 (optional items gone,
 * runs as their icons, meters without their label), one "⋯" under 220 with
 * every pressable item in it. The "⋯" is the header's own menu
 * (`HeaderMenus` in its merged mode), so a footer run arms, says a refusal
 * and hands the keyboard back exactly as a header run does.
 *
 * ## A module's words are text
 *
 * Text, labels, tooltips and results are a stranger's strings: text nodes,
 * never markup, never a link. An icon is a key in `HEADER_ICONS`. A level is
 * said with a mark and a word in the accessible name as well as a colour.
 */
export function FooterBar({
  items,
  name,
  onPress,
  onKeyboard,
}: {
  /** What the module last declared. Never empty here: `drawsFooter` decides whether this is drawn at all. */
  items: readonly FooterItem[]
  name: string
  /** Send one press on a footer item (`footerPressing`). */
  onPress(press: Pressing): Promise<Pressed>
  onKeyboard?(): void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const measure = () => setWidth((was) => {
      const now = element.offsetWidth || null
      return was === now ? was : now
    })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const watching = new ResizeObserver(measure)
    watching.observe(element)
    return () => watching.disconnect()
  }, [])

  const row = footerRow(items, width)
  const [said, setSaid] = useState<{ item: string; text: string } | null>(null)
  useEffect(() => {
    if (!said) return
    const timer = window.setTimeout(() => setSaid(null), SAID_FOR_MS)
    return () => window.clearTimeout(timer)
  }, [said])

  const press = (item: FooterPressable, value?: PressValue) => {
    void onPress({ item: item.id, ...(value === undefined ? {} : { value }) }).then((came) => {
      if (!came.ok) setSaid({ item: item.id, text: came.why })
      else if (item.kind === 'run' || item.kind === 'go') onKeyboard?.()
    })
  }

  const draw = (item: FooterItem) => (
    <FooterCell key={item.id} item={item} iconsOnly={row.iconsOnly} meterLabels={row.meterLabels} press={press} said={said?.item === item.id ? said.text : null} />
  )

  return (
    <div
      ref={box}
      role="toolbar"
      aria-label={`${name} footer`}
      data-footer-mode={row.mode}
      className="bg-card pointer-events-auto flex h-8 min-w-0 shrink-0 items-center gap-2 overflow-hidden border-t px-2.5 text-[11px] select-none @max-[300px]/container:gap-1"
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 @max-[300px]/container:gap-1" data-footer-group="start">
        {row.start.map(draw)}
      </span>
      {row.center.length ? (
        <span className="flex min-w-0 shrink items-center justify-center gap-2" data-footer-group="center">
          {row.center.map(draw)}
        </span>
      ) : null}
      {row.end.length || row.overflow.length ? (
        <span className="flex min-w-0 shrink-0 items-center justify-end gap-1" data-footer-group="end">
          {row.end.map(draw)}
          {row.overflow.length ? (
            <span data-footer-overflow className="flex items-center">
              <HeaderMenus
                items={row.overflow as unknown as HeaderItem[]}
                name={name}
                mode="merged"
                pinned={false}
                onPress={(one) => onPress(one)}
                onKeyboard={onKeyboard}
              />
            </span>
          ) : null}
        </span>
      ) : null}
      {/* A refusal, said where the row has room for it, and in the live region for a reader. */}
      <span className="sr-only" role="status">{said?.text ?? ''}</span>
    </div>
  )
}

/** The mark that says a level besides its colour. */
function LevelMark({ level }: { level: 'normal' | 'warn' | 'critical' }) {
  if (level === 'critical') return <OctagonAlert className="text-destructive size-3 shrink-0" aria-hidden data-level="critical" />
  if (level === 'warn') return <TriangleAlert className="size-3 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden data-level="warn" />
  return null
}

const LEVEL_WORD = { normal: '', warn: ' (warning)', critical: ' (critical)' } as const

function FooterCell({
  item,
  iconsOnly,
  meterLabels,
  press,
  said,
}: {
  item: FooterItem
  iconsOnly: boolean
  meterLabels: boolean
  press(item: FooterPressable, value?: PressValue): void
  said: string | null
}) {
  if (item.kind === 'text') {
    return (
      <span
        data-footer-item={item.id}
        data-footer-kind="text"
        title={item.tooltip ? `${item.text} — ${item.tooltip}` : item.text}
        aria-label={`${item.text}${LEVEL_WORD[item.level]}`}
        className={`flex min-w-0 items-center gap-1 ${item.level === 'critical' ? 'text-destructive' : item.level === 'warn' ? 'text-foreground' : 'text-muted-foreground'}`}
      >
        <LevelMark level={item.level} />
        <span className="min-w-0 truncate">{item.text}</span>
      </span>
    )
  }

  if (item.kind === 'meter') {
    const value = meterSaid(item)
    const tone = item.level === 'critical' ? 'bg-destructive' : item.level === 'warn' ? 'bg-amber-500' : 'bg-primary/70'
    return (
      <span
        data-footer-item={item.id}
        data-footer-kind="meter"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={item.value}
        aria-valuetext={`${value}${LEVEL_WORD[item.level]}`}
        aria-label={item.label}
        title={`${item.label}: ${value}${item.tooltip ? ` — ${item.tooltip}` : ''}`}
        className="text-muted-foreground flex min-w-0 shrink items-center gap-1"
      >
        {meterLabels ? <span className="shrink-0">{item.label}</span> : null}
        <span className="bg-muted relative h-1.5 w-12 shrink-0 overflow-hidden rounded-full @max-[300px]/container:w-8" aria-hidden>
          <span className={`absolute inset-y-0 left-0 rounded-full ${tone}`} style={{ width: `${Math.round(item.value * 100)}%` }} />
        </span>
        <LevelMark level={item.level} />
        <span className="shrink-0 tabular-nums">{value}</span>
      </span>
    )
  }

  if (item.kind === 'run') return <FooterRun item={item} iconOnly={iconsOnly} press={press} said={said} />

  if (item.kind === 'toggle') {
    return (
      <Button
        variant="ghost"
        type="button"
        aria-pressed={item.checked}
        data-footer-item={item.id}
        data-footer-kind="toggle"
        title={said ?? item.tooltip ?? item.label}
        className={`h-6 min-w-0 shrink cursor-default px-1.5 text-[11px] ${item.checked ? 'text-foreground bg-accent' : 'text-muted-foreground'}`}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => press(item, !item.checked)}
      >
        <Icon name={item.icon} />
        {iconsOnly && iconOf(item.icon) ? <span className="sr-only">{item.label}</span> : <span className="min-w-0 truncate">{item.label}</span>}
      </Button>
    )
  }

  /* A switch or a go: a small menu of its options. A switch says the option it is on. */
  const current = item.kind === 'switch' ? item.options.find((option) => option.id === item.value)?.label : undefined
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          type="button"
          data-footer-item={item.id}
          data-footer-kind={item.kind}
          title={said ?? item.tooltip ?? (current ? `${item.label}: ${current}` : item.label)}
          aria-label={current ? `${item.label}: ${current}` : item.label}
          className="text-muted-foreground hover:text-foreground h-6 min-w-0 shrink cursor-default gap-1 px-1.5 text-[11px]"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <Icon name={item.icon} />
          <span className="min-w-0 truncate">{current ?? item.label}</span>
          <ChevronDown className="size-3 shrink-0" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="max-h-72 overflow-y-auto">
        {item.kind === 'switch' ? (
          <DropdownMenuRadioGroup value={item.value} onValueChange={(value) => press(item, value)}>
            {item.options.map((option) => (
              <DropdownMenuRadioItem key={option.id} value={option.id} className="text-xs">
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        ) : (
          item.options.map((option) => (
            <DropdownMenuItem key={option.id} className="text-xs" onSelect={() => press(item, option.id)}>
              {option.label}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A run as a button: words, or its icon alone in the narrow row; armed on the first press of a `confirm` run. */
function FooterRun({
  item,
  iconOnly,
  press,
  said,
}: {
  item: Extract<FooterItem, { kind: 'run' }>
  iconOnly: boolean
  press(item: FooterPressable): void
  said: string | null
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), DISARM_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [armed])
  const busy = item.state === 'busy'
  const failed = item.state === 'failed'
  const inert = item.disabled !== null || busy
  const icon = iconOf(item.icon)
  const bare = iconOnly && icon !== undefined
  const hint =
    said
    ?? (armed
      ? `${item.label} — press again to confirm`
      : `${item.label}${item.disabled ? ` — ${item.disabled}` : busy ? ' — running' : failed ? ` — the last run failed${item.result ? `: ${item.result}` : ''}` : item.result ? ` — ${item.result}` : ''}${item.tooltip ? ` — ${item.tooltip}` : ''}`)
  let face: ReactNode = <Icon name={item.icon} />
  if (busy) face = <LoaderCircle className="size-3 motion-safe:animate-spin" aria-hidden />
  else if (failed) face = <TriangleAlert className="size-3" aria-hidden />
  return (
    <Button
      variant="ghost"
      type="button"
      aria-label={armed ? `${item.label} — press again to confirm` : item.label}
      aria-disabled={inert || undefined}
      aria-busy={busy || undefined}
      data-footer-item={item.id}
      data-footer-kind="run"
      data-armed={armed ? 'true' : undefined}
      title={hint}
      className={`h-6 min-w-0 shrink cursor-default gap-1 text-[11px] aria-disabled:hover:bg-transparent ${bare ? 'w-6 p-0' : 'px-1.5'} ${
        armed ? 'bg-destructive/15 text-destructive ring-destructive ring-1' : failed ? 'text-destructive' : 'text-muted-foreground hover:text-foreground'
      } ${item.disabled !== null ? 'opacity-50' : ''}`}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={() => {
        if (inert) return
        if (item.confirm && !armed) {
          setArmed(true)
          return
        }
        setArmed(false)
        press(item)
      }}
    >
      {face}
      {bare ? null : <span className="min-w-0 truncate">{armed ? `${item.label}?` : item.label}</span>}
      {!bare && item.result && !armed ? <span className="text-muted-foreground/80 hidden shrink-0 @min-[380px]/container:inline">{item.result}</span> : null}
    </Button>
  )
}

function iconOf(name: string | undefined) {
  return name === undefined ? undefined : HEADER_ICONS.get(name)
}

function Icon({ name }: { name: string | undefined }) {
  const Drawn = iconOf(name)
  return Drawn ? <Drawn className="size-3 shrink-0" aria-hidden data-icon={name} /> : null
}
