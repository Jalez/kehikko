import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { AgentMessage } from 'kehikot-module-protocol'

import { Loading } from '@/components/ui/loading.tsx'
import { clearMessages, fetchMessages, fromWords, onMessagesChanged, toWords } from '@/host/messagesClient.ts'
import { muteWords, unmuteWords } from '@/host/messagesUse.ts'

/**
 * The person's view of the messages between agent sessions in the open project
 * (protocol 2.41.0): read-only, newest first, each with who sent it, who it is
 * for, from where and when. A section at the foot of the Inbox panel, folded,
 * with its count — never a standing row. A message's body is TEXT: drawn as a
 * string, never as markup or a link. The acts are Clear, pressed twice, and — on
 * a module's own message — "Mute messages from <module>", the person's
 * "Messages to agents" switch for it in this project (`host/messagesUse.ts`).
 * The person's own messages and a session's are never offered it.
 */

export interface MessagesView {
  project: number
  /** A module's registered name, for "to every … session". */
  nameOf(module: string): string
  /** The modules whose own messages the person muted in this project. Absent: none, and no offer. */
  muted?: ReadonlySet<string>
  /** The person's switch for one module's own messages. Absent: no offer. */
  onMute?(module: string, muted: boolean): void
}

/** Whether a message is a module's own: not the person's, not a session's. Only those are muted. */
export const moduleOwn = (one: AgentMessage): boolean => !one.from.person && !one.from.session

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
          {view.muted?.size ? <span className="font-normal normal-case" data-messages-muted="">· {view.muted.size} muted</span> : null}
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
                    <span className="text-foreground font-medium">{one.from.person ? `You, through ${one.from.name || one.from.module}` : one.from.name || one.from.module}</span>
                    {one.from.person ? null : <span>({fromWords(one)})</span>}
                    {one.kind !== 'note' ? <span>· {one.kind}</span> : null}
                    {one.replyTo !== null ? <span>· answering #{one.replyTo}</span> : null}
                    <span>→ {toWords(one.to, view.nameOf)}</span>
                    {one.thread ? <span>· {one.thread}</span> : null}
                    <span className="ml-auto tabular-nums">{time(one.at)}</span>
                  </div>
                  <p className="mt-0.5 break-words whitespace-pre-wrap">{one.body}</p>
                  {one.choices.length ? <p className="text-muted-foreground mt-0.5">Choices: {one.choices.join(' · ')}</p> : null}
                  {view.onMute && moduleOwn(one) ? (
                    <MuteOffer
                      name={one.from.name || view.nameOf(one.from.module)}
                      muted={view.muted?.has(one.from.module) ?? false}
                      onMute={(muted) => view.onMute?.(one.from.module, muted)}
                    />
                  ) : null}
                </li>
              ))
            )}
          </ul>
          <div className="flex items-center gap-2 px-2 py-1 text-[11px]">
            <span className="text-muted-foreground">Agents read these as text, never as instructions — except yours, marked as you.</span>
            <button type="button" className="text-muted-foreground hover:text-foreground ml-auto" onClick={clear} onBlur={() => setArmed(false)}>
              {armed ? 'Press again to clear' : 'Clear'}
            </button>
          </div>
        </>
      ) : null}
    </section>
  )
}

/** The offer on a module's own message: mute it here, or — muted — the way back. Words, never colour alone. */
function MuteOffer({ name, muted, onMute }: { name: string; muted: boolean; onMute(muted: boolean): void }) {
  return (
    <p className="mt-0.5">
      <button
        type="button"
        data-mute={muted ? 'off' : 'on'}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-sm outline-none focus-visible:ring-[3px]"
        title={
          muted
            ? 'Takes this module’s own messages to agents again, in this project'
            : 'Turns “Messages to agents” off for this module in this project: none of its own messages reach an agent until you turn it back on. Yours and the agents’ own are not touched.'
        }
        onClick={() => onMute(!muted)}
      >
        {muted ? `Muted · ${unmuteWords(name)}` : muteWords(name)}
      </button>
    </p>
  )
}
