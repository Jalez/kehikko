/**
 * What a container's header draws on its left side at a width: the module's
 * icon, the name, the version and the branch (or release) mark. Pure, so the
 * page and the tests share it.
 *
 * ## Why it never overlaps
 *
 * The four are flex items of one row; the name and the two chips all have
 * `min-w-0` and a truncating label, so none can be wider than the room it is
 * given and none is drawn over the next. This file is the order they give
 * way in as the room runs out, decided from the width of the container's own
 * header (the same measurement `modeFor` uses, never the window's: containers
 * are resized one at a time):
 *
 *  1. the branch mark's text becomes its icon (under `BADGE_TEXT_BELOW`);
 *  2. the version's text goes (under `VERSION_BELOW`), a pinned one leaving
 *     its tag icon, the amber mark that says it is not running latest;
 *  3. the module's icon goes (under `ICON_BELOW`);
 *  4. the name is cut with an ellipsis, as it is at every width it does not fit.
 *
 * What is dropped is in the tooltips and in the name's `title`, never only in
 * colour: the chips keep their words in `aria-label`, and a marked branch or a
 * pinned version keeps an icon beside its amber.
 */
export type HeaderFit = {
  /** The module's own icon is drawn. */
  icon: boolean
  /** The version's text is drawn (a pinned version keeps its icon either way). */
  version: boolean
  /** The branch mark's text is drawn; false is the icon alone. */
  badgeText: boolean
}

/** Under this many pixels of header the branch mark is its icon. */
export const BADGE_TEXT_BELOW = 400
/** Under this many the version's text is gone. Where the menus become icons (`ICONS_BELOW`). */
export const VERSION_BELOW = 300
/** Under this many the module's icon is gone. */
export const ICON_BELOW = 240

/** The fit for a header this wide. `null` is "not measured yet", drawn as the widest. */
export function fitFor(width: number | null): HeaderFit {
  if (width === null) return { icon: true, version: true, badgeText: true }
  return { icon: width >= ICON_BELOW, version: width >= VERSION_BELOW, badgeText: width >= BADGE_TEXT_BELOW }
}
