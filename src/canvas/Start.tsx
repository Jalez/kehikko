import { Play } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button.tsx'

/**
 * The button on a silent pane.
 *
 * ## Why it is here and not in the strip
 *
 * A module is silent when its address answered nothing. That is the one moment
 * a person is looking straight at the problem, and the pane is where they are
 * looking — so the offer to fix it goes there, beside the sentence explaining
 * what is wrong, rather than in a menu they would have to know to open.
 *
 * ## What it does not do
 *
 * It does not autostart, and it must not grow into something that does. A host
 * that ran programs because a canvas loaded would be a host that runs programs;
 * the whole argument for a host being allowed to start anything is that someone
 * pressed a button while reading a sentence about a program that is not
 * running. See the essay in `server/launch.ts`.
 *
 * It also does not claim success. `start` reports whether the module's MANIFEST
 * came back afterwards, not whether a process was created — a script that
 * starts and exits immediately has "started" and there is nothing there. So the
 * two outcomes here are "it is answering now" and a sentence saying it was run
 * and did not answer, which are different things to be told.
 */
export function Start({
  module,
  onStarted,
}: {
  module: string
  /** Called when the sweep after a start has something new to say. */
  onStarted(): void
}) {
  const [running, setRunning] = useState(false)
  const [said, setSaid] = useState<string | null>(null)

  const press = async () => {
    setRunning(true)
    setSaid(null)
    try {
      const response = await fetch('/host/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ module }),
      })
      const body = (await response.json()) as {
        ok?: boolean
        why?: string
        command?: string
        presence?: { condition?: string } | null
      }

      if (!body.ok) {
        /* The server's own words. Every refusal it produces names what to fix —
           no directory registered, no run.sh, not executable — and rewording
           them here would be this component guessing at which. */
        setSaid(body.why ?? 'It could not be started, and the host did not say why.')
        return
      }

      if (body.presence?.condition === 'ready') {
        onStarted()
        return
      }

      /* Ran, and still not answering. Said plainly, with the command, because
         the next thing a person will do is run it themselves and read what it
         prints — and this host deliberately discards the module's output rather
         than holding a pipe nobody drains. */
      setSaid(
        `It was started and has not answered yet. If it does not appear, run it yourself and see what it says: ${body.command ?? ''}`,
      )
      onStarted()
    } catch (error) {
      setSaid(`The host's own server did not answer: ${(error as Error).message}.`)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="pointer-events-auto flex flex-col items-center gap-2">
      <Button variant="secondary" size="sm" className="h-7 px-3 text-xs" disabled={running} onClick={() => void press()}>
        <Play className="size-3" />
        {running ? 'starting…' : 'start it'}
      </Button>
      {said ? <p className="text-muted-foreground max-w-[46ch] text-xs leading-relaxed">{said}</p> : null}
    </div>
  )
}
