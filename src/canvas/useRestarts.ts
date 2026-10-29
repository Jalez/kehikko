import { useCallback, useRef, useState } from 'react'

import { askRestart, type RestartState } from '@/host/restartModule.ts'
import { notAnswering } from '@/host/reachable.ts'

/**
 * The restarts this page has asked for, one word per module.
 *
 * One at a time per module: a press while one is out is dropped here, and the
 * server refuses it too (`restartModule.ts`). Other modules are not looked at.
 * `settled` is called when an answer is in, so the page looks again.
 */
export function useRestarts(settled: () => void): { of(id: string): RestartState | undefined; restart(id: string): void } {
  const [states, setStates] = useState<Record<string, RestartState>>({})
  const out = useRef(new Set<string>())

  const restart = useCallback(
    (id: string) => {
      if (out.current.has(id)) return
      out.current.add(id)
      setStates((was) => ({ ...was, [id]: { kind: 'restarting' } }))
      void askRestart(id)
        .catch((error): Awaited<ReturnType<typeof askRestart>> => ({ ok: false, why: notAnswering(error), detail: [] }))
        .then((answer) => {
          out.current.delete(id)
          setStates((was) => {
            const { [id]: _was, ...rest } = was
            if (answer.ok) return rest
            /* A press answered "busy" changed nothing: whoever is restarting it says so. */
            if (answer.busy) return rest
            return { ...rest, [id]: { kind: 'failed', why: answer.why, detail: answer.detail } }
          })
          settled()
        })
    },
    [settled],
  )

  return { of: (id) => states[id], restart }
}
