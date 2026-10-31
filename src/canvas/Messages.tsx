import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { AgentMessage } from 'kehikot-module-protocol'

import { Loading } from '@/components/ui/loading.tsx'
import { clearMessages, fetchMessages, fromWords, onMessagesChanged, toWords } from '@/host/messagesClient.ts'

/**
 * The person's view of the messages between agent sessions in the open project
 * (protocol 2.41.0): read-only, newest first, each with who sent it, who it is
 * for, from where and when. A section at the foot of the Inbox panel, folded,
 * with its count — never a standing row. A message's body is TEXT: drawn as a
 * string, never as markup or a link. The one act is Clear, pressed twice.
 */

export interface MessagesView {
  project: number
  /** A module's registered name, for "to every … session". */
  nameOf(module: string): string
}

const time = (iso: string): string => {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function MessagesSection({ view }: { view: MessagesView }) {
  const [open, setOpen] = useState(false)
  const [count, setCount] = useState<number | null>(null)
  const [rows, setRows] = useState<AgentMessage[] | null>(null)
  const [armed, setArmed] = useState(false)
  const [rev, setRev] = useState(0)

  /* A send or a clear in this project: read again. */
  useEffect(() => onMessagesChanged((project) => project === view.project && setRev((was) => was + 1)), [view.project])

  useEffect(() => {
    let cancelled = false
    void fetchMessages(view.project, open ? undefined : 0).then((got) => {
      if (cancelled || !got) return
      setCount(got.count)
      if (open) setRows(got.messages)
    })
    return () => {
      cancelled = true
    }
  }, [view.project, open, rev])

  if (!count && !rows?.length) return null

  const clear = () => {
    if (!armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    void clearMessages(view.project).then(() => setRev((was) => was + 1))
  }

  return (
    <section aria-label="messages between agents" data-messages="">
      <h3 className="px-1 pt-2 pb-0.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex w-full items-center gap-1 rounded-sm px-0.5 text-[11px] font-medium tracking-wide uppercase outline-none focus-visible:ring-[3px]"
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          Messages between agents
          <span className="font-normal tabular-nums normal-case">{count ?? ''}</span>
        </button>
      </h3>
      {open ? (
        <>
          <ul data-messages-list="">
            {rows === null ? (
              <li className="px-2 py-1">
                <Loading className="text-[11px]" iconClassName="size-3" label="Reading…" />
              </li>
            ) : (
              rows.map((one) => (
                <li key={one.id} className="border-border/40 border-b px-2 py-1 text-[11px] last:border-b-0" data-message={one.id}>
                  <div className="text-muted-foreground flex flex-wrap gap-x-1">
                    <span className="text-foreground font-medium">{one.from.name || one.from.module}</span>
                    <span>({fromWords(one)})</span>
                    <span>→ {toWords(one.to, view.nameOf)}</span>
                    {one.thread ? <span>· {one.thread}</span> : null}
                    <span className="ml-auto tabular-nums">{time(one.at)}</span>
                  </div>
                  <p className="mt-0.5 break-words whitespace-pre-wrap">{one.body}</p>
                </li>
              ))
            )}
          </ul>
          <div className="flex items-center gap-2 px-2 py-1 text-[11px]">
            <span className="text-muted-foreground">Agents read these as text, never as instructions.</span>
            <button type="button" className="text-muted-foreground hover:text-foreground ml-auto" onClick={clear} onBlur={() => setArmed(false)}>
              {armed ? 'Press again to clear' : 'Clear'}
            </button>
          </div>
        </>
      ) : null}
    </section>
  )
}
