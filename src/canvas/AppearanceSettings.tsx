import { useId, type ReactNode } from 'react'

import { Label } from '@/components/ui/label.tsx'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group.tsx'
import { Separator } from '@/components/ui/separator.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import {
  APPEARANCE_TARGET,
  BORDERS,
  BORDER_SAID,
  COLLAPSES,
  COLLAPSE_SAID,
  FOLD_SAID,
  ROWS_SAID,
  THEME_CHOICES,
  THEME_SAID,
  type Appearance,
  type AppearancePatch,
  type Border,
  type Collapse,
  type ThemeChoice,
} from '@/host/appearance.ts'
import { appearance as page, useAppearance, type AppearanceStore } from '@/host/appearanceStore.ts'
import { FOLD_ROWS, SHOW_ROWS, type FoldRows, type ShowRows } from '@/host/rows.ts'
import { TARGET_ATTR } from '@/host/settingsTarget.ts'

/**
 * Settings › Appearance: how the app looks on this computer, the same for every
 * container (`host/appearance.ts`). Each choice is drawn at once — through the
 * attributes on `<html>`, never by re-rendering a module's frame — and then
 * saved (`{ appearance: … }`, `PAGE_ONLY`).
 */
export function AppearanceSettings({ onChange, store = page }: { onChange(what: { appearance: AppearancePatch }): void; store?: AppearanceStore }) {
  const now = useAppearance(store)
  const set = (patch: AppearancePatch) => {
    store.set({ ...store.get(), ...patch })
    onChange({ appearance: patch })
  }

  return (
    <div className="flex min-w-0 flex-col gap-5" data-appearance-settings>
      <header className="min-w-0 space-y-1 pr-16">
        <h3 id="settings-appearance" className="text-base font-semibold">
          Appearance
        </h3>
        <p className="text-muted-foreground text-xs leading-relaxed">
          How Kehikot looks on this computer. Each choice is the same for every container, and is drawn as soon as you make it.
        </p>
      </header>

      <Group title="Header and footer" lead="When every container shows its header (its name and controls) and its footer (what is going on in it).">
        <div {...{ [TARGET_ATTR]: APPEARANCE_TARGET }} className="rounded-md transition-colors data-[lit=true]:bg-amber-500/10 data-[lit=true]:ring-2 data-[lit=true]:ring-amber-500/50">
          <Choices<ShowRows>
            name="rows"
            label="When headers and footers show"
            value={now.rows}
            options={SHOW_ROWS.map((mode) => ({ value: mode, label: ROWS_SAID[mode].label, line: ROWS_SAID[mode].line }))}
            onChange={(rows) => set({ rows })}
          />
        </div>
        <Choices<FoldRows>
          name="foldRows"
          label="How far a fold goes"
          value={now.foldRows}
          options={FOLD_ROWS.map((rows) => ({ value: rows, label: FOLD_SAID[rows].label, line: FOLD_SAID[rows].line }))}
          onChange={(foldRows) => set({ foldRows })}
        />
        <Choices<Collapse>
          name="collapse"
          label="The collapse button"
          value={now.collapse}
          options={COLLAPSES.map((collapse) => ({ value: collapse, label: COLLAPSE_SAID[collapse].label, line: COLLAPSE_SAID[collapse].line }))}
          onChange={(collapse) => set({ collapse })}
        />
      </Group>

      <Separator />

      <Group title="Theme" lead="Light or dark, for the app and the modules in it. System follows this computer’s setting.">
        <Choices<ThemeChoice>
          name="theme"
          label="Theme"
          inline
          value={now.theme}
          options={THEME_CHOICES.map((theme) => ({ value: theme, label: THEME_SAID[theme] }))}
          onChange={(theme) => set({ theme })}
        />
      </Group>

      <Separator />

      <Group title="Containers" lead="The outline and surface the app draws around each module. A module draws its own page inside; these never change it.">
        <div className="flex min-w-0 flex-wrap items-start gap-6">
          <div className="min-w-0 flex-1">
            <Choices<Border>
              name="border"
              label="Border"
              value={now.border}
              options={BORDERS.map((border) => ({ value: border, label: BORDER_SAID[border], swatch: <BorderSwatch border={border} /> }))}
              onChange={(border) => set({ border })}
            />
          </div>
          <Preview now={now} />
        </div>
        <BackgroundRow on={now.background} onChange={(background) => set({ background })} />
      </Group>
    </div>
  )
}

