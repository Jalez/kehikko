import { LoaderCircle } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { cn } from '@/lib/utils.ts'

/**
 * The app's loading effect: the lucide `LoaderCircle`, muted and turning, with
 * a short label. One component so every wait looks the same; a wait shown only
 * as words can read as frozen. Reduced motion keeps the icon and drops the
 * turning (`motion-safe:`), and the label says what is going on either way.
 *
 * `role="status"` with `aria-live="polite"` so a screen reader hears it once.
 */
export function Loading({
  label,
  className,
  iconClassName,
  children,
}: {
  label: ReactNode
  className?: string
  /** The icon's size, `size-3.5` by default. */
  iconClassName?: string
  /** Under the label: a quiet extra line, such as a slow-answer note. */
  children?: ReactNode
}) {
  return (
    <span role="status" aria-live="polite" data-loading className={cn('text-muted-foreground flex min-w-0 items-start gap-2 text-xs', className)}>
      <LoaderCircle className={cn('mt-px shrink-0 motion-safe:animate-spin', iconClassName ?? 'size-3.5')} aria-hidden />
      <span className="min-w-0 break-words">
        <span>{label}</span>
        {children}
      </span>
    </span>
  )
}

/** A pulsing placeholder bar in the muted token; still under reduced motion. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden data-skeleton className={cn('bg-muted rounded-md motion-safe:animate-pulse', className)} />
}

/** How long a wait runs before it is said to be slow. */
export const SLOW_AFTER_MS = 8000

/** True once `active` has held for `after` ms; false again as soon as it stops. */
export function useSlow(active: boolean, after: number = SLOW_AFTER_MS): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    setSlow(false)
    if (!active) return
    const timer = setTimeout(() => setSlow(true), after)
    return () => clearTimeout(timer)
  }, [active, after])
  return active && slow
}
