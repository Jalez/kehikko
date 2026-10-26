import { GitBranch } from 'lucide-react'

import { branchWord, offMain, sourceHint, type Source } from '@/host/source.ts'
import { Hint } from './Hint.tsx'

/**
 * The branch a module is running from, in its container's header after the
 * version.
 *
 * Quiet in the plain case — `main` level with its branch, or a release; clean; the registered folder —
 * styled like the version beside it. Its words give way to its icon first when the
 * container is narrow (`host/headerFit.ts`). Anything else is the amber chip a pinned version uses, kept at every
 * width, because a module running something other than what was merged is
 * exactly what a person needs to notice. The tooltip says the folder and why.
 */
export function BranchMark({ source, text = true, quiet = true }: { source: Source | null | undefined; text?: boolean; quiet?: boolean }) {
  if (!source) return null
  const marked = offMain(source).length > 0
  if (!marked && !quiet) return null
  const hint = sourceHint(source)
  return (
    <Hint label={hint} side="bottom" align="start">
      <span
        data-testid="branch-mark"
        data-off-main={marked ? 'true' : 'false'}
        aria-label={hint}
        data-text={text ? 'true' : 'false'}
        className={`inline-flex shrink-[50] cursor-default items-center gap-0.5 overflow-hidden font-mono text-[10px] ${text ? 'max-w-[18ch] min-w-[9ch]' : 'min-w-[18px]'} ${
          marked
            ? 'rounded border border-amber-500/50 bg-amber-500/10 px-1 text-amber-700 dark:text-amber-300'
            : 'text-muted-foreground px-0.5'
        }`}
      >
        <GitBranch className="size-2.5 shrink-0" aria-hidden />
        {text ? <span data-testid="branch-label" className="min-w-0 truncate">{branchWord(source)}</span> : null}
      </span>
    </Hint>
  )
}
