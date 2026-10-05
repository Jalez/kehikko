/**
 * The page, when it travels inside this program rather than beside it.
 *
 * In development there is no page here at all: Vite serves it on the next port
 * up and proxies `/host` back — see `run.sh` for why there is no `dist`, and
 * keep it that way. A stale build served as though it were the code cost hours.
 *
 * The desktop app is the other shape. It ships this host as ONE binary, a Tauri
 * sidecar, and there is no Vite on somebody else's machine to serve anything.
 * So `dev/build-sidecar.ts` builds the page and compiles it INTO the binary,
 * and the binary's entry hands the files to `embed` before the server module
 * is evaluated. That hand-off is also the whole of how the server knows it is
 * bundled: a page present means bundled, a page absent means development. No
 * variable for somebody to forget to set, and no way for a dev server to serve
 * a built page, because a dev server has nothing to hand over.
 */

/** Published path (`/index.html`, `/assets/index-abc.js`) to where the bytes are. */
export type PageFiles = ReadonlyMap<string, string>

let embedded: PageFiles | null = null

/** Called once, by the compiled binary's entry, before `server.ts` loads. */
export function embed(files: PageFiles): void {
  embedded = files
}

/** The embedded page, or null in development. */
export function embeddedPage(): PageFiles | null {
  return embedded
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
  wasm: 'application/wasm',
}

export function contentType(path: string): string {
  const dot = path.lastIndexOf('.')
  const ext = dot < 0 ? '' : path.slice(dot + 1).toLowerCase()
  return TYPES[ext] ?? 'application/octet-stream'
}

/**
 * Hashed files under `/assets/` never change under the same name, so they are
 * kept for a year. Everything else — `index.html` above all, which names the
 * hashes — is revalidated, or an update would keep running yesterday's page.
 */
export function cacheControl(path: string): string {
  return path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
}

/**
 * Answer one request for the page, or null when this is not a request for it.
 *
 * A path that names a file gets that file. A missing file under `/assets/` is a
 * 404 — handing a script tag an HTML document would be a syntax error that hides
 * the real fault. Any other path is the single-page app's own route and gets
 * `index.html`.
 */
export function servePage(files: PageFiles, request: Request, pathname: string): Response | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null

  let path: string
  try {
    path = decodeURIComponent(pathname)
  } catch {
    return new Response('Not found\n', { status: 404 })
  }
  if (path === '/' || path === '') path = '/index.html'

  let at = files.get(path)
  let served = path
  if (!at) {
    if (path.startsWith('/assets/')) return new Response('Not found\n', { status: 404 })
    at = files.get('/index.html')
    served = '/index.html'
    if (!at) return new Response('The page was not built into this host.\n', { status: 500 })
  }

  const headers = { 'content-type': contentType(served), 'cache-control': cacheControl(served) }
  if (request.method === 'HEAD') return new Response(null, { headers })
  return new Response(Bun.file(at), { headers })
}
