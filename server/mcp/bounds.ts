/* ------------------------------------------------------------------ *
 * Everything that arrives, bounded before it is looked at
 *
 * This listens on loopback, which is a fence around the machine and not around
 * the programs on it. A string has a length before it has a meaning.
 * ------------------------------------------------------------------ */

/** As long as a module id may be — the same bound `moduleIn` uses in `server.ts`. */
export const MAX_ID = 64
/** More containers than any canvas holds; `PLACEMENTS_MAX` in `canvases.ts` is 64. */
export const MAX_MODULES = 64
/** A title is bounded at `TITLE_MAX` in `holdings.ts`; this is the bound on what is even read. */
export const MAX_TEXT = 1024

/**
 * A kehikko id out of an argument, or `undefined` for "none was given".
 *
 * Deliberately strict about what an id is, for the reason `canvasId` in
 * `server.ts` is: `Number('1e3')` is 1000 and `Number(' 2 ')` is 2, so a
 * generous reading would let a string that is not a number at all address a
 * canvas. `null` here means "given, and not a kehikko id" — which is refused
 * rather than treated as absent, because an agent that sent `kehikko: "3"` and
 * silently got the open one instead would be acting on a canvas it did not name.
 */
export function kehikkoIn(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  return null
}

/** The module ids out of an argument, bounded — or a sentence saying what was wrong with them. */
export function modulesIn(
  value: unknown,
  tool: 'select_modules' | 'place_modules' | 'fold_modules',
  argument: 'modules' | 'fold' | 'unfold' | 'tile' | 'show' = 'modules',
): { ok: true; ids: string[] } | { ok: false; why: string } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      why:
        tool === 'select_modules'
          ? 'select_modules needs modules: a list of the module ids that should end up selected, e.g. modules: '
            + '["kehikot.<name>"]. Pass modules: [] to unpick everything. It replaces the selection rather than '
            + 'adding to it, so send every id you want selected, not only the new one.'
          : tool === 'place_modules'
            ? 'place_modules needs modules: a list of the module ids to put on the kehikko, e.g. modules: '
              + '["kehikot.<name>"] — as read_canvas prints them under "registered on this computer and not on this '
              + 'kehikko".'
            : 'fold and unfold are each a list of module ids as read_canvas prints them, e.g. fold: '
              + '["kehikot.<name>"], unfold: ["kehikot.<name>"]. Leave out the one you do not need.',
    }
  }
  if (value.length > MAX_MODULES) {
    return { ok: false, why: `no kehikko holds more than ${MAX_MODULES} containers, so that list cannot be right.` }
  }
  const ids: string[] = []
  for (const one of value) {
    if (typeof one !== 'string' || !one.trim() || one.length > MAX_ID) {
      return {
        ok: false,
        why:
          `every entry in ${argument} has to be a module id as read_canvas prints it — a non-empty string of at most `
          + `${MAX_ID} characters. One of them was not.`,
      }
    }
    const id = one.trim()
    /* A duplicate is not a second selection of the same container; it is the
       same one, and letting it through would make "how many are selected" a
       number that disagrees with what is on screen. The same rule `refsIn`
       applies to refs, for the same reason. */
    if (!ids.includes(id)) ids.push(id)
  }
  return { ok: true, ids }
}

/** A line of text out of an argument, bounded before `holdings.ts` looks at it. `undefined` for "not given". */
export function textIn(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length > MAX_TEXT) return null
  return value
}
