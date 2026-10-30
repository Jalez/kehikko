import { AlertTriangle, Bell, CheckCircle2, Info, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import type { Kind } from '@/host/chime.ts'
import { useChimeSettings } from '@/host/chimeStore.ts'
import { countWords, toastMs, toastWord, withToast, type Toast } from '@/host/toasts.ts'

/**
 * The Inbox toast, drawn: bottom right, a polite live region, at most three.
 * It holds the list it is given and nothing else. A toast stays until it is
 * dismissed unless the person chose a time; a timed toast times itself out, and
 * hover or keyboard focus on it pauses the timer. The words are plain text
 * (a module's label is never markup or a link), the kind is an icon AND a
 * word, and Open / Dismiss are the only controls. Dismiss closes the toast and
 * nothing more.
 */

const ICONS: Record<Kind, typeof Bell> = { urgent: AlertTriangle, attention: Bell, done: CheckCircle2, notice: Info }

function ToastCard({ toast, onOpen, onClose, ms }: { toast: Toast; onOpen(toast: Toast): void; onClose(id: number): void; ms: number | null }) {
  const Icon = ICONS[toast.kind]
  const left = useRef(ms ?? 0)
  const since = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const held = useRef({ hover: false, focus: false })

  const stop = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    if (since.current !== null) left.current = Math.max(0, left.current - (Date.now() - since.current))
    since.current = null
  }, [])
  const run = useCallback(() => {
    if (ms === null || timer.current !== null) return
    since.current = Date.now()
    timer.current = setTimeout(() => onClose(toast.id), left.current)
  }, [ms, onClose, toast.id])
  useEffect(() => {
    run()
    return stop
  }, [run, stop])

  const hold = (part: 'hover' | 'focus', on: boolean) => {
    held.current[part] = on
    if (held.current.hover || held.current.focus) stop()
    else run()
  }

  return (
    <div
      role="group"
      aria-label={`${toastWord(toast)}: ${toast.label}`}
      data-inbox-toast={toast.kind}
      data-count={toast.count}
      className="bg-popover text-popover-foreground pointer-events-auto flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg border p-3 shadow-lg"
      onMouseEnter={() => hold('hover', true)}
      onMouseLeave={() => hold('hover', false)}
      onFocus={() => hold('focus', true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hold('focus', false)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose(toast.id)
      }}
    >
      <div className="flex items-center gap-2 text-xs font-medium">
        <Icon className="size-4 shrink-0" aria-hidden />
        <span data-toast-kind data-toast-event={toast.says ? '' : undefined}>
          {toastWord(toast)}
        </span>
        {toast.count > 1 ? (
          <span className="text-muted-foreground" data-toast-count>
            {countWords(toast.count)}
          </span>
        ) : null}
      </div>
      <div className="min-w-0 space-y-0.5">
        <p className="text-muted-foreground truncate text-xs" data-toast-by>
          {toast.by}
        </p>
        <p className="line-clamp-2 text-sm leading-snug" data-toast-label>
          {toast.label}
        </p>
        <p className="text-muted-foreground truncate text-xs" data-toast-place>
          {toast.place}
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" onClick={() => onOpen(toast)} data-toast-open>
          Open
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => onClose(toast.id)} data-toast-dismiss>
          <X aria-hidden />
          Dismiss
        </Button>
      </div>
    </div>
  )
}

export function InboxToasts({
  toasts,
  onOpen,
  onClose,
  onCloseAll,
  scale = 1000,
}: {
  toasts: readonly Toast[]
  onOpen(toast: Toast): void
  onClose(id: number): void
  /** Closes every toast; offered when more than one shows. */
  onCloseAll(): void
  /** Milliseconds to a second: 1000 unless a test shortens it. */
  scale?: number
}) {
  const ms = toastMs(useChimeSettings().toastFor, scale)
  return (
    <div
      role="region"
      aria-label="New in the Inbox"
      aria-live="polite"
      aria-relevant="additions"
      data-inbox-toasts
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2"
    >
      {toasts.length > 1 ? (
        <Button type="button" size="sm" variant="secondary" className="pointer-events-auto" onClick={onCloseAll} data-toast-dismiss-all>
          <X aria-hidden />
          Dismiss all
        </Button>
      ) : null}
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onOpen={onOpen} onClose={onClose} ms={ms} />
      ))}
    </div>
  )
}

/** The toasts on screen and the way to add one (the oldest beyond three goes). */
export function useToastList(): { toasts: Toast[]; add(make: (id: number) => Toast | null): void; close(id: number): void; closeMany(ids: readonly number[]): void; closeAll(): void } {
  const [toasts, setToasts] = useState<Toast[]>([])
  const ids = useRef(0)
  const add = useCallback((make: (id: number) => Toast | null) => {
    const toast = make((ids.current += 1))
    if (toast) setToasts((was) => withToast(was, toast))
  }, [])
  const close = useCallback((id: number) => setToasts((was) => was.filter((one) => one.id !== id)), [])
  const closeMany = useCallback((ids: readonly number[]) => setToasts((was) => (ids.length ? was.filter((one) => !ids.includes(one.id)) : was)), [])
  const closeAll = useCallback(() => setToasts((was) => (was.length ? [] : was)), [])
  return { toasts, add, close, closeMany, closeAll }
}
