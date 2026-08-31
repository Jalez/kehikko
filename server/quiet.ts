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
 */

/** How long each probe waits. Shorter than a manifest fetch: the module is known to be up. */
export const PROBE_TIMEOUT_MS = 2000

/** As many scripts as a page should be asking for. Bounded: this is somebody else's document. */
const SCRIPTS_MAX = 24

/** As much HTML as is worth reading to find script tags. */
const PAGE_BYTES = 512 * 1024

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
  const get = async (url: string): Promise<{ status: number; text: string } | null> => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, { signal: abort.signal, redirect: 'follow' })
      const text = response.ok ? (await response.text()).slice(0, PAGE_BYTES) : ''
      return { status: response.status, text }
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
  for (const src of scripts) {
    let url: string
    try {
      url = new URL(src, entry).toString()
    } catch {
      continue
    }
    const got = await get(url)
    if (got && got.status === 200) continue

    /*
     * 504 from a Vite dev server means one thing and it is not a server fault:
     * the optimised dependency bundles were rebuilt, and this page is asking
     * for the fingerprints they had before. Vite calls it "Outdated Optimize
     * Dep". The page is stale, the module is fine, and the remedy is a reload —
     * which is precisely what nobody could guess from "not speaking".
     */
    if (got && got.status === 504) {
      return {
        kind: 'stale',
        line:
          `${name} is running, but this container is holding a page from before its dependencies were rebuilt: `
          + `${url} is gone. Nothing is wrong with the module — reload this page and the container will come back. `
          + 'Starting it again cannot help; the stale addresses are in the page, not in the program.',
      }
    }

    return {
      kind: 'script',
      line:
        `${name} served its page, but a script that page needs did not load: ${url} answered `
        + `${got ? got.status : 'nothing'}. The container will stay blank until that resolves.`,
    }
  }

  return {
    kind: 'module',
    line:
      `${name} served its page and every script in it, so the page is loading and choosing not to answer. `
      + (scripts.length === 0
        ? 'Its page asks for no scripts at all, which would explain it.'
        : 'That is a fault inside the module rather than in how it is served.'),
  }
}
