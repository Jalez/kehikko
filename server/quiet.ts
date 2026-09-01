/**
 * Why a module that loaded its page did not answer the greeting.
 *
 * ## One sentence was doing the work of four
 *
 * When a framed page is greeted and says nothing, the host has always said:
 *
 *     <name> loaded its page and did not answer the host's greeting. The
 *     program is running at its address; the page inside this container is not
 *     speaking.
 *
 * That sentence is true and it is the least useful one this host produces.
 * Everywhere else the host is scrupulous about telling failures apart —
 * `discover.ts` gives three separate readings of `silent`, names an impostor by
 * the id it calls itself, and compares protocol two different ways. This one
 * message covers a stale dependency bundle, a page whose scripts 404, a module
 * built against a protocol it cannot speak, and a genuine bug in somebody's
 * app. All four look identical, so the only available response is to press
 * Start again — which restarts the PROCESS, and none of the four live there.
 *
 * That is not hypothetical. A dependency update across twelve module
 * repositories rewrote `node_modules`; Vite fingerprints its optimised dep
 * bundles from what is installed, so pages that were already open asked for the
 * old fingerprints and got `504 (Outdated Optimize Dep)` for their scripts. The
 * HTML loaded, the JavaScript never ran, and the host said the module was not
 * speaking. The fix was to reload the page. Nothing on screen said so, and
 * Start was pressed several times against a fault it cannot touch.
 *
 * ## Why the server asks and not the page
 *
 * The page cannot. A module is framed cross-origin and sets no CORS headers —
 * deliberately, and there is an essay in every module's `vite.config.ts` about
 * why — so `fetch` from the host's page to a module's origin is refused before
 * it starts. The host's SERVER has no such problem; it already fetches every
 * module's manifest on every sweep. So the page, on the greeting deadline, asks
 * its own server what it can see, and the server looks with the same eyes it
 * uses for `discover.ts`.
 *
 * ## What it can and cannot know
 *
 * It cannot see inside the frame. It has no console, no error events, no idea
 * what the page did once its scripts ran. What it CAN do is fetch the page the
 * frame was given and then fetch every script that page asks for — which is
 * exactly the part of the failure the browser hid, and the part that produced
 * the reported bug.
 *
 * So the answers here are ordered by how specific they are, and the last one is
 * an honest shrug: when the page and all of its scripts load, the fault really
 * is inside the module, and saying so is worth more than a guess.
 *
 * ## "Every script that page asks for" was one level deep, and that was wrong
 *
 * The paragraph above says the server fetches every script the page asks for.
 * For a year it fetched every `<script src>` in the HTML, which is not the same
 * thing and, for these apps, is barely any of it. A Vite page names exactly two
 * scripts — `/@vite/client` and `/src/main.tsx` — and the other forty files of
 * the program are reached by `import`, one module asking for the next. Both of
 * the named two answer 200 in almost every failure, so the walk finished
 * immediately and fell through to the honest shrug at the bottom, which is not
 * honest when the thing it declined to look at is where the fault was.
 *
 * That is not hypothetical either. References had an editing accident that left
 * `manifest.ts` with the same `export const` twice; esbuild refused to transform
 * it, and Vite answered `/manifest.ts` with 500 and an error-overlay document.
 * `src/app.tsx` imports that file, so the browser's module graph never
 * instantiated, `main.tsx` never ran a line, and nothing ever called `connect`.
 * The page and both of its scripts were served perfectly. This file said the
 * fault was inside the module and that it was choosing not to answer, and a
 * person went looking for a bug in a page that had never executed.
 *
 * It was a `script` fault all along — a script the page needs did not load —
 * and the only reason it did not read as one is that the walk stopped at the
 * document. So the walk follows imports now: each JavaScript that comes back is
 * read for the paths it imports, and those are fetched too, breadth-first and
 * bounded. The sentence names the importer as well as the file, because "your
 * page needs /manifest.ts and it answered 500" is a fact a person can act on
 * and "a script did not load" on its own is one more thing to go and find.
 *
 * Only paths are followed — `/…`, `./…`, `../…`. A bare specifier is a name a
 * bundler resolves and this is not a bundler, and guessing at one would be this
 * probe inventing a URL and then blaming somebody for the 404 it got back. A
 * dev server has rewritten every specifier to a path already, which is the case
 * that matters, and a built bundle has inlined them, which is the case with
 * nothing left to follow.
 */

/** How long each probe waits. Shorter than a manifest fetch: the module is known to be up. */
export const PROBE_TIMEOUT_MS = 2000

/** As many scripts as a page should be asking for. Bounded: this is somebody else's document. */
const SCRIPTS_MAX = 24

/** As much HTML as is worth reading to find script tags. */
const PAGE_BYTES = 512 * 1024

