import { FolderSearch, FolderX } from 'lucide-react'

import { Button } from '@/components/ui/button.tsx'
import type { Project } from '@/host/projects.ts'
import { Hint } from './Hint.tsx'

/**
 * A project whose folder is gone: moved, renamed or deleted since it was added.
 *
 * The host keeps the row — the person's kehikot are in it, and forgetting a
 * project is their decision — but it writes nothing under the old path and
 * draws no canvas there, because every module on it would be told a folder that
 * is not on the disk. What the person sees instead is the one sentence below,
 * in the list and on the canvas alike.
 */
export const MISSING_SAID = "Kehikot can't find this folder any more. It was moved, renamed or deleted."

/** The words on the project's row in the list, beside its name. */
export const MISSING_WORDS = 'moved or renamed'

/** The mark on a missing project's row, with the sentence as its tooltip. */
export function MissingMark() {
  return (
    <Hint label={MISSING_SAID} align="end">
      <span className="text-muted-foreground shrink-0 text-[10px] italic" aria-label={MISSING_SAID}>
        {MISSING_WORDS}
      </span>
    </Hint>
  )
}

/** What the canvas shows when the open project's folder is gone. */
export function MissingProject({
  project,
  onLocate,
}: {
  project: Pick<Project, 'name' | 'path'>
  /** "Locate…": the folder browser, to point this project at where its folder went. See `Locate.tsx`. */
  onLocate?: () => void
}) {
  return (
    <div
      role="status"
      data-missing-project=""
      className="text-muted-foreground absolute inset-x-0 top-1/3 mx-auto flex max-w-md flex-col items-center gap-2 px-4 text-center text-sm"
    >
      <FolderX className="size-5" aria-hidden />
      <p className="text-foreground">{MISSING_SAID}</p>
      <p className="font-mono text-[11px] break-all">{project.path}</p>
      <p className="text-[11px]">Nothing is written there while it is missing.</p>
      {/* Where the folder went, said by the person: the host checks that the
          folder carries this project's id, and keeps its kehikot and Inbox. */}
      {onLocate ? (
        <Button variant="outline" size="sm" className="mt-1 h-7 gap-1.5 text-xs" onClick={onLocate}>
          <FolderSearch className="size-3.5" aria-hidden />
          Locate…
        </Button>
      ) : null}
    </div>
  )
}
