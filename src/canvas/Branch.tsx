import { GitBranch } from 'lucide-react'

import { branchWord, offMain, sourceHint, type Source } from '@/host/source.ts'
import { Hint } from './Hint.tsx'

/**
 * The branch a module is running from, in its container's header after the
 * version.
 *
 * Quiet in the plain case — `main` level with its branch, or a release; clean; the registered folder —
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
            ? 'inline-flex min-w-5 shrink-[50] cursor-default items-center gap-0.5 rounded border border-amber-500/50 bg-amber-500/10 px-1 font-mono text-[10px] text-amber-700 dark:text-amber-300'
            : 'text-muted-foreground flex min-w-5 shrink-[50] cursor-default items-center font-mono text-[10px] @max-[300px]/container:hidden'
        }
      >
        {marked ? <GitBranch className="size-2.5 shrink-0" aria-hidden /> : null}
        <span data-testid="branch-label" className="min-w-0 truncate @max-[220px]/container:hidden">{branchWord(source)}</span>
      </span>
    </Hint>
  )
}