/**
 * As many modules as the walk will fetch before it stops looking.
 *
 * One of these apps served by Vite is forty-odd files; a built bundle is fewer.
 * Three hundred is well clear of both, and it is a fence rather than a budget —
 * the point is that this loop walks a graph somebody else writes, and it has to
 * terminate on a hostile one as surely as on a friendly one.
 */
const MODULES_MAX = 300

/** How many are in flight at once, so a forty-file graph is not forty round trips. */
const MODULES_AT_ONCE = 8

/** As much JavaScript as is worth reading for its imports. They are all at the top of the file. */
const MODULE_BYTES = 512 * 1024

export type Quiet =
  /** Its scripts were rebuilt underneath it; the page is holding stale addresses. */
  | { kind: 'stale'; line: string }
  /** The page itself did not come back. */
  | { kind: 'page'; line: string }
  /** A script the page asks for does not load. */
  | { kind: 'script'; line: string }
  /** Everything loads, so the silence is the module's own. */
  | { kind: 'module'; line: string }

/**
 * Every script a document asks for, as written.
 *
 * A regex over somebody else's HTML, which is normally the wrong tool and is
 * the right one here: this is not parsing a document, it is finding the URLs a
 * browser would have fetched, and the failure mode of missing one is a less
 * specific sentence rather than a wrong action. A parser would be a dependency
 * and a second thing to keep correct for no gain.
 *
 * `src` only. An inline script cannot 504.
 */
export function scriptsIn(html: string): string[] {
  const found: string[] = []
  const pattern = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    const src = match[1]
    if (src && !found.includes(src)) found.push(src)
    if (found.length >= SCRIPTS_MAX) break
  }
  return found
}

/**
 * Every path a JavaScript module imports, as written.
 *
 * A regex again, and the same defence as `scriptsIn`: this is not parsing a
 * program, it is finding the URLs a browser would have fetched next, and a miss
 * costs a less specific sentence rather than a wrong one. What a miss must NOT
 * cost is a wrong accusation, and that is what shapes the two rules below.
 *
 * **Paths only.** `/x`, `./x`, `../x`. A bare `react` is a name that a bundler
 * or an import map resolves, and resolving it here would mean guessing at a URL
 * and then reporting whoever owns the module for the 404 that guess produced. A
 * dev server has already rewritten every bare specifier into a path, so the case
 * this exists for loses nothing.
 *
 * **Statements, at the start of a line.** The keyword has to open its line, and
 * that one anchor is what makes the rest safe. Every real static import is a
 * top-level statement written that way; the `import` that turns up in a JSDoc
 * example is preceded by an asterisk, and the one in a sentence is preceded by
 * a sentence. Between the keyword and the specifier no quote, semicolon or
 * bracket is allowed, which the multi-line braced form satisfies and an
 * accidental run of prose does not.
 *
 * **Static only. Not `import(…)`.** This was tried and it was wrong twice over.
 * Wrong in practice: React's pre-bundled chunk carries the error string
 * `const MyComponent = lazy(() => import('./MyComponent'))`, which is a
 * quotation inside a string literal and looks exactly like an import to a
 * regex, so the first live run of this walk reported a healthy module as having
 * a 404 on a file no one has ever had. A probe whose job is to stop a person
 * chasing the wrong thing must not manufacture one.
 *
 * And wrong in principle, which is the part that settles it: a dynamic import
 * is not fetched until it is called. It is not in the graph the browser has to
 * instantiate before the entry runs, so it CANNOT be the reason a page loaded
 * and executed nothing — and that failure is the entire subject of this file. A
 * broken lazy chunk breaks a click, and by then there is a console to read.
 *
 * `import.meta` is not matched, because a space is required after the keyword.
 */
