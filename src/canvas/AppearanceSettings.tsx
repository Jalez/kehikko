import { useId, type ReactNode } from 'react'

import { Label } from '@/components/ui/label.tsx'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group.tsx'
import { Separator } from '@/components/ui/separator.tsx'
import {
  APPEARANCE_TARGET,
  ASKED,
  BACKGROUNDS,
  BACKGROUND_SAID,
  BORDERS,
  BORDER_SAID,
  COLLAPSES,
  COLLAPSE_CHOICES,
  EACH_SAID,
  collapseFor,
  COLLAPSE_SAID,
  FOLD_SAID,
  ROWS_SAID,
  THEME_CHOICES,
  THEME_SAID,
  type Appearance,
  type AppearancePatch,
  type BackgroundChoice,
  type Border,
  type Collapse,
  type CollapseChoice,
  type ThemeChoice,
} from '@/host/appearance.ts'
import { appearance as page, useAppearance, type AppearanceStore } from '@/host/appearanceStore.ts'
import { FOLD_ROWS, SHOW_ROWS, type FoldRows, type ShowRows } from '@/host/rows.ts'
import { TARGET_ATTR } from '@/host/settingsTarget.ts'
import { EXAMPLE_ID } from './appearanceExample.ts'
import { ModuleIcon } from './ModuleIcon.tsx'
import { AppearancePreview, usePeek } from './AppearancePreview.tsx'

/**
 * Settings › Appearance: how the app looks on this computer, the same for every
 * container (`host/appearance.ts`). Each choice is drawn at once — through the
 * attributes on `<html>`, never by re-rendering a module's frame — and then
 * saved (`{ appearance: … }`, `PAGE_ONLY`).
 *
 * One large preview (`AppearancePreview.tsx`) shows every choice as it is made:
 * above the questions, held in view while they scroll, and beside them when the
 * tab is wide enough. Each question is ONE radio group with a visible question
 * as its name (`aria-labelledby`), so the groups never read as one list.
 */
export function AppearanceSettings({
  onChange,
  store = page,
  modules = [],
}: {
  onChange(what: { appearance: AppearancePatch }): void
  store?: AppearanceStore
  /** The installed modules, for "Decide per module". */
  modules?: readonly { id: string; name: string }[]
}) {
  const now = useAppearance(store)
  const { peek, point, flash } = usePeek()
  const set = (patch: AppearancePatch) => {
    store.set({ ...store.get(), ...patch })
    onChange({ appearance: patch })
  }

  return (
    <div className="@container/appearance flex min-w-0 flex-col gap-5" data-appearance-settings>
      <header className="min-w-0 space-y-1 pr-16">
        <h3 id="settings-appearance" className="text-base font-semibold">
          Appearance
        </h3>
        <p className="text-muted-foreground text-xs leading-relaxed">
          How Kehikot looks on this computer. Each choice is the same for every container, and is drawn as soon as you make it.
        </p>
      </header>

      <div className="grid min-w-0 gap-6 @min-[52rem]/appearance:grid-cols-[minmax(0,1fr)_minmax(380px,1.1fr)] @min-[52rem]/appearance:items-start">
        <div className="bg-background z-10 min-w-0 pb-2 [@media(min-height:640px)]:sticky [@media(min-height:640px)]:top-0 @min-[52rem]/appearance:order-2">
          <AppearancePreview now={now} peek={peek} />
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <Group title="Header and footer">
            <div {...{ [TARGET_ATTR]: APPEARANCE_TARGET }} className="rounded-md transition-colors data-[lit=true]:bg-amber-500/10 data-[lit=true]:ring-2 data-[lit=true]:ring-amber-500/50">
              <Choices<ShowRows>
                name="rows"
                question={ASKED.rows}
                value={now.rows}
                options={SHOW_ROWS.map((mode) => ({ value: mode, label: ROWS_SAID[mode].label, line: ROWS_SAID[mode].line }))}
                onChange={(rows) => set({ rows })}
              />
            </div>
            <Choices<FoldRows>
              name="foldRows"
              question={ASKED.foldRows}
              about={ASKED.foldAbout}
              value={now.foldRows}
              options={FOLD_ROWS.map((rows) => ({ value: rows, label: FOLD_SAID[rows].label, line: FOLD_SAID[rows].line }))}
              onPoint={(rows) => point(rows === null ? null : { shape: 'fold', foldRows: rows })}
              onChange={(foldRows) => {
                set({ foldRows })
                flash({ shape: 'fold', foldRows })
              }}
            />
            <Choices<CollapseChoice>
              name="collapse"
              question={ASKED.collapse}
              value={now.collapse}
              options={COLLAPSE_CHOICES.map((collapse) =>
                collapse === 'each'
                  ? { value: collapse, label: EACH_SAID.label, line: EACH_SAID.line }
                  : { value: collapse, label: COLLAPSE_SAID[collapse].label, line: COLLAPSE_SAID[collapse].line },
              )}
              onPoint={(collapse) => point(collapse === null ? null : { shape: collapse === 'each' ? collapseFor(now, EXAMPLE_ID) : collapse })}
              onChange={(collapse) => {
                /* Whichever of fold and tile was picked last is what a module with no answer of its own does. */
                set(collapse === 'each' ? { collapse } : { collapse, collapseBase: collapse })
                flash({ shape: collapse === 'each' ? collapseFor({ ...now, collapse }, EXAMPLE_ID) : collapse })
              }}
            />
            {now.collapse === 'each' ? (
              <EachList
                now={now}
                modules={modules}
                onPick={(id, collapse) => {
                  set({ collapseEach: { ...now.collapseEach, [id]: collapse } })
                  if (id === EXAMPLE_ID) flash({ shape: collapse })
                }}
              />
            ) : null}
          </Group>

          <Separator />

          <Group title="Theme">
            <Choices<ThemeChoice>
              name="theme"
              question={ASKED.theme}
              about="System follows this computer’s setting."
              inline
              value={now.theme}
              options={THEME_CHOICES.map((theme) => ({ value: theme, label: THEME_SAID[theme] }))}
              onChange={(theme) => set({ theme })}
            />
          </Group>

          <Separator />

          <Group title="Containers">
            <Choices<Border>
              name="border"
              question={ASKED.border}
              inline
              value={now.border}
              options={BORDERS.map((border) => ({ value: border, label: BORDER_SAID[border], swatch: <BorderSwatch border={border} /> }))}
              onChange={(border) => set({ border })}
            />
            <Choices<BackgroundChoice>
              name="background"
              question={ASKED.background}
              value={now.background ? 'card' : 'transparent'}
              options={BACKGROUNDS.map((choice) => ({ value: choice, label: BACKGROUND_SAID[choice].label, line: BACKGROUND_SAID[choice].line }))}
              onChange={(choice) => set({ background: choice === 'card' })}
            />
          </Group>
        </div>
      </div>
    </div>
  )
}

