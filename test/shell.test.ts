import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * The app is exactly one window tall, and the three ways that stops being true.
 *
 * A strip, a canvas and a footer, in a column the height of the window. The
 * canvas is the only one that gives and it scrolls INSIDE ITSELF; the document
 * does not scroll at all. Those two are easy to confuse and only one of them is
 * acceptable — a scrolling document carries the footer off the bottom of the
 * screen, which is the single thing an always-visible strip must never do.
 *
 * These are source checks rather than renders, and that is a real limitation
 * worth stating: what actually decides this is four class names interacting in
 * a flex column, and no assertion about a string proves a layout. The layout is
 * measured, in a browser, by `dev/viewport.mjs`, which reports the document's
 * scroll travel, the canvas's, the footer's bottom edge against the window's
 * height, and — the one that matters most — how far each module's page is from
 * the container it belongs to, at rest and half way down the scroll.
 *
 * What these are for is the other half: a probe has to be RUN, by somebody who
 * remembers it exists, with a browser and a live host. Every class below was
 * load-bearing and none of them looks it, so each one is the kind of thing a
 * tidying pass removes on a Tuesday. These fail in `bun test` when that
 * happens, and name the consequence.
 */

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const footer = readFileSync(new URL('../src/canvas/Footer.tsx', import.meta.url), 'utf8')

/* Comments stripped before anything is asserted. Every class name below is
   discussed at length in the essays around it, so a check run against the
   source with its prose still in it is a check that a paragraph can satisfy —
   which is not a check. What is left is the code. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const shell = code(app)
const floor = code(footer)

describe('the window is the whole of it', () => {
  /*
   * `h-screen` is the height and `overflow-hidden` is the promise. Without the
   * second, a column that overflows its own height scrolls the document, and
   * the footer goes with it.
   */
  test('the shell is a column one window tall that cannot itself scroll', () => {
    expect(shell).toContain('flex h-screen flex-col overflow-hidden')
  })

  /*
   * The three classes on the canvas, and `min-h-0` is the one nobody would
   * guess. A flex item defaults to `min-height: auto`, which means "never
   * shrink below your content" — so `flex-1` alone lets a tall arrangement
   * push this row past the bottom of the window, and the shell's
   * `overflow-hidden` then CLIPS the bottom containers instead of letting
   * anybody scroll to them. That is worse than the scrolling page it was meant
   * to prevent: the containers are still there, still running, and
   * unreachable.
   *
   * `overflow-auto` happens to force the same `0` today, which is exactly why
   * this is worth asserting — the redundancy is what makes it look deletable.
   */
  test('the canvas takes what is left, may shrink, and scrolls inside itself', () => {
    const main = shell.slice(shell.indexOf('<main'), shell.indexOf('>', shell.indexOf('<main')))
    expect(main).toContain('flex-1')
    expect(main).toContain('min-h-0')
    expect(main).toContain('overflow-auto')
  })

  /*
   * Outside the scroller, or it is not a footer — it is a row at the bottom of
   * the canvas's content that scrolls away with everything else, visible only
   * when you happen to be at the end of the arrangement.
   */
  test('the footer is a sibling of the canvas, not something inside it', () => {
    expect(shell.indexOf('<Footer')).toBeGreaterThan(shell.indexOf('</main>'))
  })

  /*
   * `shrink-0` on both fixed rows. A flex item may shrink by default, so in a
   * short window the strip and the footer would give up their height before
   * the canvas — which is backwards. The canvas is the part that is allowed to
   * run out of room; the chrome is the part that is not.
   */
  test('the footer does not give up its height in a short window', () => {
    expect(floor).toContain('shrink-0')
  })
})

