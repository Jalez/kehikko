import { isNotAnswering } from '@/host/reachable.ts'

/**
 * The host's own error line, drawn in the header strip.
 *
 * It used to be a footer: a twenty-four-pixel strip along the bottom of the
 * window that said "Kehikot" and, now and then, what had gone wrong. The name
 * moved to the start of the header, beside the mark, and a strip that existed
 * to hold one occasional sentence was a row of chrome paid for all the time.
 *
 * ## Why the header and not a band
 *
 * A fault must not resize the arrangement. A band between the strip and the
 * canvas took its height out of the canvas, so every container moved — and
 * every module's page had to be re-measured, because the pages are not
 * children of the containers — at the exact moment somebody needed to read the
 * screen. The header's height is fixed (`h-8 shrink-0`), so a sentence in it
 * costs nothing appearing and nothing going away. Nothing is drawn when there
 * is nothing wrong.
 *
 * ## "look again"
 *
 * Only for the one fault where it means anything — the host's server not
 * answering, asked of `host/reachable.ts` rather than matched here. It is not
 * a restart: the page's only route to that server is that server, and
 * `run.sh` is what supervises it. It re-reads the registry now instead of
 * waiting for the page's own backoff, which is safe to press twice and so
 * needs no arm.
 */
export function Trouble({
  trouble,
  onLookAgain,
  looking,
}: {
  trouble: string | null
  /** Sweep the registry now. The same `look` every other caller asks for. */
  onLookAgain(): void
  /** Whether a sweep is in flight, so the control says so rather than lying still. */
  looking: boolean
}) {
  if (!trouble) return null
  const silent = isNotAnswering(trouble)

  /* `min-w-0` with `truncate`: without the first the second does nothing in a
     flex child. `text-destructive` rather than a filled band, because it reads
     in both themes. The button is a plain `<button>` sized to fit the strip,
     and `shrink-0` so the sentence gives way rather than the control. */
  return (
    <span data-trouble="" className="flex min-w-0 max-w-[40ch] items-center gap-1.5 text-[11px]">
      <span className="text-destructive min-w-0 truncate" title={trouble} role="status">
        {trouble}
      </span>
      {silent ? (
        <button
          type="button"
          onClick={onLookAgain}
          disabled={looking}
          title="Ask the host's server again, now, rather than waiting for the page to retry."
          className="border-destructive/40 text-destructive hover:bg-destructive/10 disabled:opacity-50 h-4 shrink-0 rounded-sm border px-1.5 text-[10px] leading-none"
        >
          {looking ? 'looking…' : 'look again'}
        </button>
      ) : null}
    </span>
  )
}
