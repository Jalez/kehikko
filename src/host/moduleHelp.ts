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

/** The About dialog's title, for a module that wrote no how-to. */
export function aboutTitle(name: string): string {
  return `About ${name}`
}

/** Said in the About dialog of every module that wrote no how-to. */
export const NO_HOW_TO = "This module hasn't written a how-to yet."

/** What the About dialog is filled from: the module's manifest and its entry on a module list. */
export interface AboutFacts {
  /** The manifest's one-line `summary`. */
  summary?: string | null
  /** The manifest's `agentSays`: when to use it, in its own words. */
  says?: string | null
  /** Its entry on the official list (or the person's own), when it is on one. */
  listed?: { summary?: string | null; tags?: readonly string[] | null } | null
}

function said(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * "About <name>" for a module that has no `help`: the same dialog as "How to use", filled from what is
 * known of it — its summary, then what it tells agents and what the list says (each once), the list's
 * tags, and `NO_HOW_TO`. Never empty, so the Help menu's row is never missing. Every string is the
 * module's or the list's, drawn as text like a written how-to.
 */
export function aboutHelp(facts: AboutFacts): Help {
  const summary = said(facts.summary) || said(facts.listed?.summary) || 'It says nothing more about itself.'
  const points: string[] = []
  for (const one of [said(facts.says), said(facts.listed?.summary)]) {
    if (one && one !== summary && !points.includes(one)) points.push(one)
  }
  const tags = (facts.listed?.tags ?? []).map(said).filter(Boolean)
  return {
    summary,
    sections: [
      ...(points.length ? [{ title: 'What it does', points }] : []),
      ...(tags.length ? [{ title: 'Filed under', points: [tags.join(', ')] }] : []),
      { title: 'How to use', points: [NO_HOW_TO] },
    ],
  }
}
