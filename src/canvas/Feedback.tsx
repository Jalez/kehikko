import { useCallback, useEffect, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal.tsx'
import { DropdownMenuItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Loading, Skeleton, useSlow } from '@/components/ui/loading.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { cachedFeedback, fetchFeedback, sendFeedback, type Listing, type Status } from '@/host/feedback.ts'
import { AddItem } from './Menu.tsx'

/*
 * Feedback on a module, or on Kehikot itself: the GitHub issues this person opened in its
 * repository, each with its live status, and a way to open a new one. The "Feedback" row of a Help
 * menu — the bar's for Kehikot (`Help.tsx`), a container's for its module (`HeaderMenus.tsx`) — with
 * the list beside it. A host control rather than the module's: every module has a repository and
 * none has to ask for this. The repository and the account are the server's business; see
 * `server/feedback.ts`.
 */

/**
 * What one module's feedback list holds, for whichever menu is showing it.
 *
 * One per Help menu, and wherever that menu's Feedback row is drawn — a container's "?" or the
 * Help section of its "⋯" — one reading and one dialog behind it, so the list is the same list
 * wherever it is opened from.
 */
export interface FeedbackState {
  listing: Listing | null
  /** The one line said instead of, or under, the list: reading, a refusal, or that there is none yet. */
  line: string | null
  /** The list is being read and there is nothing cached to show meanwhile. */
  loading: boolean
  /** Reading has gone on past `SLOW_AFTER_MS`. */
  slow: boolean
  /** Stop waiting for GitHub. */
  cancel(): void
  /** Reading stopped by the person: the list offers Try again. */
  stopped: boolean
  retry(): void
  /** The menu showing this opened or closed: read on the way in, stop reading on the way out. */
  opened(open: boolean): void
  writing: boolean
  write(writing: boolean): void
  /** A send landed: show what is cached now. */
  sent(): void
}

export function useFeedback(module: string): FeedbackState {
  const [listing, setListing] = useState<Listing | null>(() => cachedFeedback(module))
  const [loading, setLoading] = useState(false)
  const [trouble, setTrouble] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)
  const [stopped, setStopped] = useState(false)
  const asking = useRef<AbortController | null>(null)

  /* Asked every time the menu opens: an issue's status changes on GitHub, not
     here, and the server's minute of cache is what keeps this from being a
     request per glance. */
  const load = useCallback(async () => {
    asking.current?.abort()
    const stop = new AbortController()
    asking.current = stop
    setLoading(true)
    setStopped(false)
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

  const opened = useCallback(
    (open: boolean) => {
      if (open) void load()
      else asking.current?.abort()
    },
    [load],
  )
  const cancel = useCallback(() => {
    asking.current?.abort()
    setLoading(false)
    setStopped(true)
  }, [])
  const retry = useCallback(() => void load(), [load])
  const slow = useSlow(loading)
  const sent = useCallback(() => setListing(cachedFeedback(module)), [module])

  const line = trouble
    ? trouble
    : !listing
      ? stopped
        ? 'Stopped waiting for GitHub.'
        : null
      : listing.items.length === 0
        ? 'No feedback from you yet'
        : null

  return { listing, line, loading: loading && !listing, slow, cancel, stopped, retry, opened, writing, write: setWriting, sent }
}

/** The list itself: what was sent, each with its status, and the way to send something new. */
export function FeedbackRows({ feedback }: { feedback: FeedbackState }) {
  const { listing, line } = feedback
  const waiting = feedback.loading
  return (
    <>
      <DropdownMenuLabel className="truncate">
        your feedback{listing ? <span className="font-mono font-normal"> · {listing.repo}</span> : null}
      </DropdownMenuLabel>
      {(listing?.items ?? []).map((item) => (
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
      {waiting ? <FeedbackWaiting feedback={feedback} /> : null}
      {line ? <p className="text-muted-foreground px-2 py-1.5 text-xs">{line}</p> : null}
      {feedback.stopped && !waiting ? (
        <DropdownMenuItem
          className="cursor-default text-xs"
          onSelect={(event) => {
            event.preventDefault()
            feedback.retry()
          }}
        >
          Try again
        </DropdownMenuItem>
      ) : null}
      <AddItem onAdd={() => feedback.write(true)}>new feedback…</AddItem>
    </>
  )
}

/**
 * While the list is first read: the app's spinner on top, and three rows the
 * shape of feedback items pulsing under it, so the menu does not jump when the
 * list lands. Past 8 s a quiet line says GitHub is slow, with a way out.
 */
function FeedbackWaiting({ feedback }: { feedback: FeedbackState }) {
  return (
    <div className="px-2 py-1.5" data-testid="feedback-loading">
      <Loading label="Reading feedback from GitHub…" />
      <div className="mt-2 space-y-2" aria-hidden>
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-2">
            <Skeleton className="h-3 w-7 shrink-0" />
            <Skeleton className="h-3 min-w-0 flex-1" />
            <Skeleton className="h-4 w-10 shrink-0 rounded-full" />
          </div>
        ))}
      </div>
      {feedback.slow ? (
        <p className="text-muted-foreground mt-2 text-xs" data-testid="feedback-slow">
          Still reading — GitHub is slow to answer
        </p>
      ) : null}
      {feedback.slow ? (
        <DropdownMenuItem
          className="cursor-default text-xs"
          onSelect={(event) => {
            event.preventDefault()
            feedback.cancel()
          }}
        >
          Cancel
        </DropdownMenuItem>
      ) : null}
    </div>
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
export function FeedbackDialog({
  feedback,
  module,
  name,
  kehikko,
  epic,
}: {
  feedback: FeedbackState
  module: string
  name: string
  kehikko: string | null
  epic: string | null
}) {
  const open = feedback.writing
  const onOpenChange = feedback.write
  const repo = feedback.listing?.repo ?? null
  const onSent = feedback.sent
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
      <ModalContent className="sm:max-w-lg">
        <ModalHeader
          title={<>Feedback on {name}</>}
          titleClassName="text-base"
          description={
            <>
              This will be posted as a GitHub issue in{' '}
            {repo ? <span className="font-mono">{repo}</span> : "this module's repository"} under your account, with a
            line saying which module version, kehikko and epic it came from.
            </>
          }
          descriptionClassName="text-sm leading-relaxed"
        />
        <ModalBody>

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

        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" size="sm" disabled={sending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={sending || !title.trim()} onClick={() => void send()}>
            {sending ? 'Sending…' : 'Send feedback'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Dialog>
  )
}