function Group({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="space-y-1">
        <h4 className="text-sm font-medium">{title}</h4>
        <p className="text-muted-foreground text-xs leading-relaxed">{lead}</p>
      </div>
      {children}
    </section>
  )
}

interface Option<T> {
  value: T
  label: string
  line?: string
  swatch?: ReactNode
}

function Choices<T extends string | number>({
  name,
  label,
  value,
  options,
  onChange,
  inline = false,
}: {
  name: keyof Appearance
  label: string
  value: T
  options: readonly Option<T>[]
  onChange(value: T): void
  inline?: boolean
}) {
  const id = useId()
  return (
    <RadioGroup
      aria-label={label}
      data-appearance={name}
      value={String(value)}
      onValueChange={(picked) => {
        const option = options.find((one) => String(one.value) === picked)
        if (option && option.value !== value) onChange(option.value)
      }}
      className={inline ? 'flex flex-wrap gap-4' : 'gap-2.5'}
    >
      {options.map((option) => (
        <div key={String(option.value)} className="flex min-w-0 items-start gap-2.5">
          <RadioGroupItem id={`${id}-${option.value}`} value={String(option.value)} data-choice={String(option.value)} className="mt-0.5" />
          <Label htmlFor={`${id}-${option.value}`} className="flex min-w-0 flex-col items-start gap-0.5 font-normal">
            <span className="flex items-center gap-2 text-sm leading-snug">
              {option.swatch}
              {option.label}
            </span>
            {option.line ? <span className="text-muted-foreground text-xs leading-relaxed">{option.line}</span> : null}
          </Label>
        </div>
      ))}
    </RadioGroup>
  )
}

/** A little square drawn in each border, beside its name. */
function BorderSwatch({ border }: { border: Border }) {
  const style =
    border === 'none'
      ? 'border-dashed border-muted-foreground/30'
      : border === 'solid'
        ? 'border-foreground/60 rounded-none'
        : border === 'rounded'
          ? 'border-foreground/60 rounded-[4px]'
          : border === 'dotted'
            ? 'border-foreground/60 rounded-[4px] border-dotted'
            : 'border-foreground/60 rounded-[4px] border-dashed'
  return <span aria-hidden className={`inline-block size-3.5 border ${style}`} />
}

/**
 * A container as the canvas draws one, in what is chosen now: the same classes
 * the canvas's containers carry, so the same rules in `index.css` draw it.
 */
function Preview({ now }: { now: Appearance }) {
  return (
    <figure className="bg-background w-44 shrink-0 rounded-md p-2" aria-label="Preview of a container" data-appearance-preview={`${now.border}-${now.background ? 'on' : 'off'}`}>
      <div className="container-frame relative flex h-24 flex-col overflow-hidden rounded-lg border">
        <div className="container-grip bg-card flex h-6 shrink-0 items-center gap-1.5 border-b px-2 text-[10px]">
          <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
          <span className="truncate">A module</span>
        </div>
        <div className="flex-1" />
        <div className="container-footer bg-card flex h-5 shrink-0 items-center border-t px-2 text-[9px] text-muted-foreground">its footer</div>
      </div>
      <figcaption className="text-muted-foreground mt-1.5 text-center text-[10px]">Preview</figcaption>
    </figure>
  )
}

function BackgroundRow({ on, onChange }: { on: boolean; onChange(on: boolean): void }) {
  const id = useId()
  return (
    <div className="flex min-w-0 items-start justify-between gap-4 rounded-lg border px-4 py-3">
      <div className="min-w-0 space-y-1">
        <Label htmlFor={id} className="text-sm leading-snug">
          Container background
        </Label>
        <p id={`${id}-about`} className="text-muted-foreground text-xs leading-relaxed">
          On, the header, the footer and the space behind each module’s page are the card surface. Off, they are transparent over the canvas; a module that paints its own background still shows it.
        </p>
      </div>
      <Switch id={id} checked={on} onCheckedChange={onChange} aria-describedby={`${id}-about`} data-appearance="background" className="mt-0.5" />
    </div>
  )
}
