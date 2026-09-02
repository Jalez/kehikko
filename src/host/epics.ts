import type { Epics as Held } from './projects.ts'

/**
 * Making an epic: the two rules the page and the server have to agree on.
 *
 * ## Why this file is importable from both halves
 *
 * A slug is derived from a title unless somebody says otherwise, and the
 * derivation happens in two places: on the page, where a person watches the
 * slug appear under the title they are typing, and on the server, where an
 * agent that gave a title and no slug gets one made for it. Two derivations
 * would be the disagreement this workspace keeps meeting — a person shown
 * `the-page-is-components` and an agent creating `thepageiscomponents` for the
 * same words — so there is one, here, with no `node:fs` and no `window` in it,
 * and `server/holdings.ts` imports it the way `server/server.ts` imports
 * `division.ts`.
 *
 * ## What the page does NOT do with it
 *
 * It does not check the result. `EPIC_SLUG` in the protocol and `SLUG` in
 * `holdings.ts` are what decide whether a slug is one, and the server refuses
 * with a sentence when it is not. A page that pre-checked would be a second
 * copy of that rule, and the copy on the page is the one that drifts — it is
 * the one nobody runs a test against a real file with. So the page shows the
 * derived slug, lets it be edited, sends whatever it shows, and puts the
 * server's own refusal in the footer, which is where every other refusal in
 * this host goes.
 */

/**
 * A slug out of a title, the way a person would write one by hand.
 *
 * Lowercased, accents folded to their base letters, every run of anything that
 * is not a letter or a digit becomes one dash, and the dashes at the ends go.
 * Cut at eighty characters — the protocol's `EPIC_SLUG` bound — and then
 * trimmed of a trailing dash again, because a cut can land on one.
 *
 * The empty string for a title with nothing usable in it. Not a fallback, not
 * `untitled`: an epic called "!!!" has no slug, and the server saying so is the
 * right answer, not this function guessing one.
 */
export function slugFrom(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '')
}

/**
 * What the `+` beside the epic select does, given the state the select is in.
 *
 * The select has three empty states — no project, no `data/epics`, and a
 * `data/epics` with nothing in it — and `Epics.tsx` says why they are three
 * and not one. Creating has to answer each of them separately, because what
 * the button will DO differs:
 *
 *   - **No project.** Nothing to create into: an epic is a file in a project's
 *     folder and there is no folder. The button is not offered at all, and
 *     that is a departure from the house rule that a control is disabled rather
 *     than hidden. The rule exists so that an absence explains nothing; here
 *     the select beside it, in the same state, already says "no project" in
 *     words, and a second flat control repeating the same sentence would be
 *     two disabled things for one fact. The button comes back with the
 *     project.
 *   - **No `data/epics`.** The directory has to be made, and it is made by the
 *     server on the first create — but the person is told before they press,
 *     because `data/` appearing in a thesis folder that had `main.tex` and
 *     `chapters/` is something they should have chosen rather than found.
 *   - **Empty `data/epics`.** The directory is there; a file goes in it.
 *   - **Still reading, or the read failed.** Offered anyway. The server is the
 *     one that decides, and a `+` that waited for a list it does not need
 *     would be dead for as long as a failed read is — which is forever.
 *
 * Returned as data rather than done in the component, so that each of the four
 * can be asserted without a DOM, which this host has none of.
 */
export function offerOfCreate(
  hasProject: boolean,
  held: Held | null,
): { offered: false } | { offered: true; makesDirectory: boolean; note: string } {
  if (!hasProject) return { offered: false }
  if (held && !held.holds) {
    return {
      offered: true,
      makesDirectory: true,
      note: 'this project has no data/epics yet — creating the first epic makes that directory in it',
    }
  }
  return {
    offered: true,
    makesDirectory: false,
    note: 'a file in this project’s data/epics, named by the slug',
  }
}
