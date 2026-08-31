import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { Check } from 'lucide-react'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * shadcn's checkbox, vendored where shadcn puts it.
 *
 * One change from the generated file, and it was measured rather than guessed:
 * `size-3` rather than `size-4`, which is the size of every icon in the header
 * this sits in.
 *
 * The header is thirty-two pixels tall, already holds six controls and a name,
 * and at a two-hundred-and-twenty pixel container it has almost nothing left.
 * Measured there: the generated fourteen-pixel box pushed the row two pixels
 * past the width it had, which clips the far right of a header whose far right
 * is the button that takes the container off the canvas. Twelve costs nothing —
 * the name is the only thing that gives way and it was already truncating.
 *
 * It is still a `button` element underneath, which is what makes the dense rule
 * in `index.css` — written once, over `.container-grip[data-dense] button` —
 * shrink it along with everything else instead of needing a prop.
 */
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer border-input dark:bg-input/30 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:border-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 aria-invalid:border-destructive size-3 shrink-0 rounded-[4px] border shadow-xs transition-shadow outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current transition-none"
      >
        <Check className="size-2.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
