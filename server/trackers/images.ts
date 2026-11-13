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
 */

/** A tracker's own upload hosts, beside the host it runs on. Only github.com has any the host knows by name. */
const UPLOAD_HOSTS: Record<string, readonly string[]> = {
  'github.com': [
    'user-images.githubusercontent.com',
    'private-user-images.githubusercontent.com',
    'objects.githubusercontent.com',
    'raw.githubusercontent.com',
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
  if (bytes.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (bytes.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (bytes.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return 'image/gif'
  if (bytes.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  if (bytes.length >= 12 && at(4, 0x66, 0x74, 0x79, 0x70) && at(8, 0x61, 0x76, 0x69, 0x66)) return 'image/avif'
  return null
}

export interface ImageFetch {
  /** The person's token for a tracker host, or null when not signed in. Held only for the one request. */
  token(tracker: TrackerRow['tracker'], host: string): Promise<string | null>
  fetch: (url: string, init: { headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal }) => Promise<Response>
}

const declined = (why: TrackerImageRefusal): TrackerImage => ({ outcome: 'declined', why })

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

/** The answer to `tracker.image` for one item's picture. */
export async function fetchTrackerImage(row: Pick<TrackerRow, 'tracker' | 'host'>, address: string, io: ImageFetch): Promise<TrackerImage> {
  const allowed = imageHostsOf(row)
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return declined('host')
  }
  const own = row.host.toLowerCase()
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'https:' || url.username || url.password || !allowed.includes(url.hostname.toLowerCase()) || (url.port && url.port !== '443')) {
      return declined('host')
    }
    if (hop > MAX_HOPS) return declined('unreadable')
    const headers: Record<string, string> = { accept: 'image/*' }
    if (url.hostname.toLowerCase() === own) {
      const token = await io.token(row.tracker, own).catch(() => null)
      if (token) {
        if (row.tracker === 'gitlab') headers['private-token'] = token
        else headers.authorization = `Bearer ${token}`
      }
    }
    let res: Response
    try {
      res = await io.fetch(url.href, { headers, redirect: 'manual', signal: AbortSignal.timeout(FETCH_MS) })
    } catch {
      return declined('unreadable')
    }
    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get('location')
      if (!to) return declined('unreadable')
      try {
        url = new URL(to, url)
      } catch {
        return declined('host')
      }
      continue
    }
    if (!res.ok) return declined('unreadable')
    const said = Number(res.headers.get('content-length'))
    if (Number.isFinite(said) && said > LIMITS.TRACKER_IMAGE_BYTES) return declined('size')
    let bytes: Uint8Array | null
    try {
      bytes = await readCapped(res, LIMITS.TRACKER_IMAGE_BYTES)
    } catch {
      return declined('unreadable')
    }
    if (!bytes) return declined('size')
    const mime = sniffImage(bytes)
    if (!mime || !(TRACKER_IMAGE_TYPES as readonly string[]).includes(mime)) return declined('type')
    return { outcome: 'image', mime, base64: Buffer.from(bytes).toString('base64') }
  }
}
