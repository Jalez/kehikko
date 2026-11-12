/**
 * What a container's rectangle shows when the page has no presence for its module.
 *
 * "Not installed on this computer" (`canvas/Missing.tsx`) is a conclusion, and
 * it can only be drawn from a reading of the registry the host read whole. A
 * page that has no reading yet — its first look still out, or failed because
 * the host is still starting — knows nothing about what is installed, and
 * used to say every module on the kehikko was missing until its first reading
 * landed: seconds of "<module> is not installed on this computer" on a
 * computer where it was. Until there is such a reading, the container shows
 * the loading cover a module's page shows on its way (`canvas/Arriving.tsx`).
 *
 * A reading that says the registry could not be read (`scanned: false`) is no
 * better than none. A reading from an older host says nothing either way, and
 * is taken as whole, as before.
 */

export type PlacementShows = 'container' | 'arriving' | 'missing'

export function placementShows(hasPresence: boolean, reading: { scanned?: boolean } | null): PlacementShows {
  if (hasPresence) return 'container'
  if (reading === null || reading.scanned === false) return 'arriving'
  return 'missing'
}

/** One module as the last reading named it: what a container draws before there is a reading. */
export interface Remembered {
  name: string | null
  icon: string | null
}

const KEY = 'kehikot.lastModules'

/**
 * Each module's name and icon from the last reading, for the covers drawn before the first one
 * lands. Only a convenience: anything unreadable is nothing remembered, and the cover falls back to
 * the id and the neutral icon.
 */
export function rememberedModules(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Map<string, Remembered> {
  const found = new Map<string, Remembered>()
  try {
    const parsed = JSON.parse(storage?.getItem(KEY) ?? 'null') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return found
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const { name, icon } = value as { name?: unknown; icon?: unknown }
      found.set(id, { name: typeof name === 'string' ? name : null, icon: typeof icon === 'string' ? icon : null })
    }
  } catch {
    /* Nothing remembered. */
  }
  return found
}

/** Remember each module's name and icon from a reading. */
export function rememberModules(
  presences: Iterable<{ id: string; name?: string | null; icon?: string | null }>,
  storage: Pick<Storage, 'setItem'> | null = safeStorage(),
): void {
  const kept: Record<string, Remembered> = {}
  for (const one of presences) kept[one.id] = { name: one.name ?? null, icon: one.icon ?? null }
  try {
    storage?.setItem(KEY, JSON.stringify(kept))
  } catch {
    /* Not remembered this time. */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
