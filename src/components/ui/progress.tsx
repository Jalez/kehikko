import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * shadcn's Progress, written from its source without the Radix primitive: a
 * track and an indicator, `role="progressbar"`. `value` is 0–100; null or
 * undefined is indeterminate — a short bar sliding across, for a step that
 * cannot say how far it has got.
 */
function Progress({ className, value, ...props }: Omit<React.ComponentProps<'div'>, 'children'> & { value?: number | null }) {
  const known = typeof value === 'number' && Number.isFinite(value)
  const at = known ? Math.max(0, Math.min(100, value)) : null
  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      {...(at !== null ? { 'aria-valuenow': Math.round(at) } : {})}
      data-state={at === null ? 'indeterminate' : at >= 100 ? 'complete' : 'loading'}
      className={cn('bg-primary/20 relative h-1.5 w-full overflow-hidden rounded-full', className)}
      {...props}
    >
      <div
        data-slot="progress-indicator"
        className={cn('bg-primary h-full rounded-full transition-all', at === null ? 'progress-indeterminate w-1/3' : 'w-full flex-1')}
        style={at === null ? undefined : { transform: `translateX(-${100 - at}%)` }}
      />
    </div>
  )
}

export { Progress }
