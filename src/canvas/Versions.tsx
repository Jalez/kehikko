import { Check, Tag } from 'lucide-react'
import { useCallback, useState } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import { fetchVersions, pinVersion, versionLabel, versionRows, type VersionListing } from '@/host/versions.ts'
import { Hint } from './Hint.tsx'

/**
 * The version in a container's header, as a control.
 *
 * ## What it shows, closed
 *
 * Latest looks as the version always looked: the module's own version string,
 * small and grey, the first thing to go in a narrow container. A PINNED
 * container is drawn differently on purpose — a tag icon and the tag, tinted,
 * and kept even when the container is narrow — because the failure this
 * guards against is a canvas quietly running an old version that nobody
 * remembers choosing.
 *
 * ## What it shows, open
 *
 * "Latest (what the checkout calls itself · its commit)", then the tags newest
 * first. A tag this host cannot speak to is marked `incompatible`; one the
 * data guard refuses for this project is marked `blocked`; both are disabled
 * with the reason written under them, not hidden, so a person can see the
 * version exists and why it is not offered. Choosing a tag pins the container;
 * choosing Latest unpins it. The list is read when it opens — the tags come
 * from the repository, see `server/versions.ts` — so it costs nothing while
 * nobody looks.
 */
export function VersionPicker({
  module,
  name,
  kehikko,
  pinned,
  current,
  protocol = null,
  onPicked,
}: {
  module: string
  name: string
  /** The open kehikko, which is what a pin is stored on. Null draws the plain version. */
  kehikko: number | null
  /** The tag this container is pinned to, or null for latest. */
  pinned: string | null
  /** What the running copy calls itself. */
  current: string | null
  /** The protocol package the running copy is built with, when it says. Said in the hint. */
  protocol?: string | null
  /** After a pin or unpin went through: the page re-reads the canvas and the modules. */
  onPicked(): void
}) {
  const [open, setOpen] = useState(false)
  const [listing, setListing] = useState<VersionListing | null>(null)
  const [trouble, setTrouble] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(
    async (fresh: boolean) => {
      if (kehikko === null) return
      setTrouble(null)
      try {
        setListing(await fetchVersions(module, kehikko, fresh))
      } catch (error) {
        setTrouble((error as Error).message)
      }
    },
    [module, kehikko],
  )

  const choose = async (tag: string | null) => {
    if (kehikko === null) return
    setBusy(tag ?? 'latest')
    setTrouble(null)
    try {
      await pinVersion(module, kehikko, tag)
      setOpen(false)
      onPicked()
    } catch (error) {
      setTrouble((error as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (kehikko === null && !pinned && !current) return null
  const label = versionLabel(pinned, current)

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) void load(false)
      }}
    >
      <Hint
        label={versionHint(name, pinned, protocol)}
        side="bottom"
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="version-control"
            data-pinned={pinned ? 'true' : 'false'}
            aria-label={pinned ? `${name}: pinned to ${pinned}` : `${name}: latest${current ? ` (${current})` : ''}`}
            onMouseDown={(event) => event.stopPropagation()}
            className={
              pinned
                ? 'pointer-events-auto inline-flex shrink-0 cursor-default items-center gap-0.5 rounded border border-amber-500/50 bg-amber-500/10 px-1 font-mono text-[10px] text-amber-700 dark:text-amber-300'
                : 'text-muted-foreground hover:text-foreground pointer-events-auto shrink-0 cursor-default font-mono text-[10px] @max-[300px]/container:hidden'
            }
          >
            {pinned ? <Tag className="size-2.5" /> : null}
            {label}
          </button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="start" className="w-72 p-1" onMouseDown={(event) => event.stopPropagation()}>
        {listing ? (
          <VersionList listing={listing} busy={busy} onChoose={(tag) => void choose(tag)} />
        ) : trouble ? null : (
          <p className="text-muted-foreground px-2 py-1.5 text-xs">Reading the versions of {name}…</p>
        )}
        {trouble ? <p className="text-destructive px-2 py-1.5 text-xs">{trouble}</p> : null}
        {listing ? (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground w-full px-2 py-1 text-left text-[11px]"
            onClick={() => void load(true)}
          >
            Look for new versions
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/**
 * What the version in a header says when pointed at: whether the container is
 * pinned, and the protocol package the running module is built with when it
 * states one.
 */
export function versionHint(name: string, pinned: string | null, protocol: string | null): string {
  const built = protocol ? ` · built with protocol ${protocol}` : ''
  return pinned
    ? `${name} is pinned to ${pinned} on this kehikko${built} — press to change`
    : `${name} runs latest${built} — press to pick a version`
}

/**
 * The list itself, with no popover around it — what the tests render.
 */
export function VersionList({
  listing,
  busy = null,
  onChoose,
}: {
  listing: VersionListing
  /** The row being pinned right now, `latest` for latest. */
  busy?: string | null
  onChoose(tag: string | null): void
}) {
  const rows = versionRows(listing)
  return (
    <div role="menu" aria-label={`versions of ${listing.name}`} className="flex flex-col">
      {rows.map((row) => (
        <button
          key={row.tag ?? 'latest'}
          type="button"
          role="menuitemradio"
          aria-checked={row.chosen}
          aria-disabled={row.disabled ? true : undefined}
          disabled={row.disabled !== null}
          data-version={row.tag ?? 'latest'}
          data-mark={row.mark ?? undefined}
          onClick={() => {
            if (!row.disabled && !row.chosen) onChoose(row.tag)
          }}
          className="hover:bg-accent flex w-full cursor-default flex-col items-start rounded-sm px-2 py-1 text-left text-xs disabled:opacity-60 disabled:hover:bg-transparent"
        >
          <span className="flex w-full items-center gap-1.5">
            <span className="flex size-3 shrink-0 items-center">{row.chosen ? <Check className="size-3" /> : null}</span>
            <span className={row.tag ? 'font-mono' : 'font-medium'}>{row.label}</span>
            {row.detail ? <span className="text-muted-foreground min-w-0 truncate text-[11px]">({row.detail})</span> : null}
            {row.mark ? (
              <span className="text-destructive ml-auto shrink-0 text-[10px] uppercase">{row.mark}</span>
            ) : busy === (row.tag ?? 'latest') ? (
              <span className="text-muted-foreground ml-auto shrink-0 text-[10px]">…</span>
            ) : null}
          </span>
          {row.disabled ? <span className="text-muted-foreground pl-4.5 text-[11px] leading-snug">{row.disabled}</span> : null}
        </button>
      ))}
      {listing.error ? <p className="text-destructive px-2 py-1 text-[11px]">{listing.error}</p> : null}
      {listing.hint ? (
        <p className="text-muted-foreground px-2 py-1 text-[11px]" data-testid="versions-hint">
          {listing.hint}
        </p>
      ) : null}
    </div>
  )
}
