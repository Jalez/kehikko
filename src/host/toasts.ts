import { BURST, KIND_WORDS, URGENCY, kindOf, type Kind } from './chime.ts'
import type { Namer } from './activity.ts'
import { placeLines, rowKey, type Entry } from './inbox.ts'

/**
 * The Inbox toast: a brief glimpse of what just arrived, with no record of
 * its own. Pure, like `chime.ts`.
 *
 * ## It is derived, never kept
 *
 * The toast is told by the SAME decision as the chime: `useInbox`'s `notify`
 * (the record's news, minus places on screen and items present at load), and
 * `shows` below is the chime's `playsHere` (one window). It holds no item set
 * of its own — a toast carries a copy of the words it shows and the entry to
 * go to, nothing more — and everything stays in the Inbox whether or not a
 * toast was seen. Dismissing a toast closes the toast; it never touches the
 * record.
 *
 * ## A glimpse
 *
 * Every toast goes by itself: about 5 s, 8 s for a kind that needs the
 * person. At most three are on screen, a newer one replacing the oldest. A
 * burst (items arriving within the chime's collect window) is one toast that
 * says how many, headed by the most urgent.
 */

export const TOAST_MS = { glimpse: 5000, needs: 8000 } as const
export const TOAST_MAX = 3

export const toastMs = (kind: Kind): number => (kind === 'urgent' || kind === 'attention' ? TOAST_MS.needs : TOAST_MS.glimpse)

/** What a toast shows. Plain text throughout: it is rendered as text and never as markup or a link. */
export interface Toast {
  id: number
  kind: Kind
  /**
   * The module's name for what this is (protocol 2.31.0): the head item's
   * declared event, "Research complete". Shown in place of the kind's word;
   * absent for an item that names none.
   */
  says?: string
  /** The module's registered name. */
  by: string
  label: string
  /** "Wide · methods", or the project's name for another project's item. */
  place: string
  /** How many arrived together; 1 for a single item. */
  count: number
  /** The most urgent item, which Open goes to. */
  entry: Entry
  project: number
}

export interface Arrival {
  entry: Entry
  project: number
  by: string
  place: string
}

/** The arrival's kind, or null when it is nothing to show (still working). */
export const arrivalKind = (arrival: Arrival): Kind | null => kindOf(arrival.entry)

/** The place in words, as the Inbox's rows say it. */
export function placeWords(entry: Entry, names: Namer, elsewhere: string | null): string {
  if (elsewhere) return elsewhere
  const { here, epic } = placeLines(entry, names)
  return [here, epic].filter(Boolean).join(' · ') || 'the project'
}

/** One batch of arrivals as one toast: the most urgent first (the earlier of equals). Null for nothing. */
export function toastOf(id: number, batch: readonly Arrival[]): Toast | null {
  let head: { arrival: Arrival; kind: Kind } | null = null
  for (const arrival of batch) {
    const kind = arrivalKind(arrival)
    if (kind === null) continue
    /* Of equally urgent ones, a named event heads, as it is the one the chime plays. */
    const named = arrival.entry.named && !head?.arrival.entry.named
    if (head === null || URGENCY[kind] > URGENCY[head.kind] || (URGENCY[kind] === URGENCY[head.kind] && named)) head = { arrival, kind }
  }
  if (!head) return null
  const count = batch.filter((one) => arrivalKind(one) !== null).length
  return {
    id,
    kind: head.kind,
    ...(head.arrival.entry.named ? { says: head.arrival.entry.named.says } : {}),
    by: head.arrival.by,
    label: head.arrival.entry.label,
    place: head.arrival.place,
    count,
    entry: head.arrival.entry,
    project: head.arrival.project,
  }
}

/** The toasts on screen after one more: at most `TOAST_MAX`, the oldest replaced. */
export const withToast = (shown: readonly Toast[], next: Toast): Toast[] => [...shown, next].slice(-TOAST_MAX)

/** The line a burst's toast heads with. */
export const countWords = (count: number): string => `${count} new in the Inbox`

export const kindLabel = (kind: Kind): string => KIND_WORDS[kind].label

/** The word a toast heads with: the event's own name when it has one, else the kind's. */
export const toastWord = (toast: Pick<Toast, 'kind' | 'says'>): string => toast.says ?? kindLabel(toast.kind)

/**
 * Arrivals in, at most one batch out per window: the first opens a short
 * window (the chime's `collectMs`), the rest of the burst joins it, and the
 * batch is handed over once. Unlike the sound there is no quiet time after:
 * an item that comes later is a toast of its own.
 */
export class Gather {
  #batch: Arrival[] = []
  #waiting = false
  constructor(
    private readonly emit: (batch: Arrival[]) => void,
    private readonly collectMs: number = BURST.collectMs,
    private readonly after: (run: () => void, ms: number) => unknown = (run, ms) => setTimeout(run, ms),
  ) {}

  offer(arrival: Arrival): void {
    const key = rowKey(arrival.entry)
    this.#batch = [...this.#batch.filter((one) => rowKey(one.entry) !== key), arrival]
    if (this.#waiting) return
    this.#waiting = true
    this.after(() => {
      const batch = this.#batch
      this.#batch = []
      this.#waiting = false
      this.emit(batch)
    }, this.collectMs)
  }
}