describe('a fault does not resize the arrangement', () => {
  /*
   * `trouble` is the host's own error line. It used to be a red band between
   * the strip and the canvas, which took its height OUT of the canvas — so the
   * canvas got shorter the moment anything went wrong, every container moved,
   * and every module's page had to be re-measured and re-positioned, because
   * the pages are not children of the containers. An error message that
   * reflows the whole arrangement makes the screen harder to read at the exact
   * moment somebody needs to read it.
   *
   * In the footer the height is already reserved, so the sentence costs
   * nothing appearing and nothing going away.
   */
  test('the host’s error line is drawn in the footer and nowhere else', () => {
    expect(shell).toContain('<Footer trouble={trouble}')
    expect(shell).not.toContain('bg-destructive/80')
  })

  /*
   * And the one control that has since earned a place beside it is `shrink-0`
   * and shorter than the strip.
   *
   * Both are load-bearing and neither looks it. Without `shrink-0` the button
   * is what gives way when the sentence is long, and a truncated word on a
   * button is a button nobody can read — the sentence is the thing that should
   * truncate, because the whole of it is in a `title` and the button's label is
   * not. And a control taller than `h-6` makes the strip taller than the
   * arithmetic the canvas's height is computed against, which is the one thing
   * this footer must never do.
   */
  test('the control beside it cannot stretch the strip or be squeezed out of it', () => {
    expect(floor).toContain('h-4 shrink-0')
  })

  /*
   * And it is not drawn at all when nothing is wrong.
   *
   * The footer's own essay is four paragraphs about why an always-visible strip
   * is the most expensive real estate on the screen. A control that is only
   * meaningful while the host's server is silent must be absent the rest of the
   * time, which is nearly always — so it hangs off `silent`, and `silent` comes
   * from the module that wrote the sentence rather than from a string match
   * here.
   */
  test('and it is absent unless the host’s own server is the thing that failed', () => {
    expect(floor).toContain('{silent ? (')
    expect(floor).toContain('isNotAnswering(trouble)')
  })

  /*
   * And it truncates rather than wrapping, for the same reason: a long message
   * must not be able to decide how tall this strip is. The old band was a `<p>`
   * with no `truncate`, so a two-line error took two lines out of the canvas
   * and a four-line error took four.
   *
   * `min-w-0` with it, because `truncate` alone does nothing inside a flex
   * child that has not been told it may shrink — the exact shape of the bug
   * that once put an 1187-pixel floor under a 220-pixel container in this
   * workspace. The whole of the message is still readable, in a `title`.
   */
  test('and a long one cannot decide how tall the footer is', () => {
    expect(floor).toContain('truncate')
    expect(floor).toContain('min-w-0')
    expect(floor).toContain('title={trouble}')
    expect(floor).not.toContain('whitespace-nowrap')
  })

  /*
   * `--destructive`, not `--destructive-foreground`. The second is very nearly
   * white and only worked on the band because the band was red behind it;
   * there is no field here, and a white sentence on a light canvas is a fault
   * message invisible in one of the two themes.
   */
  test('and it is readable in both themes', () => {
    expect(floor).toContain('text-destructive ')
    expect(floor).not.toContain('text-destructive-foreground')
  })
})

describe('the probes can find what they measure', () => {
  /*
   * `dev/viewport.mjs` pairs each module's page with its container's body by
   * these two attributes and reports the distance between them. They are the
   * only handles it has: the page and the container are in different layers,
   * with different ancestors and different positioning, and nothing else in
   * the DOM relates the two. Removing either attribute does not break the app
   * — it silently blinds the one check that catches a page drifting off its
   * container, which is this workspace's recurring bug.
   */
  test('a container’s body says which module it is holding', () => {
    expect(code(readFileSync(new URL('../src/canvas/Container.tsx', import.meta.url), 'utf8')))
      .toContain('data-body={presence.id}')
  })

  test('and a page says which module it is', () => {
    expect(code(readFileSync(new URL('../src/canvas/Frames.tsx', import.meta.url), 'utf8')))
      .toContain('data-frame={module.id}')
  })

  test('and the footer can be found without knowing what is written in it', () => {
    expect(floor).toContain('data-footer')
  })
})

describe('a tooltip does not outlive the header it was on', () => {
  /*
   * The whole of the fix, and it looks like a style preference. In focus mode a
   * container's header is faded out rather than unmounted, and a Radix tooltip
   * is hoverable by default — which means it does not close on `pointerleave`
   * but on a later `pointermove` outside a grace area. The thing below a
   * container header is the module's iframe, and this document receives no
   * pointer events at all once the pointer is inside one. So the dismissal was
   * owed to an event that never arrived, and the label sat on the canvas
   * anchored to an invisible button with nothing to press to get rid of it.
   *
   * `Hint.tsx` has the argument at length and `dev/tooltips.mjs` measures all
   * four cases. This is here because the prop reads as noise: one word, on a
   * component whose defaults are otherwise untouched, that nothing in the
   * types or the tests would miss.
   */
  test('the tooltip closes when the pointer leaves, owing nothing to a later event', () => {
    expect(code(readFileSync(new URL('../src/canvas/Hint.tsx', import.meta.url), 'utf8')))
      .toContain('<Tooltip disableHoverableContent>')
  })
})
