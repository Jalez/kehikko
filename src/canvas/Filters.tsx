import { Filter } from 'lucide-react'
import { own, type FilterGroup } from 'roadmap-module-protocol'

import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { narrowed, type Choice } from '@/host/filters.ts'
import { Hint } from './Hint.tsx'

/**
 * The one control a module can put in its own container's header.
 *
 * A module says what it can be narrowed by; the host draws this; a press goes
 * back as `context.filters`. Nothing here knows what any of it means — see
 * `host/filters.ts` and the protocol's essay on `filterOptionSchema`.
 *
 * ## Absent by default, and that is the whole shape of the feature
 *
 * A module that offers nothing renders `null` here, and a header with this in
 * it is byte-for-byte the header it was before for every module that has not
 * said anything. Not a disabled button, not an empty menu, not a reserved
 * twenty-four pixels. The same discipline `ToolsMark` keeps for a module with
 * no MCP door, and for the same reason: a control that opens something empty
 * wastes a press every time it is pressed, and a header full of controls that
 * do nothing is a header nobody reads.
 *
 * ## A button, not a row, because the point was to give space back
 *
 * The five modules this replaces each drew their own toggle inside their own
 * page, in a column that is routinely 220 pixels wide and under 300 tall. A
 * control strip is a fixed row of chrome competing with the thing somebody
 * opened the module to look at. Moving that to a permanent strip in the header
 * would have moved the cost rather than removed it, so this is one
 * twenty-four-pixel button that opens a menu — quiet when nobody is using it,
 * which is what "put it aside" means.
 *
 * ## No module string is ever laid out in the header
 *
 * The button carries an icon and nothing else. Every label the module wrote —
 * group names, option names, counts — appears inside the menu, which is a
 * floating layer with its own width, and each one truncates with the whole
 * thing in a `title`.
 *
 * This is stricter than truncating would have been, and deliberately so. A
 * `whitespace-nowrap` element carrying a variable string puts a min-content
 * floor under every flex and grid ancestor it has: a sibling module in this
 * workspace put one in a badge and gave a 220-pixel container an 1187-pixel
 * floor, which does not read as a badge bug — it reads as the whole window
 * refusing to be narrow. `Bar.tsx` and `Tools.tsx` both have the long version.
 * The header is a flex row with six controls and a truncating name already, and
 * the cheapest way to be certain a stranger's string cannot widen it is for no
 * stranger's string to be in it.
 *
 * There is no `Badge` in this file and there must not be. shadcn's badge is
 * `whitespace-nowrap` in its base.
 *
 * ## What the icon says, which is the only thing the host can honestly say
 *
 * Foreground weight when something is narrowed, muted when nothing is — the
 * same two states the pin, the height toggle and the prompt button use, so it
 * reads as one more control of the kind already there rather than a new
 * language.
 *
 * That mark is the always-visible signal that something is being hidden, and it
 * is worth being plain about what it costs. A module drawing its own toggle
 * could say `show 3 ignored` on screen at all times; with the control in the
 * header the 3 is one press away, in the menu, in the module's own words. The
 * host cannot make up the difference: it sees rows it does not render, in a
 * document it cannot read, in a frame on another origin. A module for which the
 * exact number must be visible without a press should go on drawing that number
 * in its own page — nothing here stops it, and the two are not in conflict,
 * because what moves to the header is the CONTROL and not the reporting.
 */
export function FilterButton({
  groups,
  chosen,
  name,
  onChoose,
  onEverything,
}: {
  /** What the module is offering right now. Empty means no control at all. */
  groups: readonly FilterGroup[]
  /** Group id to option id, already reconciled against `groups`. */
  chosen: Choice
  /** The module's name, for the sentence somebody reads before pressing. */
  name: string
  onChoose(group: string, option: string): void
  /** Put every group back to its module's own resting option. */
  onEverything(): void
}) {
  if (groups.length === 0) return null

  const on = narrowed(groups, chosen)

  return (
    <DropdownMenu>
      <Hint
        label={
          on
            ? `${name} is showing less than everything. Press to change what it shows, or to put it all back`
            : `choose what ${name} shows`
        }
        side="left"
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={on ? `what ${name} shows — narrowed` : `what ${name} shows`}
            aria-pressed={on}
            className={
              on
                ? 'text-foreground pointer-events-auto size-6 cursor-default'
                : 'text-muted-foreground hover:text-foreground pointer-events-auto size-6 cursor-default'
            }
            /* Stops the grid reading the press as the start of a drag, which
               would make this button unpressable — see `Container.tsx`. */
            onMouseDown={(event) => event.stopPropagation()}
          >
            <Filter className="size-3" />
          </Button>
        </DropdownMenuTrigger>
      </Hint>

      {/*
       * Bounded in width and never by its contents.
       *
       * A menu that sized itself to its widest item would be a menu a module
       * decides the width of, which is the same hazard as the header one step
       * removed — this floats over the canvas, so it cannot push a container
       * about, but it can cover half the screen because somebody wrote a long
       * option. `max-w` plus a truncating item is the whole defence, and the
       * protocol's `FILTER_LABEL` is what keeps the truncation from ever having
       * a document to do it to.
       */}
      <DropdownMenuContent align="end" className="max-w-56 min-w-44">
        {groups.map((group, index) => (
          <div key={group.id}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className="text-muted-foreground min-w-0 truncate text-[11px] font-normal">
              <Label text={group.label} />
            </DropdownMenuLabel>
            {/* Items with a tick rather than Radix's own radio group, which is
                what every other menu in this host uses — one vocabulary of menu
                parts, and one place the tick is drawn. */}
            {group.options.map((option) => (
              <DropdownMenuItem
                key={option.id}
                className="min-w-0 cursor-default text-xs"
                onSelect={() => onChoose(group.id, option.id)}
              >
                <DropdownMenuCheck checked={(own(chosen, group.id) ?? group.fallback) === option.id} />
                <Label text={option.label} />
              </DropdownMenuItem>
            ))}
          </div>
        ))}

        {/*
         * One press that puts everything back, shown only when there is
         * something to put back.
         *
         * The modules that grew these controls held themselves to this already,
         * and it is the reason `fallback` is a field: a narrowed view has to
         * have a way out that does not require remembering which of four things
         * you changed. The host can offer it without understanding anything,
         * because each group's module named its own resting option.
         *
         * Host words, deliberately — this item is the one thing in the menu no
         * module wrote, and it must not disappear into a list of a stranger's
         * phrases.
         */}
        {on ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="cursor-default text-xs" onSelect={() => onEverything()}>
              <DropdownMenuCheck checked={false} />
              Show everything
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * One string a module wrote, on screen, in the only way it is allowed to be.
 *
 * Every module-authored label in this file goes through here, and that is the
 * point of it existing at all rather than being three attributes repeated at
 * three call sites: there is one place to check, and a test can render it with
 * four thousand characters and assert that none of them reach the layout.
 *
 * `min-w-0` as well as `truncate`, because `truncate` alone does nothing inside
 * a flex child that has not been told it may shrink — which is exactly the
 * shape of the bug that put an 1187-pixel floor under a container in this
 * workspace. The full text is in the `title`, which is where a long label
 * belongs and where a person can still read it.
 */
export function Label({ text }: { text: string }) {
  return (
    <span className="block min-w-0 truncate" title={text}>
      {text}
    </span>
  )
}
