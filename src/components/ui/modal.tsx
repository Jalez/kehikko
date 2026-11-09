import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import * as React from 'react'

import { cn } from '@/lib/utils'

import { DialogContent, DialogDescription, DialogTitle } from './dialog'

/**
 * The one layout every host window uses: a header row, a body, and an optional footer.
 *
 *   ┌──────────────────────────────────────────┐
 *   │ ◇ Title  context                      ×  │  ModalHeader: never scrolls
 *   │ description                              │
 *   ├──────────────────────────────────────────┤
 *   │ …                                        │  ModalBody: the only thing that scrolls
 *   ├──────────────────────────────────────────┤
 *   │                       [Cancel] [Do it]   │  ModalFooter: never scrolls
 *   └──────────────────────────────────────────┘
 *
 * The close button is IN the header row, not floating over the content, so
 * nothing a window shows can come to lie on top of it. The window is a flex
 * column capped at the viewport's height; the body has `min-h-0` and is the one
 * element with `overflow-y-auto`. A window whose body holds its own scrolling
 * regions (a list beside a pane) passes `scroll={false}` and scrolls those.
 *
 * Radix gives the rest: the dialog role, `aria-labelledby` on the header's
 * title, the focus trap and Escape. The close button is first in tab order in
 * every window; on opening, focus goes to the first thing in the body or the
 * footer instead, as it did when the close was last.
 *
 * The data attributes (`data-modal-header`, `-close`, `-body`, `-footer`) are
 * what the tests read, since a test DOM has no layout.
 */

const TABBABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function firstTabbable(root: Element | null): HTMLElement | null {
  if (!root) return null
  for (const one of root.querySelectorAll<HTMLElement>(TABBABLE)) {
    if (one.closest('[hidden], [aria-hidden="true"], [data-state="inactive"][role="tabpanel"]')) continue
    return one
  }
  return null
}

function ModalContent({
  className,
  onOpenAutoFocus,
  ...props
}: Omit<React.ComponentProps<typeof DialogContent>, 'showClose'>) {
  return (
    <DialogContent
      showClose={false}
      data-modal=""
      className={cn('flex max-h-[calc(100dvh-2rem)] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0', className)}
      onOpenAutoFocus={(event) => {
        onOpenAutoFocus?.(event)
        if (event.defaultPrevented) return
        const content = event.currentTarget as HTMLElement | null
        const first =
          firstTabbable(content?.querySelector('[data-modal-body]') ?? null) ??
          firstTabbable(content?.querySelector('[data-modal-footer]') ?? null)
        if (!first) return
        event.preventDefault()
        first.focus()
      }}
      {...props}
    />
  )
}

function ModalHeader({
  title,
  icon,
  context,
  description,
  className,
  titleClassName,
  descriptionClassName,
  children,
}: {
  title: React.ReactNode
  /** Drawn before the title, inside it. */
  icon?: React.ReactNode
  /** A short fact beside the title: a version, a date, "3 updates". The description when there is none. */
  context?: React.ReactNode
  /** A sentence under the title. */
  description?: React.ReactNode
  className?: string
  titleClassName?: string
  descriptionClassName?: string
  /** Anything else that belongs to the header, under the description. */
  children?: React.ReactNode
}) {
  const said = description === undefined || description === null ? null : description
  return (
    <header data-modal-header="" className={cn('bg-background flex shrink-0 items-start gap-2 border-b py-3 pr-3 pl-4 sm:pl-5', className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <DialogTitle className={cn('flex min-w-0 items-center gap-2 text-sm [overflow-wrap:anywhere]', titleClassName)}>
            {icon}
            {title}
          </DialogTitle>
          {context === undefined || context === null ? null : said === null ? (
            <DialogDescription data-modal-context="" className="text-xs tabular-nums">
              {context}
            </DialogDescription>
          ) : (
            <span data-modal-context="" className="text-muted-foreground text-xs tabular-nums">
              {context}
            </span>
          )}
        </div>
        {said === null ? null : (
          <DialogDescription className={cn('text-xs leading-snug [overflow-wrap:anywhere]', descriptionClassName)}>{said}</DialogDescription>
        )}
        {children}
      </div>
      <DialogPrimitive.Close
        data-modal-close=""
        className="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring -my-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-hidden"
      >
        <XIcon className="size-4" aria-hidden />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </header>
  )
}

function ModalBody({
  className,
  scroll = true,
  ...props
}: React.ComponentProps<'div'> & {
  /** False when the body holds scrolling regions of its own and must not scroll itself. */
  scroll?: boolean
}) {
  return (
    <div
      data-modal-body=""
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col',
        scroll ? 'gap-4 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-4 sm:px-5' : 'overflow-hidden',
        className,
      )}
      {...props}
    />
  )
}

function ModalFooter({ className, ...props }: React.ComponentProps<'footer'>) {
  return (
    <footer
      data-modal-footer=""
      className={cn('bg-background flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-4 py-3 sm:px-5', className)}
      {...props}
    />
  )
}

export { ModalBody, ModalContent, ModalFooter, ModalHeader }
