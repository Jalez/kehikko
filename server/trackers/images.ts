import { LIMITS, TRACKER_IMAGE_TYPES, type TrackerImage, type TrackerImageRefusal, type TrackerImageType, type TrackerRow } from 'kehikot-module-protocol'

/**
 * `tracker.image` (protocol 2.101.0): one picture out of an item's description or a comment, fetched
 * here, with the person's own sign-in, because it sits behind it and a page must never hold a
 * credential or load an address itself.
 *
 * What is fetched is decided by this file alone:
 * - `https:` only, on the item's own tracker host or that tracker's known upload hosts. Anything else
 *   is declined as `host` without a request, so a page cannot make this host fetch an arbitrary
 *   address (no tracking pixel, no probing of the local network).
 * - The sign-in goes only to the item's own host, never to an upload host and never after a redirect
 *   to another host; a redirect is followed by hand, a few hops, each checked again.
 * - What comes back is judged by its bytes, not its header: png, jpeg, gif, webp or avif, never SVG.
 * - At most `LIMITS.TRACKER_IMAGE_BYTES`, counted as it arrives, so a body that lies about its size
 *   is cut off.
 *
 * How each tracker really serves its pictures (checked against the live services, 2026-11; the
 * shapes are in `test/fixtures/tracker-images.ts`):
 * - A GitLab upload (`/uploads/<secret>/<file>`, written relative to the PROJECT, or
 *   `/-/project/<id>/uploads/…`) is a web route: a token is not accepted there and a private project
 *   answers with its sign-in page. It is read through the API instead
 *   (`/api/v4/projects/:id/uploads/:secret/:filename`), with the person's own `glab`, so their
 *   sign-in works however it is kept (config, keychain, OAuth with refresh, a company CA). A page that
 *   resolved `/uploads/…` against the server root is read as the item's own project. An older GitLab
 *   without that route gets the web address as a last try (public projects only).
 * - A GitHub attachment (`github.com/user-attachments/assets/<id>`, `github.com/<o>/<r>/assets/…`)
 *   redirects to GitHub's own storage bucket with a short-lived signature. On a private repository it
 *   does not answer a token at all: the signed address is in the item's rendered HTML, which the API
 *   gives the person's own `gh`, so that is asked when the attachment itself gives no picture.
 *
 * Every answer carries `said`: why, in a sentence for `host.log`, so a picture that does not show is
 * diagnosable on the person's machine. It never holds a token or an address's query.
 */

/** A tracker's own upload hosts, beside the host it runs on. Only github.com has any the host knows by name. */
const UPLOAD_HOSTS: Record<string, readonly string[]> = {
  'github.com': [
    'user-images.githubusercontent.com',
    'private-user-images.githubusercontent.com',
    'objects.githubusercontent.com',
    'raw.githubusercontent.com',
    /* Where `user-attachments/assets/…` and `<o>/<r>/assets/…` redirect: GitHub's own buckets, by full name. */
    'github-production-user-asset-6210df.s3.amazonaws.com',
    'github-cloud.s3.amazonaws.com',
  ],
}

const MAX_HOPS = 4
const FETCH_MS = 15_000

/** The hosts an image of this item may come from. */
export function imageHostsOf(row: Pick<TrackerRow, 'host'>): readonly string[] {
  return [row.host.toLowerCase(), ...(UPLOAD_HOSTS[row.host.toLowerCase()] ?? [])]
}

