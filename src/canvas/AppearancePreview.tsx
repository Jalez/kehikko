import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { FooterItem, HeaderItem } from 'kehikot-module-protocol'

import { Label } from '@/components/ui/label.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { collapseFor, type Appearance, type Collapse } from '@/host/appearance.ts'
import { EXAMPLE_ID } from './appearanceExample.ts'
import { fixedFooter } from '@/host/footerStore.ts'
import type { Pressed, Pressing } from '@/host/header.ts'
import { LONG_PRESS_MS, rowsHide, type FoldRows, type ShowRows } from '@/host/rows.ts'
import { FoldControl } from './FoldControl.tsx'
import { FooterBar } from './FooterBar.tsx'
import { HeaderMenus } from './HeaderMenus.tsx'
import { ModuleIcon } from './ModuleIcon.tsx'
import { TileFace } from './Tile.tsx'

/**
 * Settings › Appearance's preview: one or two example containers, drawn with the canvas's own parts
 * (`FoldControl`, `HeaderMenus`, `FooterBar`, `TileFace`) and its own classes (`.container-frame`,
 * `.container-reveal`, `.container-grip`, `.container-footer-reveal`), so the same rules in
 * `index.css` draw them: the border and background on `<html>`, the theme's class, and the
 * hidden-rows rules (scoped to `.react-grid-item` or `[data-appearance-stage]`).
 *
 * Every choice shows on it as it is made. Its header and footer reveal as the setting says — hover,
 * click, or press and hold on the example — and its ^ folds it or makes it a tile, with the restore
 * the canvas has. It is not a module and loads nothing; it holds only its own fold and reveal.
 */

/** A shape the preview takes for a moment, while a fold choice is pointed at or just made. */
export interface Peek {
  shape: Collapse
  foldRows?: FoldRows
}

const PEEK_FOR_MS = 1800

/** Show a peek for a moment after a choice is made. One timer, restarted by the next. */
export function usePeek(): { peek: Peek | null; point(peek: Peek | null): void; flash(peek: Peek): void } {
  const [peek, setPeek] = useState<Peek | null>(null)
  const timer = useRef<number | null>(null)
  const stop = () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => stop, [])
  return {
    peek,
    point: (next) => {
      stop()
      setPeek(next)
    },
    flash: (next) => {
      stop()
      setPeek(next)
      timer.current = window.setTimeout(() => {
        timer.current = null
        setPeek(null)
      }, PEEK_FOR_MS)
    },
  }
}

const TRY: Readonly<Record<ShowRows, string>> = {
  always: 'Press ^ in its header to see what the button does.',
  hover: 'Point at the example to show its header and footer. Press ^ to see what the button does.',
  click: 'Click inside the example to show its header and footer; Escape or a click elsewhere hides them.',
  longpress: 'Press and hold inside the example to show its header and footer; Escape or a click elsewhere hides them.',
}

export function AppearancePreview({ now, peek = null }: { now: Appearance; peek?: Peek | null }) {
  const [two, setTwo] = useState(false)
  const id = useId()
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 flex-col gap-2"
      data-appearance-preview={`${now.border}-${now.background ? 'on' : 'off'}`}
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h4 id={`${id}-title`} className="text-sm font-medium">
          Preview
        </h4>
        <div className="flex items-center gap-2">
          <Label htmlFor={`${id}-two`} className="text-muted-foreground text-xs font-normal">
            Two side by side
          </Label>
          <Switch id={`${id}-two`} checked={two} onCheckedChange={setTwo} data-preview-two />
        </div>
      </div>
      <div data-appearance-stage className="flex min-h-[272px] min-w-0 items-start gap-3 overflow-hidden rounded-lg border p-4">
        <Example now={now} peek={peek} which="first" name="Example module" icon="chart-column" />
        {two ? <Example now={now} peek={peek} which="second" name="Another module" icon="list-todo" /> : null}
      </div>
      <p className="text-muted-foreground text-xs leading-relaxed" data-preview-try>
        {TRY[now.rows]}
      </p>
    </section>
  )
}

const VIEWS = [
  { id: 'list', label: 'List' },
  { id: 'chart', label: 'Chart' },
]

const FOOTER: readonly FooterItem[] = [
  { kind: 'text', id: 'status', text: 'Synced 2 min ago' },
  { kind: 'meter', id: 'usage', label: 'Usage', value: 0.42, align: 'end' },
] as unknown as FooterItem[]

const ROWS = ['Write the release note', 'Read the open change', 'Answer the question in the inbox', 'Plan the next part']
const BARS = [0.45, 0.7, 0.35, 0.9, 0.6, 0.8]

