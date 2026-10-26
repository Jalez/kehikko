/**
 * What a container's header draws on its left side: the module's icon, the
 * name, the version and the branch (or release) mark. Pure, so the page and
 * the tests share it.
 *
 * ## Why it never overlaps
 *
 * The four are flex items of one row; the name and the chips have `min-w-0`
 * (or a floor of their own) and a truncating label, so none is wider than the
 * room it is given and none is drawn over the next. This file is the order
 * they give way in as the room runs out:
 *
 *  1. the branch mark's text becomes its icon;
 *  2. the version's text goes (a pinned version keeps its amber tag icon);
 *  3. the module's icon goes, and a quiet branch mark (on `main`, or a release)
 *     goes with it, a marked one keeping its amber icon;
 *  4. the name is cut with an ellipsis, as at every width it does not fit.
 *
 * Two things decide how far down that list a header is. The header's own
 * width, the measurement `modeFor` uses and never the window's (containers
 * are resized one at a time), says how far it MAY be at all (`fitFor`: no
 * words for a chip under 400, no version under 300, no icon under 240). And the
 * room the name has, measured (`Container`): a module with three words-menus
 * leaves 380 pixels almost nothing, one with none leaves it plenty, and
 * only the page can tell which this is. Each step down is taken while the name
 * has less than `NAME_ROOM` pixels and is cut. What is dropped is in the
 * name's `title`, the chips' tooltips and names, never only in colour.
 */
export type HeaderFit = {
  /** The module's own icon is drawn. */
  icon: boolean
  /** The version's text is drawn (a pinned version keeps its icon either way). */
  version: boolean
  /** The branch mark's text is drawn; false is the icon alone. */
  badgeText: boolean
  /** A branch mark that is not marked is drawn at all (a marked one always is). */
  quiet: boolean
}

/** Under this many pixels of header the branch mark is its icon. */
export const BADGE_TEXT_BELOW = 400
/** Under this many the version's text is gone. Where the menus become icons (`ICONS_BELOW`). */
export const VERSION_BELOW = 300
/** Under this many the module's icon, and a quiet branch mark, are gone. */
export const ICON_BELOW = 240
/** The pixels the name keeps before another step down is taken: about eleven letters. */
export const NAME_ROOM = 72
/** The most steps down there are. */
export const STEPS = 4

/** What a header this wide may draw. `null` is "not measured yet", drawn as the widest. */
export function fitFor(width: number | null): HeaderFit {
  if (width === null) return { icon: true, version: true, badgeText: true, quiet: true }
  return { icon: width >= ICON_BELOW, version: width >= VERSION_BELOW, badgeText: width >= BADGE_TEXT_BELOW, quiet: width >= ICON_BELOW }
}

/** `fit`, `steps` further down the order (0 to `STEPS`). */
export function stepDown(fit: HeaderFit, steps: number): HeaderFit {
  return {
    badgeText: fit.badgeText && steps < 1,
    version: fit.version && steps < 2,
    icon: fit.icon && steps < 3,
    quiet: fit.quiet && steps < 3,
  }
}

/** Whether the name, as drawn, has too little room and is cut: `scrolls` is its `scrollWidth`, `shown` its `clientWidth`. */
export function crowded(shown: number, scrolls: number): boolean {
  return scrolls > shown + 1 && shown < NAME_ROOM
}
