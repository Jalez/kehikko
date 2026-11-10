import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { CANNOT_SEARCH, findBarMode, findCount, findCountShort, inputKeyOf, type FindBar as Bar } from '@/host/find.ts'

/**
 * The find bar over the top of a container's page (protocol 2.69.0): the same for every module.
 * An input, `3 of 17`, previous and next, case, close; at a narrow width the count is short and
 * under 220 pixels the case button goes (`findBarMode`). Every rule is in `host/find.ts`.
 *
 * Drawn over the page rather than above it: a row that pushed the page down would resize it, and a
 * terminal refits and redraws on every resize. It takes the pointer; the page beneath keeps its size.
 */
export function FindBar({
  bar,
  name,
  width,
  mac,
  onQuery,
  onCase,
  onStep,
  onClose,
}: {
  bar: Bar
  /** The module's name, for the input's label. */
  name: string
  /** The container's width, for how much the bar draws. */
  width: number | null
  mac: boolean
  onQuery(query: string): void
  onCase(caseSensitive: boolean): void
  onStep(direction: 'next' | 'prev'): void
  onClose(): void
}) {
  const input = useRef<HTMLInputElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  /* Focus to the input, its text selected, on opening and on every ⌘F while open. */
  useEffect(() => {
    if (!bar.open) return
    if (input.current) {
      input.current.focus()
      input.current.select()
    } else close.current?.focus()
  }, [bar.open, bar.focus, bar.result === 'unsupported'])

  if (!bar.open) return null
  const mode = findBarMode(width)
  const unsupported = bar.result === 'unsupported'
  const count = mode === 'wide' ? findCount(bar) : findCountShort(bar)
  const button = 'text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-6 shrink-0 cursor-default items-center justify-center rounded disabled:opacity-40'

  return (
    <div
      role="search"
      aria-label={`Find in ${name}`}
      data-find-bar=""
      data-mode={mode}
      className="bg-card pointer-events-auto absolute inset-x-0 top-0 z-20 flex h-8 items-center gap-1 border-b px-1.5 shadow-sm"
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        onClose()
      }}
    >
      {unsupported ? (
        <p className="text-muted-foreground min-w-0 flex-1 truncate px-1 text-xs" title={CANNOT_SEARCH} role="status">
          {CANNOT_SEARCH}
        </p>
      ) : (
        <>
          <input
            ref={input}
            type="text"
            value={bar.query}
            spellCheck={false}
            autoComplete="off"
            aria-label={`Find in ${name}`}
            placeholder="Find"
            className="bg-background focus-visible:ring-ring h-6 min-w-0 flex-1 rounded border px-1.5 text-xs outline-none focus-visible:ring-1"
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              const key = inputKeyOf(event, mac)
              if (key === null || key === 'open') return
              event.preventDefault()
              event.stopPropagation()
              if (key === 'close') onClose()
              else onStep(key)
            }}
          />
          <span className="text-muted-foreground shrink-0 px-0.5 text-[11px] tabular-nums" role="status" aria-live="polite">
            {count}
          </span>
          <button type="button" className={button} aria-label="Previous match" title="Previous match (⇧Enter)" disabled={!bar.query} onClick={() => onStep('prev')}>
            <ChevronUp className="size-3.5" />
          </button>
          <button type="button" className={button} aria-label="Next match" title="Next match (Enter)" disabled={!bar.query} onClick={() => onStep('next')}>
            <ChevronDown className="size-3.5" />
          </button>
          {mode === 'tight' ? null : (
            <button
              type="button"
              className={`${button} text-[11px] font-medium ${bar.caseSensitive ? 'bg-accent text-foreground' : ''}`}
              aria-label="Match case"
              aria-pressed={bar.caseSensitive}
              title="Match case"
              onClick={() => onCase(!bar.caseSensitive)}
            >
              Aa
            </button>
          )}
        </>
      )}
      <button ref={close} type="button" className={button} aria-label="Close find" title="Close (Escape)" onClick={onClose}>
        <X className="size-3.5" />
      </button>
    </div>
  )
}