/** "Decide per module": every installed module, each with its own Fold / Tile choice. */
function EachList({
  now,
  modules,
  onPick,
}: {
  now: Appearance
  modules: readonly { id: string; name: string }[]
  onPick(id: string, collapse: Collapse): void
}) {
  const id = useId()
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-collapse-each>
      <p className="text-sm font-medium">{EACH_SAID.list}</p>
      {modules.length === 0 ? <p className="text-muted-foreground text-xs">No modules installed.</p> : null}
      <ul className="flex min-w-0 flex-col gap-1">
        {modules.map((module) => (
          <li key={module.id} className="flex min-w-0 items-center gap-2" data-collapse-module={module.id}>
            <ModuleIcon id={module.id} name={module.name} />
            <span className="min-w-0 flex-1 truncate text-xs">{module.name}</span>
            <RadioGroup
              aria-label={`What ^ does in ${module.name}`}
              data-collapse-of={module.id}
              value={collapseFor(now, module.id)}
              onValueChange={(picked) => onPick(module.id, picked as Collapse)}
              className="flex gap-3"
            >
              {COLLAPSES.map((collapse) => (
                <div key={collapse} className="flex items-center gap-1.5">
                  <RadioGroupItem id={`${id}-${module.id}-${collapse}`} value={collapse} data-choice={collapse} />
                  <Label htmlFor={`${id}-${module.id}-${collapse}`} className="cursor-pointer text-xs font-normal">
                    {collapse === 'fold' ? 'Fold' : 'Tile'}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-5">
      <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{title}</h4>
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

/**
 * One question: its sentence, shown, naming ONE radio group with one value. Each option is a radio
 * and a label wired by `htmlFor`, so the whole row picks it; arrows move within the group.
 */
function Choices<T extends string | number>({
  name,
  question,
  about,
  value,
  options,
  onChange,
  onPoint,
  inline = false,
}: {
  name: keyof Appearance
  question: string
  about?: string
  value: T
  options: readonly Option<T>[]
  onChange(value: T): void
  /** The pointer is over an option (or has left them all: `null`), for the preview to show it. */
  onPoint?(value: T | null): void
  inline?: boolean
}) {
  const id = useId()
  return (
    <div className="flex min-w-0 flex-col gap-2.5" data-question={name}>
      <div className="space-y-0.5">
        <p id={`${id}-q`} className="text-sm font-medium">
          {question}
        </p>
        {about ? (
          <p id={`${id}-about`} className="text-muted-foreground text-xs leading-relaxed">
            {about}
          </p>
        ) : null}
      </div>
      <RadioGroup
        aria-labelledby={`${id}-q`}
        aria-describedby={about ? `${id}-about` : undefined}
        data-appearance={name}
        value={String(value)}
        onValueChange={(picked) => {
          const option = options.find((one) => String(one.value) === picked)
          if (option && option.value !== value) onChange(option.value)
        }}
        onPointerLeave={onPoint ? () => onPoint(null) : undefined}
        className={inline ? 'flex flex-wrap gap-x-5 gap-y-2.5' : 'gap-2.5'}
      >
        {options.map((option) => (
          <div
            key={String(option.value)}
            className="flex min-w-0 items-start gap-2.5"
            onPointerEnter={onPoint ? () => onPoint(option.value) : undefined}
          >
            <RadioGroupItem id={`${id}-${option.value}`} value={String(option.value)} data-choice={String(option.value)} className="mt-0.5" />
            <Label htmlFor={`${id}-${option.value}`} className="flex min-w-0 cursor-pointer flex-col items-start gap-0.5 font-normal">
              <span className="flex items-center gap-2 text-sm leading-snug">
                {option.swatch}
                {option.label}
              </span>
              {option.line ? <span className="text-muted-foreground text-xs leading-relaxed">{option.line}</span> : null}
            </Label>
          </div>
        ))}
      </RadioGroup>
    </div>
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
