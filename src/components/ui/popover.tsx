import * as PopoverPrimitive from '@radix-ui/react-popover'
import * as React from 'react'

import { cn } from '@/lib/utils'
import { focusIsInFrame, useCloseOnFrameBlur } from '@/lib/menus'

function Popover({ open, defaultOpen, onOpenChange, ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  /* The root holds the open state itself, so the one hook can close the
     popover when the window loses focus to a module's page, as the menu root
     does — a press inside a frame is no pointerdown this document ever sees.
     See `src/lib/menus.ts`. */
  const [inner, setInner] = React.useState(defaultOpen ?? false)
  const isOpen = open ?? inner
  const change = React.useCallback(
    (next: boolean) => {
      if (open === undefined) setInner(next)
      onOpenChange?.(next)
    },
    [open, onOpenChange],
  )
  const close = React.useCallback(() => change(false), [change])
  useCloseOnFrameBlur(isOpen, close)
  return <PopoverPrimitive.Root data-slot="popover" open={isOpen} onOpenChange={change} {...props} />
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'bg-popover text-popover-foreground z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border p-4 shadow-md outline-hidden',
          className,
        )}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event)
          /* Focus has left for a module's page: the trigger does not take the keyboard back out of it. */
          if (focusIsInFrame(document)) event.preventDefault()
        }}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverContent, PopoverTrigger }
