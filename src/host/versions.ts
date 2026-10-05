/**
 * The page's side of module versions: what the picker in a container's header
 * shows, and the two requests behind it. The deciding is all the server's —
 * `server/pins.ts` — and this only turns its answer into rows.
 */

/** One tag, as the server marks it for this kehikko. Mirrors `VersionEntry` in `server/pins.ts`. */
export interface VersionEntry {
  tag: string
  compatible: boolean | null
  incompatible: string | null
  dataVersion: number | null
  blocked: string | null
  prepared: boolean
  running: boolean
}

/** Mirrors `VersionListing` in `server/pins.ts`. */
export interface VersionListing {
  module: string
  name: string
  latest: { version: string | null; commit: string | null; dataVersion: number | null }
  pinned: string | null
  recorded: number | null
  versions: VersionEntry[]
  hint: string | null
  error: string | null
}

/** What one pinned container is doing. Mirrors `PinView` in `server/pins.ts`. */
export interface PinView {
  kehikko: number
  module: string
  version: string
  state: 'waiting' | 'preparing' | 'starting' | 'ready' | 'failed' | 'blocked' | 'incompatible'
  line: string
  presence: import('./registry.ts').Presence | null
}

/** One line of the picker. `tag` null is latest. */
export interface VersionRow {
  tag: string | null
  label: string
  /** The quieter words after the label: what latest is, data format, prepared. */
  detail: string | null
  /** Why it cannot be chosen, or null when it can. */
  disabled: string | null
  /** A word in front of the reason: `incompatible` (protocol) or `blocked` (data). */
  mark: 'incompatible' | 'blocked' | null
  chosen: boolean
}

/**
 * The picker's rows: latest first, then the tags newest first.
 *
 * A tag is disabled, and says why, when this host cannot speak its protocol
 * (`incompatible`) or the data guard refuses it here (`blocked`). The one the
 * container is pinned to is never disabled — it is where the container is,
 * and the person needs to be able to read why it is not running.
 */
export function versionRows(listing: VersionListing): VersionRow[] {
  const latestBits = [listing.latest.version, listing.latest.commit].filter(Boolean)
  const rows: VersionRow[] = [
    {
      tag: null,
      label: 'Latest',
      detail: latestBits.length ? `${latestBits.join(' · ')} — its checkout` : 'its checkout',
      disabled: null,
      mark: null,
      chosen: listing.pinned === null,
    },
  ]
  for (const one of listing.versions) {
    const chosen = listing.pinned === one.tag
    const mark: VersionRow['mark'] = one.compatible === false ? 'incompatible' : one.blocked ? 'blocked' : null
    const why =
      one.compatible === false
        ? (one.incompatible ?? 'this host cannot speak its protocol')
        : one.blocked
    const detail = [
      one.running ? 'running' : one.prepared ? 'ready' : null,
      one.dataVersion !== null ? `data ${one.dataVersion}` : null,
    ].filter(Boolean)
    rows.push({
      tag: one.tag,
      label: one.tag,
      detail: detail.length ? detail.join(' · ') : null,
      disabled: chosen ? null : (why ?? null),
      mark,
      chosen,
    })
  }
  return rows
}

/** The words on the control itself: the pinned tag, or what latest calls itself. */
export function versionLabel(pinned: string | null, current: string | null): string {
  return pinned ?? current ?? 'latest'
}

export async function fetchVersions(module: string, kehikko: number, fresh = false): Promise<VersionListing> {
  const query = new URLSearchParams({ module, kehikko: String(kehikko), ...(fresh ? { fresh: '1' } : {}) })
  const response = await fetch(`/host/versions?${query}`, { cache: 'no-store' })
  const body = (await response.json().catch(() => null)) as (VersionListing & { error?: string }) | null
  if (!response.ok || !body || !Array.isArray(body.versions)) {
    throw new Error(body?.error ?? `the host answered ${response.status}`)
  }
  return body
}

/** Pin a container, or unpin it with `null`. Resolves to the server's sentence; rejects with its refusal. */
export async function pinVersion(module: string, kehikko: number, version: string | null): Promise<string> {
  const response = await fetch('/host/versions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ module, kehikko, version }),
  })
  const body = (await response.json().catch(() => null)) as { text?: string; error?: string } | null
  if (!response.ok) throw new Error(body?.error ?? `the host answered ${response.status}`)
  return body?.text ?? ''
}

/**
 * What a container shows, given its module's latest presence and its pin.
 *
 * Latest (no `version`) is the module's own presence, untouched — exactly what
 * a container showed before versions existed.
 *
 * A pinned container that is READY shows the version's own presence: its
 * manifest, its entry on its own port, its version string. The module's id,
 * kept state and agent awareness stay the module's, because those are keyed by
 * module and not by version.
 *
 * A pinned container that is not ready shows the pin's sentence and never the
 * latest copy's page: being on its way (`silent` + `starting`, which draws
 * no Start button — that button would start latest), or refused (`incompatible`,
 * for a version that failed, is blocked by the data guard, or speaks another
 * protocol). `waiting` says the page must not frame anything for it.
 */
export function pinnedPresence(
  latest: import('./registry.ts').Presence | undefined,
  version: string | null,
  pin: PinView | undefined,
): { presence: import('./registry.ts').Presence | undefined; waiting: boolean } {
  if (!version || !latest) return { presence: latest, waiting: false }
  if (pin?.state === 'ready' && pin.presence?.module) {
    return {
      presence: {
        ...pin.presence,
        id: latest.id,
        name: latest.name ?? pin.presence.name,
        state: latest.state,
        agent: latest.agent,
      },
      waiting: false,
    }
  }
  const refused = pin !== undefined && (pin.state === 'failed' || pin.state === 'blocked' || pin.state === 'incompatible')
  return {
    presence: {
      ...latest,
      condition: refused ? 'incompatible' : 'silent',
      lifecycle: refused ? undefined : 'starting',
      line: pin?.line ?? `Preparing ${latest.name ?? latest.id} ${version}…`,
      module: undefined,
      protocols: undefined,
    },
    waiting: true,
  }
}
