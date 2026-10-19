import { FolderSync, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { followedSaid, sayFollowed, type Project } from '@/host/projects.ts'

/** How long the line stays before it goes by itself. */
const SHOWN_MS = 12_000

/**
 * The quiet line that says a project's folder was renamed or moved and the
 * host followed it there by itself (its bookmark; see `server/bookmarks.ts`).
 *
 * Said once: the moment a project with `followed` reaches the page, the host
 * is told (`sayFollowed`) and does not hand it out again, here or on another
 * page. The line itself goes after a few seconds or when closed. Nothing to
 * decide, so nothing to press but the close; "Locate…" is still there for the
 * folders the host could not follow.
 */
export function Followed({ projects }: { projects: readonly Project[] }) {
  const [lines, setLines] = useState<{ id: number; said: string }[]>([])

  useEffect(() => {
    const fresh = projects.flatMap((project) => {
      const said = followedSaid(project)
      return said ? [{ id: project.id, said }] : []
    })
    if (!fresh.length) return
    for (const { id } of fresh) void sayFollowed(id)
    setLines((was) => [...was.filter((line) => !fresh.some((one) => one.id === line.id)), ...fresh])
  }, [projects])

  useEffect(() => {
    if (!lines.length) return
    const gone = setTimeout(() => setLines([]), SHOWN_MS)
    return () => clearTimeout(gone)
  }, [lines])

  if (!lines.length) return null
  return (
    <div
      role="status"
      data-followed=""
      className="bg-popover text-popover-foreground fixed bottom-3 left-1/2 z-50 flex max-w-[min(90vw,32rem)] -translate-x-1/2 items-start gap-2 rounded-md border px-3 py-2 text-xs shadow-sm"
    >
      <FolderSync className="text-muted-foreground mt-px size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-0.5">
        {lines.map((line) => (
          <p key={line.id} className="break-all">
            {line.said}
          </p>
        ))}
      </div>
      <button
        type="button"
        aria-label="Close"
        onClick={() => setLines([])}
        className="text-muted-foreground hover:text-foreground shrink-0"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  )
}
