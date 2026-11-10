import { isBuiltFrom, isWorksWithSentence, parseMarkdown, plainText, whatsNew, type Inline } from './markdown.ts'
import type { ModuleRelease } from './moduleReleases.ts'
import { compareVersions, satisfies, worksWithDetail, worksWithSaid } from './worksWith.ts'

/**
 * What an update brings, in a few lines under its row in the Updates menu:
 * the bold summary that starts each bullet of a release's notes, newest
 * release first, capped, then "+N more" for the rest. Pure: the notes are read
 * by `fetchNotes` (the server keeps them cached) and drawn as text — every
 * line here is a plain string, never markup, and a link in the notes is its
 * words alone.
 */

/** How many summary lines a row shows before "+N more". */
export const SUMMARY_CAP = 3
/** The longest a line drawn from a bullet with no bold part may be. */
export const SUMMARY_MAX = 90

/** A sub-bullet: indented two or more spaces (or a tab) under another. Its parent's summary covers it. */
const NESTED = /^(?: {2,}|\t+)(?:[-*+]|\d{1,9}[.)])\s/

/** The first sentence of a text, cut to `max` characters with an ellipsis. */
export function firstSentence(text: string, max = SUMMARY_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const end = /[.!?](?=\s|$)/.exec(flat)
  const sentence = end ? flat.slice(0, end.index + 1) : flat
  if (sentence.length <= max) return sentence
  const cut = sentence.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, '')}…`
}

/** One bullet's line: its leading bold part, else its first sentence. */
function bulletLine(item: readonly Inline[]): string | null {
  const first = item.find((one) => !(one.kind === 'text' && !one.text.trim()))
  if (first?.kind === 'strong') {
    const bold = plainText(first.children).replace(/\s+/g, ' ').trim()
    if (bold) return bold.length > SUMMARY_MAX ? firstSentence(bold) : bold
  }
  const said = firstSentence(plainText(item))
  return said || null
}

/**
 * The summary lines of one release body: one per top-level bullet of its
 * "What's new" section (`whatsNew`). A body with no bullets gives the first
 * sentence of each paragraph instead, leaving out the "Works with Kehikot…"
 * sentence and the "Built from…" footer.
 */
export function noteSummaries(body: string): string[] {
  const section = whatsNew(body)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !NESTED.test(line))
    .join('\n')
  const blocks = parseMarkdown(section)
  const bullets = blocks.flatMap((block) => (block.kind === 'list' ? block.items : []))
  if (bullets.length) return bullets.map(bulletLine).filter((one): one is string => one !== null)
  return blocks
    .flatMap((block) => (block.kind === 'paragraph' ? [plainText(block.children)] : []))
    .filter((text) => !isWorksWithSentence(text) && !isBuiltFrom(text))
    .map((text) => firstSentence(text))
    .filter(Boolean)
}

export interface SummaryLine {
  /** The release it comes from. */
  tag: string
  text: string
}

/** Every release's lines in one list, in the order the releases are given (newest first). */
export function summaryLines(releases: readonly { tag: string; lines: readonly string[] }[]): SummaryLine[] {
  return releases.flatMap(({ tag, lines }) => lines.map((text) => ({ tag, text })))
}

/** The lines a row shows and how many more there are: "+N more" when `more` is above zero. */
export function capped<T>(lines: readonly T[], cap = SUMMARY_CAP): { shown: T[]; more: number } {
  /* "+1 more" saves no line: the last one is shown instead. */
  if (lines.length <= cap + 1) return { shown: [...lines], more: 0 }
  return { shown: lines.slice(0, cap), more: lines.length - cap }
}

/** "+2 more". */
export function moreSaid(more: number): string {
  return `+${more} more`
}

/** The badge's tooltip when the running Kehikot is too old for the release. */
export const NEEDS_NEWER_APP = 'Needs a newer Kehikot: update the app first'

export interface CompatBadge {
  /** "Kehikot 0.1.129+": the first app the release works with. */
  text: string
  /** The running Kehikot does not meet it: drawn as a warning, with `NEEDS_NEWER_APP` as its tooltip. */
  warn: boolean
  /** The tooltip. */
  tip: string
  /** The module-protocol detail, drawn under the tooltip in a quieter line: the one place a protocol number is shown. */
  detail: string
}

/**
 * The compatibility badge beside a release in an update row, in place of the
 * "1.6.0 works with Kehikot 0.1.39 and later" sentence: the lowest app it
 * works with, quiet when the running Kehikot meets it and a warning when it
 * does not. Null when nothing is known of the release.
 */
export function compatBadge(release: ModuleRelease, tag: string | null, have: { app?: string | null; protocol?: string | null } = {}): CompatBadge | null {
  if (!tag || !release.works || !Object.hasOwn(release.works, tag)) return null
  const works = release.works[tag]!
  /* The badge and the sentence say app versions; the protocol is the tooltip's quiet second line only. */
  const detail = worksWithDetail(works)
  if (works.kind === 'from') {
    if (!works.from) return null
    const text = works.until ? `Kehikot ${works.from}–${works.until.last}` : `Kehikot ${works.from}+`
    const tooOld = Boolean(have.app) && compareVersions(have.app!, works.from) < 0
    const tooNew = Boolean(have.app) && works.until !== null && compareVersions(have.app!, works.until.last) > 0
    return tooOld ? { text, warn: true, tip: NEEDS_NEWER_APP, detail } : { text, warn: tooNew, tip: worksWithSaid(works), detail }
  }
  if (works.kind === 'unreleased') return { text: `Kehikot newer than ${works.newest.app}`, warn: true, tip: NEEDS_NEWER_APP, detail }
  if (works.kind === 'unknown') {
    /* No app versions could be read: whether THIS Kehikot runs it is still known from its protocol. */
    if (!have.protocol) return { text: 'Kehikot version not known', warn: false, tip: 'Which Kehikot it needs could not be read', detail }
    const warn = !satisfies(works.need, have.protocol)
    return warn ? { text: 'Newer Kehikot', warn, tip: NEEDS_NEWER_APP, detail } : { text: 'This Kehikot', warn, tip: 'Works with this Kehikot', detail }
  }
  return null
}

/** The releases whose summaries a module's row shows: those an update moves it through, newest first. None when it is not moving forward. */
export function summaryTags(release: ModuleRelease | undefined): string[] {
  if (!release || !release.repo || !release.target || release.back) return []
  return release.notes.filter((tag) => tag !== release.installed)
}