/** The image type the first bytes say, or nothing. */
export function sniffImage(bytes: Uint8Array): TrackerImageType | null {
  const at = (i: number, ...v: number[]) => v.every((b, k) => bytes[i + k] === b)
  const ascii = (i: number, s: string) => at(i, ...[...s].map((c) => c.charCodeAt(0)))
  if (bytes.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (bytes.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (bytes.length >= 6 && (ascii(0, 'GIF87a') || ascii(0, 'GIF89a'))) return 'image/gif'
  if (bytes.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  /* An AVIF still (`avif`) or sequence (`avis`), as the major brand. */
  if (bytes.length >= 12 && ascii(4, 'ftyp') && (ascii(8, 'avif') || ascii(8, 'avis'))) return 'image/avif'
  return null
}

/** What reading through a tracker's own CLI gave: the bytes, or why not. */
export type CliBytes = { bytes: Uint8Array } | { tooBig: true } | { failed: string; notFound?: boolean }

export interface ImageFetch {
  /** The person's token for a tracker host, or null when not signed in. Held only for the one request. */
  token(tracker: TrackerRow['tracker'], host: string): Promise<string | null>
  fetch: (url: string, init: { headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal }) => Promise<Response>
  /** A GitLab API path (`projects/…/uploads/…`) read with the person's own `glab`, as bytes, at most `limit`. */
  gitlabApi?: (host: string, path: string, limit: number) => Promise<CliBytes>
  /** The rendered HTML of a GitHub item's description and comments, read with the person's own `gh`; null when it cannot be. */
  githubHtml?: (host: string, repo: string, number: number) => Promise<string[] | null>
}

/** An answer, and why, for the log. */
export interface Fetched {
  image: TrackerImage
  said: string
}

type Row = Pick<TrackerRow, 'tracker' | 'host' | 'repo' | 'number'>

const declined = (why: TrackerImageRefusal, said: string): Fetched => ({ image: { outcome: 'declined', why }, said })

/** An address as it may be written to a log: no query (a signature), no fragment. */
export function shownAddress(address: string): string {
  try {
    const url = new URL(address)
    return `${url.origin}${url.pathname}`
  } catch {
    return '(not an address)'
  }
}

/** Reads at most `limit` bytes of a body; null when it is longer. */
async function readCapped(res: Response, limit: number): Promise<Uint8Array | null> {
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer())
    return all.byteLength > limit ? null : all
  }
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/** Bytes judged: an image of an allowed type, or `type`. */
function judged(bytes: Uint8Array, from: string): Fetched {
  const mime = sniffImage(bytes)
  if (!mime || !(TRACKER_IMAGE_TYPES as readonly string[]).includes(mime)) {
    const start = new TextDecoder().decode(bytes.slice(0, 16)).replace(/[^\x20-\x7e]/g, '.')
    return declined('type', `${from} answered ${bytes.byteLength} bytes that are not a png, jpeg, gif, webp or avif (they start "${start}")`)
  }
  return { image: { outcome: 'image', mime, base64: Buffer.from(bytes).toString('base64') }, said: `${mime}, ${bytes.byteLength} bytes, from ${from}` }
}

const allowedUrl = (url: URL, allowed: readonly string[]) =>
  url.protocol === 'https:' && !url.username && !url.password && allowed.includes(url.hostname.toLowerCase()) && (!url.port || url.port === '443')

/** Fetches one address by hand, hop by hop: every hop on an allowed host, the token only on the item's own. */
async function fetchByHand(row: Row, start: URL, io: ImageFetch): Promise<Fetched> {
  const allowed = imageHostsOf(row)
  const own = row.host.toLowerCase()
  let url = start
  for (let hop = 0; ; hop++) {
    if (!allowedUrl(url, allowed)) {
      return declined('host', hop === 0
        ? `${shownAddress(url.href)} is not on ${own} or one of its upload hosts`
        : `${shownAddress(start.href)} redirected to ${shownAddress(url.href)}, which is not on ${own} or one of its upload hosts`)
    }
    if (hop > MAX_HOPS) return declined('unreadable', `${shownAddress(start.href)} redirected more than ${MAX_HOPS} times`)
    const headers: Record<string, string> = { accept: 'image/*' }
    if (url.hostname.toLowerCase() === own) {
      const token = await io.token(row.tracker, own).catch(() => null)
      if (token) headers.authorization = `Bearer ${token}`
    }
    let res: Response
    try {
      res = await io.fetch(url.href, { headers, redirect: 'manual', signal: AbortSignal.timeout(FETCH_MS) })
    } catch (error) {
      return declined('unreadable', `${shownAddress(url.href)} could not be reached: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get('location')
      if (!to) return declined('unreadable', `${shownAddress(url.href)} answered ${res.status} with nowhere to go`)
      try {
        url = new URL(to, url)
      } catch {
        return declined('host', `${shownAddress(url.href)} redirected to something that is not an address`)
      }
      continue
    }
    if (!res.ok) return declined('unreadable', `${shownAddress(url.href)} answered HTTP ${res.status}`)
    const said = Number(res.headers.get('content-length'))
    if (Number.isFinite(said) && said > LIMITS.TRACKER_IMAGE_BYTES) return declined('size', `${shownAddress(url.href)} is ${said} bytes, over ${LIMITS.TRACKER_IMAGE_BYTES}`)
    let bytes: Uint8Array | null
    try {
      bytes = await readCapped(res, LIMITS.TRACKER_IMAGE_BYTES)
    } catch (error) {
      return declined('unreadable', `${shownAddress(url.href)} broke off: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!bytes) return declined('size', `${shownAddress(url.href)} sent more than ${LIMITS.TRACKER_IMAGE_BYTES} bytes`)
    return judged(bytes, shownAddress(url.href))
  }
}

const SECRET = '[0-9a-f]{32}'
const FILE = '[^/]+'

/**
 * A GitLab upload on the item's own host, as the API route that reads it and the web address to try
 * when that route is missing; null for any other address. The forms:
 * - `/-/project/<id>/uploads/<secret>/<file>` and `/-/group/<id>/uploads/…` (what GitLab writes now);
 * - `/<project path>/uploads/<secret>/<file>` (a relative upload read against its project);
 * - `/uploads/<secret>/<file>` (one read against the server root by a page that did not know the
 *   project): the item's own project, which is what GitLab means by it.
 */
export function gitlabUpload(row: Pick<TrackerRow, 'host' | 'repo'>, url: URL): { api: string; web: string } | null {
  if (url.hostname.toLowerCase() !== row.host.toLowerCase()) return null
  const path = url.pathname
  const byId = new RegExp(`^/-/(project|group)/(\\d+)/uploads/(${SECRET})/(${FILE})$`).exec(path)
  if (byId) {
    const [, kind, id, secret, file] = byId
    return { api: `${kind === 'group' ? 'groups' : 'projects'}/${id}/uploads/${secret}/${file}`, web: url.href }
  }
  const atRoot = new RegExp(`^/uploads/(${SECRET})/(${FILE})$`).exec(path)
  const inProject = new RegExp(`^/(?!-/)(.+?)/uploads/(${SECRET})/(${FILE})$`).exec(path)
  const project = atRoot ? row.repo : inProject && !inProject[1]!.includes('/-/') ? decodeURIComponent(inProject[1]!) : null
  const secret = atRoot ? atRoot[1] : inProject?.[2]
  const file = atRoot ? atRoot[2] : inProject?.[3]
  if (!project || !secret || !file) return null
  return {
    api: `projects/${encodeURIComponent(project)}/uploads/${secret}/${file}`,
    web: `https://${row.host.toLowerCase()}/${project.split('/').map(encodeURIComponent).join('/')}/uploads/${secret}/${file}`,
  }
}

/** The attachment id of a GitHub attachment address on github.com, or null. */
export function githubAttachment(row: Pick<TrackerRow, 'host'>, url: URL): string | null {
  if (url.hostname.toLowerCase() !== row.host.toLowerCase()) return null
  const m = /^\/(?:user-attachments\/assets|[^/]+\/[^/]+\/assets\/\d+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(url.pathname)
  return m ? m[1]!.toLowerCase() : null
}

/** The signed address GitHub rendered for an attachment, out of an item's HTML: an `img` on its private-images host naming the id. */
export function signedAttachment(html: readonly string[], id: string): string | null {
  for (const one of html) {
    for (const m of one.matchAll(/<img\b[^>]*?\bsrc="([^"]+)"/gi)) {
      const src = m[1]!.replaceAll('&amp;', '&')
      try {
        const url = new URL(src)
        if (url.hostname === 'private-user-images.githubusercontent.com' && url.pathname.toLowerCase().includes(id)) return url.href
      } catch {
        /* not an address */
      }
    }
  }
  return null
}

/** The answer to `tracker.image` for one item's picture, and why. */
export async function fetchTrackerImage(row: Row, address: string, io: ImageFetch): Promise<Fetched> {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return declined('host', 'the address is not an absolute address')
  }
  if (!allowedUrl(url, imageHostsOf(row))) return declined('host', `${shownAddress(address)} is not on ${row.host} or one of its upload hosts`)

  if (row.tracker === 'gitlab') {
    const upload = gitlabUpload(row, url)
    if (upload && io.gitlabApi) {
      const read = await io.gitlabApi(row.host.toLowerCase(), upload.api, LIMITS.TRACKER_IMAGE_BYTES).catch((error: unknown): CliBytes => ({ failed: String(error) }))
      if ('bytes' in read) return judged(read.bytes, `${row.host} api/v4/${upload.api.replace(/\/[^/]+$/, '/…')}`)
      if ('tooBig' in read) return declined('size', `the upload ${shownAddress(upload.web)} is more than ${LIMITS.TRACKER_IMAGE_BYTES} bytes`)
      if (!read.notFound) return declined('unreadable', `the API would not give the upload ${shownAddress(upload.web)}: ${read.failed}`)
      /* An older GitLab without the uploads route: the web address, which answers for a public project. */
      const web = await fetchByHand(row, new URL(upload.web), io)
      if (web.image.outcome === 'image') return web
      return { image: web.image, said: `the API has no upload route here (${read.failed}), and the web address: ${web.said}` }
    }
    return fetchByHand(row, upload ? new URL(upload.web) : url, io)
  }

  const direct = await fetchByHand(row, url, io)
  if (direct.image.outcome === 'image') return direct
  const attachment = row.tracker === 'github' ? githubAttachment(row, url) : null
  if (!attachment || !io.githubHtml || direct.image.why === 'size') return direct
  /* A private repository's attachment answers nothing to a token: its signed address is in the item's HTML. */
  const html = await io.githubHtml(row.host.toLowerCase(), row.repo, row.number).catch(() => null)
  if (!html) return { image: direct.image, said: `${direct.said}; and the item's rendered text could not be read` }
  const signed = signedAttachment(html, attachment)
  if (!signed) return { image: direct.image, said: `${direct.said}; and the item's rendered text does not hold that attachment` }
  const viaSigned = await fetchByHand(row, new URL(signed), io)
  if (viaSigned.image.outcome === 'image') return viaSigned
  return { image: viaSigned.image, said: `${direct.said}; and its signed address: ${viaSigned.said}` }
}
