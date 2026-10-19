import { FolderX } from 'lucide-react'

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
export function MissingProject({ project }: { project: Pick<Project, 'name' | 'path'> }) {
  return (
    <div
      role="status"
      data-missing-project=""
      className="text-muted-foreground absolute inset-x-0 top-1/3 mx-auto flex max-w-md flex-col items-center gap-2 px-4 text-center text-sm"
    >
      <FolderX className="size-5" aria-hidden />
      <p className="text-foreground">{MISSING_SAID}</p>
      <p className="font-mono text-[11px] break-all">{project.path}</p>
      {/*
       * LOCATE — the next change goes here: a "Locate…" button that opens the
       * folder browser and points this project at where the folder went,
       * keeping its kehikot. Not built yet; until then the person can forget
       * the project and add the folder again from the project list.
       */}
      <p className="text-[11px]">Nothing is written there while it is missing.</p>
    </div>
  )
}
