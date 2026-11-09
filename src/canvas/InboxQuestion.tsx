import { useState } from 'react'
import { LIMITS } from 'kehikot-module-protocol'

import { Button } from '@/components/ui/button.tsx'
import { cn } from '@/lib/utils'
import { pressFresh } from '@/host/gesture.ts'
import { askedOf, type Entry } from '@/host/inbox.ts'
import type { Said } from '@/host/inboxClient.ts'

/**
 * A question an Inbox item asks the person (protocol 2.55.0), drawn under its row and in its toast:
 * the WHOLE question, its choices as buttons, and a small reply field. Once answered, "Answered:
 * <answer>" and no controls. The rules are `askedOf` / `answerFor` in `host/inbox.ts`.
 *
 * A module's words are text: the question, the choices and a refusal are rendered as text and never
 * as markup or a link. An answer is sent only on the person's own press: `pressFresh` is read here,
 * synchronously, in the click or submit handler, before anything is awaited, and handed on; the
 * server refuses an answer the page did not say was pressed.
 */

export type Answer = (said: Said, pressed: boolean) => Promise<{ ok: true } | { ok: false; why: string }>

export function InboxQuestion({
  entry,
  onAnswer,
  onAnswered,
  inset = true,
}: {
  entry: Entry
  onAnswer?: Answer | undefined
  onAnswered?: () => void
  /** Indented under a row's label (the panel); flush in a toast. */
  inset?: boolean
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [why, setWhy] = useState<string | null>(null)
  const asked = askedOf(entry)
  if (!asked) return null

  const send = (said: Said) => {
    /* Read now, in the press's own handler: a moment later it is no longer the person's press. */
    const pressed = pressFresh()
    if (!onAnswer || sending) return
    setSending(true)
    setWhy(null)
    void onAnswer(said, pressed).then((got) => {
      setSending(false)
      if (got.ok) {
        setText('')
        onAnswered?.()
      } else setWhy(got.why)
    })
  }

  return (
    <div data-inbox-question="" className={cn('flex min-w-0 basis-full flex-col gap-1', inset && 'pl-4')}>
      <p data-inbox-question-text="" className="max-h-48 overflow-y-auto text-xs leading-snug break-words whitespace-pre-wrap">
        {asked.text}
      </p>
      {asked.answered !== null ? (
        <p data-inbox-answered="" className="text-muted-foreground text-xs break-words whitespace-pre-wrap">
          {asked.answered}
        </p>
      ) : onAnswer ? (
        <>
          {asked.choices.length ? (
            <div role="group" aria-label="choices" className="flex flex-wrap gap-1" data-inbox-question-choices="">
              {asked.choices.map((choice, at) => (
                <Button
                  key={choice}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-auto min-h-6 max-w-full px-2 py-0.5 text-left text-[11px] whitespace-normal break-words"
                  disabled={sending}
                  onClick={() => send({ choice: at, answer: choice })}
                >
                  {choice}
                </Button>
              ))}
            </div>
          ) : null}
          <form
            className="flex min-w-0 items-center gap-1"
            data-inbox-reply=""
            onSubmit={(event) => {
              event.preventDefault()
              const said = text.trim()
              if (said) send({ answer: said })
            }}
          >
            <input
              type="text"
              value={text}
              maxLength={LIMITS.MESSAGE_BODY}
              onChange={(event) => setText(event.target.value)}
              placeholder="Reply…"
              aria-label="Your answer to the agent"
              className="border-input bg-background focus-visible:ring-ring/50 h-6 min-w-0 flex-1 rounded-sm border px-1.5 text-xs outline-none focus-visible:ring-[3px]"
            />
            <Button type="submit" size="sm" className="h-6 shrink-0 px-2 text-[11px]" disabled={sending || !text.trim()}>
              Send
            </Button>
          </form>
          {why !== null ? (
            <p role="alert" data-inbox-answer-why="" className="text-xs break-words">
              Not sent: {why}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
