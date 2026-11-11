import type { Fold } from './headerOffer.ts'
import { RESTART_LABEL } from './restartModule.ts'
import { coverSentence, type Showing, type Waiting, type noticeOf } from './standing.ts'

/**
 * How the cover and the notice are drawn in the room a container has.
 *
 * A container can be any size: a full column, a strip two rows high, a sliver
 * dragged to 200 pixels, folded to its header. The cover was one design — the
 * mark, the sentence, the address, the log, the button — and in a short or
 * narrow container that design was cut off, or pushed its button out of sight,
 * or showed nothing but the address. So the layout is chosen from the
 * container's OWN box (measured on the body, never the window), and every size
 * keeps the state and its action reachable:
 *
 * - `header`: folded, so there is no body. The state is a word in the header
 *   (`Updating`, `Stopped`), its sentence in the tooltip, and the action a row
 *   of the header's Container menu — the one list `layoutOf` lays out
 *   (`host/headerOffer.ts`), which is reachable at every width.
 * - `line`: under `LINE_BELOW` pixels of body. One line: a spinner or icon,
 *   the short word, the action as an icon button.
 * - `small`: under `SMALL_BELOW_HEIGHT` tall or `SMALL_BELOW_WIDTH` wide. The
 *   mark, small, and one line of text; the address and the log in its tooltip.
 * - `full`: the whole cover, centred and capped in width.
 *
 * The address is never the main text in any of them: it is detail.
 */
export type CoverLayout = 'header' | 'line' | 'small' | 'full'

/** Under this many pixels of body, the cover is one line. */
export const LINE_BELOW = 80
/** Under this many pixels of body, the cover is the small mark and one line. */
export const SMALL_BELOW_HEIGHT = 160
/** Under this many pixels of width, the same. */
export const SMALL_BELOW_WIDTH = 240

/**
 * The layout for a body this wide and tall, at a fold. `null` or `0` is "not
 * measured yet", drawn as the full cover — the first paint of a container that
 * then turns out small redraws once, which is better than a full container
 * starting as a line.
 */
export function coverLayoutFor(width: number | null, height: number | null, fold: Fold): CoverLayout {
  if (fold === 1) return 'header'
  /* Folded to two rows: the second row's height, a line by definition. */
  if (fold === 2) return 'line'
  if (!width || !height) return 'full'
  if (height < LINE_BELOW) return 'line'
  if (height < SMALL_BELOW_HEIGHT || width < SMALL_BELOW_WIDTH) return 'small'
  return 'full'
}

/** The short word for each moment that ends on its own: what the header and the line say. */
export const COVER_SHORT: Record<Waiting, string> = {
  starting: 'Starting',
  installing: 'Installing',
  updating: 'Updating',
  restarting: 'Restarting',
  loading: 'Loading',
}

/** What the one press on a notice is, whatever size it is drawn at. */
export type StandingAction =
  | { kind: 'start'; label: string }
  | { kind: 'retry'; label: string }
  | { kind: 'restart'; label: string }
  | { kind: 'update'; label: string }
  | { kind: 'fix'; label: string; module: boolean }

/**
 * What a cover or notice says at a glance, in full, and offers to press — the
 * same facts for every layout, so a smaller one leaves things out and never
 * says something else.
 *
 * `tone` picks the icon: `working` is a spinner, the rest are the notice's own
 * icons (`ConditionPanel`). `more` is what the small layouts move into the
 * tooltip: the log and the address, last.
 */
export interface Standing {
  tone: 'working' | 'stopped' | 'asleep' | 'incompatible' | 'failed'
  word: string
  sentence: string
  more: string[]
  action: StandingAction | null
}

export function standingOf(
  showing: Exclude<Showing, { kind: 'page' }>,
  notice: ReturnType<typeof noticeOf> | null,
  at: string,
  coverDetail?: string,
  /** The module's name, for "Loading <module>…" when it gave no words of its own. */
  name: string = 'this module',
): Standing {
  if (showing.kind === 'cover') {
    return {
      tone: 'working',
      word: COVER_SHORT[showing.state],
      sentence: coverSentence(showing.state, name, showing.label),
      more: [...(coverDetail ? [coverDetail] : []), at],
      action: null,
    }
  }
  const said = notice ?? { line: showing.line, offer: null }
  const sentence = said.title ? `${said.title}. ${said.line}` : said.line
  const more = [...(said.detail ?? []), at]
  const action: StandingAction | null = said.fix
    ? { kind: 'fix', label: said.fix.label, module: said.fix.module === true }
    : said.offer === 'start'
      ? { kind: 'start', label: 'Start' }
      : said.offer === 'retry-restart'
        ? { kind: 'retry', label: 'Retry restart' }
        : said.offer === 'restart'
          ? { kind: 'restart', label: RESTART_LABEL }
          : said.offer === 'update'
            ? { kind: 'update', label: 'Check for updates' }
            : null
  if (said.offer === 'retry-restart') return { tone: 'failed', word: 'Failed', sentence, more, action }
  if (showing.condition === 'incompatible') return { tone: 'incompatible', word: 'Needs update', sentence, more, action }
  if (showing.asleep) return { tone: 'asleep', word: 'Asleep', sentence, more, action }
  return { tone: 'stopped', word: said.offer === 'update' ? 'Needs update' : 'Stopped', sentence, more, action }
}

/** The tooltip of a layout that shows only the word or one line: the sentence, then what was left out. */
export function standingHint(standing: Standing, said?: string | null): string {
  return [standing.sentence, ...(said ? [said] : []), ...standing.more].join('\n')
}
