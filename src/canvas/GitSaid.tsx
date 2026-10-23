import { useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { splitSaid } from '@/host/gitSaid.ts'

/**
 * The host's sentence about a git failure, its command shown as text with a
 * Copy button. Never run for the person, and never rendered as markup.
 */
export function GitSaid({ said }: { said: string }) {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (command: string) => {
    void navigator.clipboard?.writeText(command).then(
      () => setCopied(command),
      () => setCopied(null),
    )
  }
  return (
    <>
      {splitSaid(said).map((part, at) =>
        part.command ? (
          <span key={at} className="whitespace-nowrap">
            <code className="bg-muted text-foreground rounded px-1 py-0.5 font-mono select-all" data-git-command>
              {part.text}
            </code>
            <Button type="button" variant="ghost" size="sm" className="ml-1 h-5 px-1.5 text-[10px]" onClick={() => copy(part.text)}>
              {copied === part.text ? 'Copied' : 'Copy'}
            </Button>
          </span>
        ) : (
          <span key={at}>{part.text}</span>
        ),
      )}
    </>
  )
}