export function importsIn(js: string): string[] {
  const found: string[] = []
  /* `import '/x'`, `import x from './x'`, `export * from '../x'` — the clause in
     the middle is optional so that a bare side-effect import is caught too. */
  const statics = /^[ \t]*(?:import|export)\s[^;'"()]*?["'](\.{0,2}\/[^"'\n]*)["']/gm
  let match: RegExpExecArray | null
  while ((match = statics.exec(js)) !== null) {
    const path = match[1]
    if (path && !found.includes(path) && found.length < MODULES_MAX) found.push(path)
  }
  return found
}

/**
 * The sentence a container should show instead of "it is not speaking".
 *
 * `entry` is the absolute URL the frame was given — the same one the host put
 * in `src`, so this asks for exactly what the browser asked for.
 */
export async function whyQuiet(
  name: string,
  entry: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<Quiet> {
  const get = async (url: string): Promise<{ status: number; text: string; type: string } | null> => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, { signal: abort.signal, redirect: 'follow' })
      const text = response.ok ? (await response.text()).slice(0, PAGE_BYTES) : ''
      return { status: response.status, text, type: response.headers.get('content-type') ?? '' }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  const page = await get(entry)
  if (!page) {
    return {
      kind: 'page',
      line:
        `${name} answers at its address, but the page this container was given — ${entry} — did not come back. `
        + 'The module is running and is not serving what its manifest says it serves.',
    }
  }
  if (page.status !== 200) {
    return {
      kind: 'page',
      line: `${name} answered ${page.status} for its own page at ${entry}, so the container has nothing to draw.`,
    }
  }

  const scripts = scriptsIn(page.text)

  /*
   * Breadth-first from the document, one level of the import graph at a time.
   *
   * Level by level rather than depth-first, because the shallower a failing
   * module is the more likely it is to be the one a person recognises, and
   * because it keeps the document's own scripts — the ones the old walk looked
   * at, and the ones a `504` shows up in — reported before anything reached
   * through them. `asked` records who imported what, so the sentence can say it.
   */
  const seen = new Set<string>()
  const asked = new Map<string, string>()
  let level: string[] = []
  for (const src of scripts) {
    try {
      const url = new URL(src, entry).toString()
      if (seen.has(url)) continue
      seen.add(url)
      asked.set(url, entry)
      level.push(url)
    } catch {
      /* A src a URL parser refuses is one a browser refuses too, and there is
         nothing to fetch. It is not evidence either way. */
    }
  }

  while (level.length > 0 && seen.size <= MODULES_MAX) {
    const fetched: { url: string; got: Awaited<ReturnType<typeof get>> }[] = []
    for (let at = 0; at < level.length; at += MODULES_AT_ONCE) {
      const batch = level.slice(at, at + MODULES_AT_ONCE)
      fetched.push(...(await Promise.all(batch.map(async (url) => ({ url, got: await get(url) })))))
    }

    /*
     * A 504 anywhere in this level beats a plain failure anywhere in it, and
     * that ordering is deliberate rather than incidental. "Reload the page" is
     * the one remedy on this ladder a person can carry out with certainty, so a
     * level holding both a stale dependency and a broken file should offer the
     * stale reading — the reload fixes that one and costs nothing if the other
     * was real, whereas sending somebody after a file when their page was simply
     * old is the mistake this whole file exists to stop making.
     *
     * 504 from a Vite dev server means one thing and it is not a server fault:
     * the optimised dependency bundles were rebuilt, and this page is asking
     * for the fingerprints they had before. Vite calls it "Outdated Optimize
     * Dep". The page is stale, the module is fine, and the remedy is a reload —
     * which is precisely what nobody could guess from "not speaking".
     */
    const stale = fetched.find((one) => one.got?.status === 504)
    if (stale) {
      return {
        kind: 'stale',
        line:
          `${name} is running, but this container is holding a page from before its dependencies were rebuilt: `
          + `${stale.url} is gone. Nothing is wrong with the module — reload this page and the container will come `
          + 'back. Starting it again cannot help; the stale addresses are in the page, not in the program.',
      }
    }

    const broken = fetched.find((one) => !one.got || one.got.status !== 200)
    if (broken) {
      const from = asked.get(broken.url)
      return {
        kind: 'script',
        line:
          `${name} served its page, but a script that page needs did not load: ${broken.url} answered `
          + `${broken.got ? broken.got.status : 'nothing'}`
          + (from && from !== entry ? `, and ${from} imports it` : '')
          + '. The page fetches without running, so nothing in the module ever gets as far as answering. '
          + 'The container will stay blank until that resolves.',
      }
    }

    const next: string[] = []
    for (const one of fetched) {
      /* Only JavaScript is read for imports. HTML, CSS and JSON come back from
         these servers too, and scanning them for the word `import` would be
         inventing URLs to go and blame somebody for. */
      if (!one.got || !one.got.type.includes('javascript')) continue
      for (const path of importsIn(one.got.text.slice(0, MODULE_BYTES))) {
        let url: string
        try {
          url = new URL(path, one.url).toString()
        } catch {
          continue
        }
        if (seen.has(url) || seen.size > MODULES_MAX) continue
        seen.add(url)
        asked.set(url, one.url)
        next.push(url)
      }
    }
    level = next
  }

  return {
    kind: 'module',
    line:
      `${name} served its page and every script in it, so the page is loading and choosing not to answer. `
      + (scripts.length === 0
        ? 'Its page asks for no scripts at all, which would explain it.'
        : `That is a fault inside the module rather than in how it is served — ${seen.size} `
          + `file${seen.size === 1 ? '' : 's'} of it were fetched, following every import, and all of them came back.`),
  }
}
