/**
 * The strip along the bottom of the window, and an argument for keeping it
 * nearly empty.
 *
 * ## What it is structurally
 *
 * The shell is three rows in a column the height of the window: the strip, the
 * canvas, and this. The canvas is the only one that gives, and it scrolls
 * inside itself when the arrangement is taller than the room left over. That
 * is the whole of the layout, and this file is the floor of it — the element
 * whose height the canvas is computed against. `dev/viewport.mjs` measures
 * that the document itself never scrolls and that this strip's bottom edge is
 * the bottom of the window at four sizes, including two short enough that the
 * canvas is shorter than one default container.
 *
 * ## What it holds, and the four things it deliberately does not
 *
 * An always-visible strip is the most expensive real estate on the screen: it
 * is paid for at every window size, on every kehikko, forever, and it is paid
 * for out of the canvas — which is the part of this program anybody opened it
 * to look at. So the bar for putting something here is not "is this true" or
 * even "is this useful", it is "is this both worth knowing at all times AND
 * homeless". Four candidates were considered and all four failed the second
 * half of that.
 *
 *   - **How many modules are asleep versus running.** Already on the top
 *     strip, as "N not running", and already better placed: it is next to the
 *     modules list, which is where somebody goes to do something about it, and
 *     it is absent entirely when the number is zero. Repeating it down here
 *     would put a permanent "0 not running" on a screen where nothing is
 *     wrong, which is the exact shape of the status bar this host is trying
 *     not to grow.
 *
 *   - **Whether the host is at its preferred ports or has moved.** The page's
 *     port is in the browser's address bar, which is on screen already and
 *     which this program does not have to reserve twenty-four pixels to
 *     duplicate; the API's is that number minus one by construction, and
 *     `server/ports.ts` has the essay on why the pair is claimed together and
 *     can never be anything else. Whether it MOVED is said loudly on stderr in
 *     the terminal the person started it from, at the one moment it is
 *     actionable. Putting it here would mean a new wire field and a fetch, for
 *     a number the window is already displaying.
 *
 *   - **The open project and kehikko.** Both are on the top strip, and both are
 *     CONTROLS there — you press them to change them. A read-only copy down
 *     here would be strictly worse than the thing it copies: the same words,
 *     four hundred pixels further from the pointer, doing nothing when pressed.
 *
 *   - **A count of containers, of frames, of anything.** Nobody asked, and the
 *     canvas is showing them.
 *
 * What is left is one sentence and one word, and the sentence is usually not
 * there.
 *
 * ## The sentence: a host-level fault, moved out of the layout
 *
 * `trouble` is the host's own error line — a write that failed, a sweep that
 * threw. It used to be a red band between the top strip and the canvas, and
 * moving it here fixes something beyond tidiness: as a `shrink-0` row in the
 * column it took its height OUT of the canvas, so the canvas got shorter the
 * moment anything went wrong. Every container on it then moved, which means
 * every module's page had to be re-measured and re-positioned, because the
 * pages are not children of the containers — see `Frames.tsx`. An error
 * message that reflows the arrangement is an error message that makes the
 * screen harder to read at the exact moment somebody needs to read it.
 *
 * Here the height is already reserved, so the sentence costs nothing when it
 * appears and nothing when it goes. It truncates rather than wrapping, with the
 * whole of it in a `title`, for the same reason: a long message must not be
 * able to decide how tall this strip is. The old band was a `<p>` with no
 * `truncate`, so a two-line error took two lines out of the canvas and a
 * four-line error took four.
 *
 * ## The word: why the strip is not blank when nothing is wrong
 *
 * At rest this says "Kehikot", dim, on the left. That is close to nothing and
 * it is deliberately not actually nothing, for the same reason `Nothing` in
 * `App.tsx` exists: a bare rectangle with no words in it is indistinguishable
 * from a part of the program that failed to draw. One dim word says the strip
 * is the floor of an application rather than a gap under the canvas, and it
 * makes the reserved height visible instead of mysterious.
 *
 * If something ever does earn a place here, it goes on the right, against
 * `justify-between`, and it should have to argue with the four paragraphs
 * above first.
 */
export function Footer({ trouble }: { trouble: string | null }) {
  return (
    <footer
      data-footer=""
      /* `shrink-0` and a fixed height, because this is the fixed half of the
         arithmetic: the canvas is `flex-1` and takes what is left, and it can
         only do that if what is left is a number that does not depend on what
         is written here. Twenty-four pixels rather than the strip's
         thirty-two — nothing here is a control, so nothing here needs a
         target. */
      className="bg-background text-muted-foreground flex h-6 shrink-0 items-center gap-2 border-t px-2 text-[11px] select-none"
    >
      <span className="shrink-0">Kehikot</span>

      {/* Right-aligned, so a fault reads as an interruption rather than as a
          second label beside the name. `min-w-0` with `truncate`: without the
          first the second does nothing inside a flex child, which is the exact
          shape of the bug that once put an 1187-pixel floor under a
          220-pixel container in this workspace.

          `text-destructive`, not the band's `text-destructive-foreground` on
          `bg-destructive`. That pair was a white sentence on a red field and
          it only worked because the field was there; the field is gone, and
          `--destructive-foreground` is very nearly white, which would have
          been an unreadable sentence on a light canvas and an ordinary one on
          a dark canvas — a fault message invisible in one of the two themes.
          `--destructive` is the token `index.css` describes as the one colour
          with a job, and it reads at both extremes. */}
      {trouble ? (
        <span className="text-destructive ml-auto min-w-0 truncate" title={trouble} role="status">
          {trouble}
        </span>
      ) : null}
    </footer>
  )
}
