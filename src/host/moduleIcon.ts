import { isModuleIcon, type ModuleIcon } from 'kehikot-module-protocol'

/**
 * Which icon a module is drawn with, wherever it is listed. Pure, and shared by the page and the
 * server (`server/server.ts` resolves each presence's `icon` with it).
 *
 * A module's own word wins: the `icon` its manifest declares (protocol 2.14.0), or the one it
 * declared when it last answered. Then the icon the official list gives it, for a module that has
 * not answered yet. Each is a KEY of the protocol's `MODULE_ICONS` or nothing — a path, a URL or an
 * unknown name is skipped, never fetched — and null means neither knows one: the module is drawn
 * with the neutral icon and its initial (`ModuleIcon.tsx`), never Kehikot's own marks.
 */
export function moduleIconFor(declared: unknown, listed: unknown): ModuleIcon | null {
  if (isModuleIcon(declared)) return declared
  if (isModuleIcon(listed)) return listed
  return null
}

/** The letter drawn on the neutral icon: the name's first letter or digit, upper-cased; `?` for a name with none. */
export function initialOf(name: string): string {
  const first = /[\p{L}\p{N}]/u.exec(name)?.[0]
  return first ? first.toLocaleUpperCase() : '?'
}
