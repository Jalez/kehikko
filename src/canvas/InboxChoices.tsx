import { Button } from '@/components/ui/button.tsx'
import { cn } from '@/lib/utils'
import { Hint } from './Hint.tsx'

/**
 * Answers drawn as buttons under an Inbox item — the host's quick answers on a row, and a question's
 * choices in the row and the toast (`InboxQuestion`).
 *
 * They wrap onto as many lines as they need inside the panel or the toast, and a choice too long
 * for one line is cut with an ellipsis (`truncate`, `max-w-full`): nothing runs out sideways, at the
 * panel's narrowest too. The whole of it is the button's accessible name and its tooltip, which is
 * drawn to the LEFT of the button — away from the other answers, none of which it covers; a native
 * `title` would land under the pointer, on top of the next line of buttons.
 *
 * A choice is text, never markup or a link.
 */
export function InboxChoices({
  label,
  choices,
  disabled = false,
  inset = false,
  data,
}: {
  /** The group's accessible name. */
  label: string
  choices: readonly { label: string; run(): void }[]
  disabled?: boolean
  /** Indented under a row's label (the panel); flush in a toast. */
  inset?: boolean
  /** The `data-*` attribute the group carries, for whoever looks for it. */
  data: string
}) {
  return (
    <span
      role="group"
      aria-label={label}
      {...{ [`data-${data}`]: '' }}
      className={cn('flex max-w-full min-w-0 basis-full flex-wrap gap-1', inset && 'pl-4')}
    >
      {choices.map((choice, at) => (
        <Hint key={`${at}:${choice.label}`} side="left" label={<span className="block max-w-64 break-words whitespace-normal">{choice.label}</span>}>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={choice.label}
            data-inbox-choice=""
            disabled={disabled}
            className="block h-6 max-w-full min-w-0 shrink truncate px-2 text-left text-[11px]"
            onClick={choice.run}
          >
            {choice.label}
          </Button>
        </Hint>
      ))}
    </span>
  )
}
