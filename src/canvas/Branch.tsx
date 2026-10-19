import { GitBranch } from 'lucide-react'

import { branchWord, offMain, sourceHint, type Source } from '@/host/source.ts'
import { Hint } from './Hint.tsx'

/**
 * The branch a module is running from, in its container's header after the
 * version.
 *
 * Quiet in the plain case — `main`, level, clean, the registered folder —
 * styled like the version beside it and gone with it when the container is
 * narrow. Anything else is the amber chip a pinned version uses, kept at every
 * width, because a module running something other than what was merged is
 * exactly what a person needs to notice. The tooltip says the folder and why.
 */
export function BranchMark({ source }: { source: Source | null | undefined }) {
  if (!source) return null
  const marked = offMain(source).length > 0
  const hint = sourceHint(source)
  return (
    <Hint label={hint} side="bottom" align="start">
      <span
        data-testid="branch-mark"
        data-off-main={marked ? 'true' : 'false'}
        aria-label={hint}
        className={
          marked
            ? 'inline-flex shrink-0 cursor-default items-center gap-0.5 rounded border border-amber-500/50 bg-amber-500/10 px-1 font-mono text-[10px] text-amber-700 dark:text-amber-300'
            : 'text-muted-foreground shrink-0 cursor-default font-mono text-[10px] @max-[300px]/container:hidden'
        }
      >
        {marked ? <GitBranch className="size-2.5" aria-hidden /> : null}
        {branchWord(source)}
      </span>
    </Hint>
  )
}
