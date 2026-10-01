import { MessageSquare } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { cachedFeedback, fetchFeedback, sendFeedback, type Listing, type Status } from '@/host/feedback.ts'
import { Hint } from './Hint.tsx'
import { AddItem } from './Menu.tsx'

/**
 * Feedback on a module: the GitHub issues this person opened in its
 * repository, each with its live status, and a way to open a new one.
 *
 * A host control rather than the module's — every module has a repository and
 * none has to ask for this — so it is on every container, folded or not, and
 * sits beside the tools plug, the other thing the host says about a module as
 * a program rather than about what it is showing. The repository and the
 * account are the server's business; see `server/feedback.ts`.
 */
export function FeedbackButton({
  module,
  name,
  kehikko,
  epic,
}: {
  module: string
  name: string
  /** The open kehikko's name and epic slug, for the line under the issue. */
  kehikko: string | null
  epic: string | null
}) {
  const [listing, setListing] = useState<Listing | null>(() => cachedFeedback(module))
  const [loading, setLoading] = useState(false)
  const [trouble, setTrouble] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)
  const asking = useRef<AbortController | null>(null)

  /* Asked every time the menu opens: an issue's status changes on GitHub, not
     here, and the server's minute of cache is what keeps this from being a
     request per glance. */
  const load = useCallback(async () => {
    asking.current?.abort()
    const stop = new AbortController()
    asking.current = stop
    setLoading(true)
    try {
      setListing(await fetchFeedback(module, stop.signal))
      setTrouble(null)
    } catch (error) {
      if (stop.signal.aborted) return
      setTrouble((error as Error).message)
    } finally {
      if (!stop.signal.aborted) setLoading(false)
    }
  }, [module])

  useEffect(() => () => asking.current?.abort(), [])

  const items = listing?.items ?? []
  const line = trouble
    ? trouble
    : !listing
      ? loading
        ? 'reading GitHub…'
        : null
      : items.length === 0
        ? 'No feedback from you yet'
        : null

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) void load()
          else asking.current?.abort()
        }}
      >
        <Hint label={`feedback: what you have told ${name}'s authors, and something new`} side="bottom">
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`feedback on ${name}`}
              /* `pointer-events-auto` because the container is not — see `Tools.tsx`. */
              className="text-muted-foreground hover:text-foreground pointer-events-auto size-6 cursor-default"
              /* Stops the grid reading the press as the start of a drag. */
              onMouseDown={(event) => event.stopPropagation()}
            >
              <MessageSquare className="size-3" />
            </Button>
          </DropdownMenuTrigger>
        </Hint>

        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuLabel className="truncate">
            your feedback{listing ? <span className="font-mono font-normal"> · {listing.repo}</span> : null}
          </DropdownMenuLabel>
          {items.map((item) => (
            <DropdownMenuItem
              key={item.number}
              className="cursor-default text-xs"
              title={item.url}
              onSelect={() => window.open(item.url, '_blank', 'noopener,noreferrer')}
            >
              <span className="text-muted-foreground shrink-0 font-mono text-[10px]">#{item.number}</span>
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              <StatusBadge status={item.status} />
            </DropdownMenuItem>
          ))}
          {line ? <p className="text-muted-foreground px-2 py-1.5 text-xs">{line}</p> : null}
          <AddItem onAdd={() => setWriting(true)}>new feedback…</AddItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <FeedbackDialog
        open={writing}
        onOpenChange={setWriting}
        module={module}
        name={name}
        repo={listing?.repo ?? null}
        kehikko={kehikko}
        epic={epic}
        onSent={() => setListing(cachedFeedback(module))}
      />
    </>
  )
}

const STATUS_LOOK: Record<Status, string> = {
  open: 'text-foreground',
  completed: 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  'not planned': 'border-transparent bg-muted text-muted-foreground',
  closed: 'border-transparent bg-muted text-muted-foreground',
}

function StatusBadge({ status }: { status: Status }) {
  return (
    <Badge variant="outline" className={`px-1.5 py-0 text-[10px] font-normal ${STATUS_LOOK[status]}`}>
      {status}
    </Badge>
  )
}

/**
 * A new issue, written in the host's own modal.
 *
 * A refusal keeps the dialog and what was typed in it, with the server's
 * sentence; only a send that landed closes it.
 */
function FeedbackDialog({
  open,
  onOpenChange,
  module,
  name,
  repo,
  kehikko,
  epic,
  onSent,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  module: string
  name: string
  repo: string | null
  kehikko: string | null
  epic: string | null
  onSent(): void
}) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [trouble, setTrouble] = useState<string | null>(null)

  const send = async () => {
    if (!title.trim() || sending) return
    setSending(true)
    setTrouble(null)
    try {
      await sendFeedback({ module, title, body, kehikko, epic })
      setTitle('')
      setBody('')
      onSent()
      onOpenChange(false)
    } catch (error) {
      setTrouble((error as Error).message)
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !sending && onOpenChange(next)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Feedback on {name}</DialogTitle>
          <DialogDescription>
            This will be posted as a GitHub issue in{' '}
            {repo ? <span className="font-mono">{repo}</span> : "this module's repository"} under your account, with a
            line saying which module version, kehikko and epic it came from.
          </DialogDescription>
        </DialogHeader>

        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          aria-label="title"
          placeholder="Title"
          maxLength={200}
          disabled={sending}
          autoFocus
          onKeyDown={(event) => {
            if (event.key === 'Enter') void send()
          }}
        />
        <Textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          aria-label="description"
          placeholder="What happened, or what you would like"
          maxLength={20_000}
          disabled={sending}
          className="max-h-[50vh] min-h-32"
        />

        {trouble ? <p className="text-destructive text-xs">{trouble}</p> : null}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={sending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={sending || !title.trim()} onClick={() => void send()}>
            {sending ? 'Sending…' : 'Send feedback'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
