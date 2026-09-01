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
 * twenty-four-pixel button that opens a menu — small when nobody is using it,
 * which is what "put it aside" means.
 *
 * Small, and deliberately not DIM. That distinction is a correction: what the
 * five modules were paying was a ROW OF CHROME, and giving that back is not the
 * same as making the control hard to notice. For a while this file confused the
 * two, drew the button muted, and the person who owns this host went looking
 * for a filter and could not find one. See two sections down.
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
 * ## What it is CALLED, which is the half that was missing
 *
 * Its accessible name used to be "what Notifications shows". Every word of that
 * is true and the control was still, in practice, not there: the person who
 * owns this host was told a filter existed, went looking for one, and reported
 * it missing. It was in front of them. A row of seven unlabelled icons offers
 * no way in except by name, and nobody hunting for a filter searches for the
 * phrase "what Notifications shows" — the one word that would have found it
 * appeared nowhere on the screen, in any tooltip, or in any accessible name.
 *
 * So the name now begins with the word: "filter what Notifications shows". The
 * module's name stays in it, because it is what distinguishes six otherwise
 * identical-looking icon buttons from each other when they are read out one
 * after another, and every other control in this header does the same.
 *
 * This workspace has removed a control for exactly this failure before — the
 * refresh button in `Bar.tsx`, which still has the essay: a control nobody can
 * name is a control that is pressed by accident or never at all. That one was
 * deleted because its capability could be done without a button. This one
 * cannot; it is renamed instead, which is the other half of the same rule.
 *
 * ## What the icon says, and why it is not the usual two states
 *
 * The other icons in this header are muted when off and foreground when on,
 * and this one followed them: muted with an offer and nothing chosen,
 * foreground when narrowed. That is a departure now, and the departure is the
 * point rather than an oversight.
 *
 * The difference is what "off" means. A pin, a fold and a height toggle are on
 * EVERY container, in one of two states, so their weight is the only thing
 * distinguishing the states and muted is the right way to say "not on". This
 * button is on almost no containers: its presence is itself the message, and
 * the message is "this module can be narrowed", which is a thing a person
 * cannot know any other way. Drawn muted, that message was delivered as the
 * fifth grey icon in a row of grey icons — which is to say it was not
 * delivered. A container with an offer and no choice made was indistinguishable
 * at a glance from a container with nothing to filter at all.
 *
 * So weight now says "there is something here" and is on whenever the control
 * is drawn, and the second state is said with FILL: an outline funnel when the
 * module is showing everything, a solid one when it is not. That costs zero
 * pixels, which is the constraint that ruled everything else out — the header
 * is a flex row with six controls and a truncating name in a container that is
 * routinely 220 pixels wide, and the surplus there was clipping the remove
 * button until recently. A dot, a count or a word beside the icon would each
 * have bought legibility back with the pixels that fix cost.
 *
 * The fill is the always-visible signal that something is being hidden, and it
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
  const said = saying(name, on)

  return (
    <DropdownMenu>
      <Hint label={said.hint} side="left">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={said.name}
            aria-pressed={on}
            /* Foreground whichever state it is in — the argument is in the
               essay above, and it is that the presence of this button is
               itself the message. `hover:text-foreground` is gone with the
               muted variant it existed to undo. */
            className="text-foreground pointer-events-auto size-6 cursor-default"
            /* Stops the grid reading the press as the start of a drag, which
               would make this button unpressable — see `Container.tsx`. */
            onMouseDown={(event) => event.stopPropagation()}
          >
            {/* Solid when something is narrowed, hollow when everything is
                showing. `fill-current` rather than a second icon import: it is
                the same funnel, and two lucide glyphs that differ only in
                weight would be two things to keep in step. */}
            <Filter className={on ? 'size-3 fill-current' : 'size-3'} />
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
 * What this control is called, and what it says when hovered or focused.
 *
 * A function rather than two ternaries at the call site, because the wording is
 * the whole of the fix and a wording nothing can test is a wording that drifts
 * back. `test/filters.test.ts` asserts against this directly: that the word
 * "filter" is in the accessible name in BOTH states, that the module's name is
 * too, and that the name changes when something is narrowed. Rendering the
 * button to assert the same things would need a Radix dropdown standing up in a
 * test runner with no browser, to check a string.
 *
 * ## Why the name changes but the verb does not
 *
 * The pin and the height toggle name the ACTION and swap it round — "pin this
 * container" becomes "let this container follow the kehikko again" — because
 * pressing them does the opposite of what they are doing. Pressing this one
 * does the same thing either way: it opens a menu. So the verb is fixed and
 * only the state is appended, which is also what `aria-pressed` says on the
 * element. Saying it twice is deliberate: `aria-pressed` is a state a screen
 * reader may or may not announce with the name, and "— narrowed" is four
 * syllables that guarantee it.
 *
 * The hint is a sentence and the name is a phrase, which is the split the rest
 * of this host keeps: `Hint.tsx` has the argument for why every icon here has a
 * tooltip at all, and the tooltip is deliberately not the accessible name.
 */
export function saying(name: string, narrowed: boolean): { name: string; hint: string } {
  return narrowed
    ? {
        name: `filter what ${name} shows — narrowed`,
        hint: `filter: ${name} is showing less than everything. Press to change what it shows, or to put it all back`,
      }
    : {
        name: `filter what ${name} shows`,
        hint: `filter: choose what ${name} shows`,
      }
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