/** One example container. Its fold, tile, reveal and view are its own and are never saved. */
function Example({ now, peek, which, name, icon }: { now: Appearance; peek: Peek | null; which: string; name: string; icon: string }) {
  const [shut, setShut] = useState<Collapse | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [view, setView] = useState('list')
  const frame = useRef<HTMLDivElement>(null)
  const held = useRef<number | null>(null)

  const shape = peek?.shape ?? shut
  const foldRows = (peek?.shape === 'fold' ? peek.foldRows : undefined) ?? now.foldRows
  const collapsed = shape === 'fold'
  const tiled = shape === 'tile'
  const hide = rowsHide(now.rows)
  const mode = now.rows

  /* A new mode starts hidden, as the canvas does. */
  useEffect(() => setRevealed(false), [mode])

  /* Click and press-and-hold close as the canvas's do: Escape, or a press anywhere else. */
  useEffect(() => {
    if (!revealed || (mode !== 'click' && mode !== 'longpress')) return
    const away = (event: PointerEvent) => {
      if (!frame.current?.contains(event.target as Node)) setRevealed(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setRevealed(false)
    }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [revealed, mode])

  const letGo = () => {
    if (held.current !== null) window.clearTimeout(held.current)
    held.current = null
  }
  useEffect(() => letGo, [])

  const handlers = {
    onPointerEnter: () => mode === 'hover' && setRevealed(true),
    onPointerLeave: () => {
      letGo()
      if (mode === 'hover') setRevealed(false)
    },
    onClick: () => mode === 'click' && setRevealed(true),
    onPointerDown: (event: ReactPointerEvent) => {
      if (mode !== 'longpress' || event.button !== 0) return
      letGo()
      held.current = window.setTimeout(() => {
        held.current = null
        setRevealed(true)
      }, LONG_PRESS_MS)
    },
    onPointerUp: letGo,
    onPointerCancel: letGo,
  }

  const items: HeaderItem[] = [{ kind: 'switch', id: 'view', label: 'View', icon: 'eye', value: view, options: VIEWS }] as unknown as HeaderItem[]
  const pressed = (press: Pressing): Promise<Pressed> => {
    if (press.item === 'view' && typeof press.value === 'string') setView(press.value)
    return Promise.resolve({ ok: true, why: '' })
  }
  const footerPressed = (): Promise<Pressed> => Promise.resolve({ ok: true, why: '' })
  const shown = revealed ? 'true' : undefined

  const size = tiled ? 'size-40 shrink-0' : collapsed ? `${foldRows === 2 ? 'h-16' : 'h-8'} min-w-0 flex-1` : 'h-60 min-w-0 flex-1'

  return (
    <div
      ref={frame}
      className={`container-frame @container/container relative flex flex-col overflow-hidden rounded-lg border ${size}`}
      data-preview-container={which}
      data-rows={hide ? 'hide' : undefined}
      data-rows-mode={mode}
      data-fold={collapsed ? foldRows : undefined}
      data-tiled={tiled ? 'host' : undefined}
      data-revealed={shown}
      {...handlers}
    >
      <div
        className={collapsed ? 'container-reveal min-h-0 flex-1' : 'container-reveal shrink-0'}
        data-collapsed={collapsed ? 'true' : undefined}
        data-revealed={shown}
        data-tiled={tiled ? 'true' : undefined}
      >
        <header
          data-dense={collapsed ? 'true' : undefined}
          className={
            collapsed
              ? 'container-grip bg-card flex h-full items-center gap-1.5 px-2 select-none @max-[300px]/container:gap-1'
              : 'container-grip bg-card flex h-8 shrink-0 items-center gap-2 border-b px-2.5 select-none @max-[300px]/container:gap-1'
          }
        >
          <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
          <ModuleIcon icon={icon} name={name} />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{name}</span>
          {tiled ? null : <HeaderMenus items={items} name={name} onPress={pressed} />}
          <FoldControl
            collapsed={collapsed}
            tiled={tiled}
            makes={collapseFor(now, EXAMPLE_ID)}
            foldedBy={null}
            rows={foldRows}
            onCollapse={(fold) => setShut(fold ? 'fold' : null)}
            onTile={(tile) => setShut(tile ? 'tile' : null)}
          />
        </header>
      </div>

      {tiled ? (
        <div className="relative min-h-0 flex-1">
          <TileFace id={`appearance-preview-${which}`} icon={icon} name={name} footer={fixedFooter(FOOTER)} onExpand={() => setShut(null)} />
        </div>
      ) : collapsed ? (
        foldRows === 2 ? (
          <div className="container-footer-reveal min-h-0 flex-1" data-collapsed="true" data-revealed={shown}>
            <FooterBar items={FOOTER} name={name} onPress={footerPressed} dense />
          </div>
        ) : null
      ) : (
        <>
          {/* Where the module's page is. This one paints no background of its own, so the setting shows through it. */}
          <div className={`min-h-0 flex-1 overflow-hidden p-3 text-xs ${now.background ? 'bg-card' : ''}`} data-preview-body={view}>
            {view === 'list' ? (
              <ul className="flex flex-col gap-1.5">
                {ROWS.map((row, n) => (
                  <li key={row} className="flex min-w-0 items-center gap-2">
                    <span className={`size-3 shrink-0 rounded-sm border ${n === 1 ? 'bg-primary border-primary' : ''}`} aria-hidden />
                    <span className="truncate">{row}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex h-full items-end gap-2 pb-1" aria-label="A chart">
                {BARS.map((bar, n) => (
                  <span key={n} className="bg-primary/70 flex-1 rounded-t-sm" style={{ height: `${bar * 100}%` }} />
                ))}
              </div>
            )}
          </div>
          <div className="container-footer-reveal shrink-0" data-revealed={shown}>
            <FooterBar items={FOOTER} name={name} onPress={footerPressed} />
          </div>
        </>
      )}
    </div>
  )
}
