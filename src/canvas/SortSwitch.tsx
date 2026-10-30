import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'

import { DropdownMenuRadioGroup } from '@/components/ui/dropdown-menu.tsx'
import { SORTS, SORT_WORDS, type Picker, type PickerSort } from '@/host/pickerOrder.ts'
import { setSort, usePickerSort } from '@/host/pickerStore.ts'

/**
 * The order of one picker's list: "A–Z" or "Recent", a two-part switch at the
 * top of the dropdown, under its heading.
 *
 * Made of the menu's own radio items rather than loose buttons, because a menu
 * takes the keyboard — Tab never leaves it — and only its items are reached by
 * the arrow keys. Each press keeps the menu open, so the list is seen
 * reordering. The state is announced twice: each item says it is checked, and a
 * status line says the order in words. Each picker keeps its own choice; the
 * three lists differ (epics are named, kehikot are worked in), so one shared
 * switch would be wrong for one of them.
 */
export function SortSwitch({ picker, label }: { picker: Picker; label: string }) {
  const sort = usePickerSort(picker)
  const pick = (next: PickerSort) => {
    if (next !== sort) void setSort(picker, next).catch(() => undefined)
  }
  return (
    <div data-sort-switch={picker} className="px-1 pb-1">
      <DropdownMenuRadioGroup value={sort} onValueChange={(value) => pick(value as PickerSort)} aria-label={`order of ${label}`} className="bg-muted flex gap-0.5 rounded-md p-0.5">
        {SORTS.map((one) => (
          <DropdownMenuPrimitive.RadioItem
            key={one}
            value={one}
            onSelect={(event) => event.preventDefault()}
            title={SORT_WORDS[one].says}
            className="focus:bg-accent focus:text-accent-foreground data-[state=checked]:bg-background data-[state=checked]:font-medium data-[state=checked]:shadow-sm flex min-w-0 flex-1 cursor-default items-center justify-center truncate rounded-sm px-2 py-1 text-[11px] outline-hidden select-none"
          >
            {SORT_WORDS[one].label}
          </DropdownMenuPrimitive.RadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <span role="status" className="sr-only">
        {label} ordered {SORT_WORDS[sort].says}
      </span>
    </div>
  )
}
