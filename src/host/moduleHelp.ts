import { helpOf, type Help } from 'kehikot-module-protocol'

/**
 * A module's "How to use" (protocol 2.52.0), as the host offers it. Pure, shared by the Container menu,
 * the modules list and the dialog, so they cannot disagree about which modules have one.
 *
 * The module writes it (`help` in its manifest) and the host draws it as text. The host's own words
 * here name no module: the title is the module's registered name in one fixed phrase.
 */

/** What a manifest says about how to use the module, ready to draw; `null` for none, so no entry is offered. */
export function helpFor(manifest: { help?: unknown } | null | undefined): Help | null {
  return helpOf(manifest)
}

/** The dialog's title and the "?" button's accessible name. */
export function helpTitle(name: string): string {
  return `How to use ${name}`
}
