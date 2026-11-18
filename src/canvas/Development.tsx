import { useCallback, useEffect, useId, useState } from 'react'
import { LoaderCircle } from 'lucide-react'

import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { cn } from '@/lib/utils'
import {
  fetchUnused,
  sizeSaid,
  TRASH_BUTTON,
  trashedSaid,
  trashUnused,
  verdictSaid,
  type UnusedList,
} from '@/host/unusedFolders.ts'
import {
  changeDevelopment,
  DEVELOPMENT,
  runsCounted,
  drifted,
  fetchDevelopment,
  MODES,
  moveNowWarning,
  moveSaid,
  pathSaid,
  runsSaid,
  showsRuns,
  type DevModule,
  type Development,
  type DevelopmentChange,
} from '@/host/development.ts'

/**
 * "Kehikko development", as the page draws it: the switch in Settings › Development with each official
 * module's line under it, and the few words a module's row in the modules list says about where it
 * runs from. The rule and the moving are the server's (`server/development.ts`); this reads the
 * state, sends a press, and reads again while modules are being moved.
 */

/** How often the state is read again while modules are being moved. */
const WHILE_MOVING_MS = 1500

export function useDevelopment(): {
  state: Development | null
  trouble: string | null
  change(what: DevelopmentChange): Promise<boolean>
} {
  const [state, setState] = useState<Development | null>(null)
  const [trouble, setTrouble] = useState<string | null>(null)
  const read = useCallback(async (signal?: AbortSignal) => {
    try {
      setState(await fetchDevelopment(signal))
      setTrouble(null)
    } catch (error) {
      if (!signal?.aborted) setTrouble(error instanceof Error ? error.message : String(error))
    }
  }, [])
  useEffect(() => {
    const abort = new AbortController()
    void read(abort.signal)
    return () => abort.abort()
  }, [read])
  const moving = state?.moving === true
  useEffect(() => {
    if (!moving) return
    const timer = setInterval(() => void read(), WHILE_MOVING_MS)
    return () => clearInterval(timer)
  }, [moving, read])
  const change = useCallback(async (what: DevelopmentChange) => {
    try {
      setState(await changeDevelopment(what))
      setTrouble(null)
      return true
    } catch (error) {
      setTrouble(error instanceof Error ? error.message : String(error))
      return false
    }
  }, [])
  return { state, trouble, change }
}

/** The switch and, under it, every official module with where it runs from. */
export function DevelopmentSetting() {
  const { state, trouble, change } = useDevelopment()
  const id = useId()
  if (!state) return trouble ? <p className="text-xs text-amber-600 dark:text-amber-400">{trouble}</p> : null
  /* Every official module, whether development is on or off: where each runs from is always worth seeing. */
  const listed = state.modules
  return (
    <div data-development-setting className="rounded-lg border px-4">
      <div className="flex min-w-0 items-start justify-between gap-4 py-3.5">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={id} className="text-sm leading-snug">
            {DEVELOPMENT.label}
          </Label>
          <p id={`${id}-about`} className="text-muted-foreground text-xs leading-relaxed">
            {DEVELOPMENT.description}
          </p>
        </div>
        <Switch
          id={id}
          checked={state.on}
          onCheckedChange={(on) => void change({ on })}
          aria-describedby={`${id}-about`}
          className="mt-0.5"
          data-testid="development-switch"
        />
      </div>
      {trouble ? (
        <p role="alert" className="pb-2 text-xs text-amber-600 dark:text-amber-400">
          {trouble}
        </p>
      ) : null}
      {state.summary ? (
        <p role="status" className="border-t py-2.5 text-xs leading-relaxed break-words" data-development-summary>
          {state.summary}
        </p>
      ) : null}
      {state.unused > 0 ? <UnusedFolders home={state.home} /> : null}
      {listed.length ? (
        <p className="text-muted-foreground border-t py-2.5 text-xs" data-development-count>
          {runsCounted(listed)}
        </p>
      ) : null}
      {listed.length ? (
        <ul className="divide-y border-t" aria-label="Where each module runs from">
          {listed.map((one) => (
            <ModuleLine key={one.id} one={one} on={state.on} home={state.home} change={change} />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** A module's own choice, beside the switch: it beats the switch. */
export function ModeChoice({ one, change }: { one: DevModule; change(what: DevelopmentChange): Promise<boolean> }) {
  return (
    <select
      className="bg-background h-6 rounded-md border px-1 text-xs"
      aria-label={`Where ${one.name} runs from`}
      value={one.mode}
      onChange={(event) => void change({ module: one.id, mode: event.target.value as 'follow' | 'folder' | 'release' })}
      data-mode-choice={one.id}
    >
      {MODES.map((choice) => (
        <option key={choice.mode} value={choice.mode}>
          {choice.label}
        </option>
      ))}
    </select>
  )
}

/** "Move unused folders to the Trash": the list with each folder's size and verdict, then one confirm. */
function UnusedFolders({ home }: { home: string | null }) {
  const [list, setList] = useState<UnusedList | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [trouble, setTrouble] = useState<string | null>(null)
  const open = async () => {
    setSaid(null)
    try {
      setList(await fetchUnused())
      setTrouble(null)
    } catch (error) {
      setTrouble(error instanceof Error ? error.message : String(error))
    }
  }
  const confirm = async () => {
    if (!list) return
    try {
      const done = await trashUnused(list.folders.filter((one) => one.trash).map((one) => one.dir))
      setSaid(trashedSaid(done, home))
      setList(null)
    } catch (error) {
      setTrouble(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <div className="space-y-1.5 border-t py-2.5 text-xs" data-unused-folders>
      {list ? (
        <div role="alertdialog" aria-label="Move unused folders to the Trash" className="space-y-1.5">
          <ul className="space-y-0.5">
            {list.folders.map((one) => (
              <li key={one.dir} className={cn('break-words', one.trash ? '' : 'text-muted-foreground')}>
                {pathSaid(one.dir, home)} · {sizeSaid(one.bytes)} · {verdictSaid(one)}
              </li>
            ))}
          </ul>
          <p>
            {list.folders.some((one) => one.trash)
              ? `${sizeSaid(list.freedBytes)} will be freed. They go to the Trash, where you can put them back.`
              : 'Nothing passes the checks, so nothing will be moved.'}
          </p>
          <div className="flex gap-1.5">
            <Button size="sm" className="h-7 px-2 text-xs" disabled={!list.folders.some((one) => one.trash)} onClick={() => void confirm()}>
              Move to the Trash
            </Button>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setList(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => void open()}>
          {TRASH_BUTTON}
        </Button>
      )}
      {said ? <p role="status">{said}</p> : null}
      {trouble ? <p role="alert" className="text-amber-600 dark:text-amber-400">{trouble}</p> : null}
    </div>
  )
}

function ModuleLine({ one, on, home, change }: { one: DevModule; on: boolean; home: string | null; change(what: DevelopmentChange): Promise<boolean> }) {
  const [adding, setAdding] = useState(false)
  const [path, setPath] = useState('')
  const [confirming, setConfirming] = useState(false)
  const busy = one.move !== null && (one.move.step === 'waiting' || one.move.step === 'installing' || one.move.step === 'starting')
  return (
    <li className="py-2.5 text-xs" data-development-module={one.id}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="font-medium">{one.name}</span>
          <span className="text-muted-foreground"> · {runsSaid(one.runs, home)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {one.move ? (
            <span className={cn('flex items-center gap-1', one.move.step === 'failed' || one.move.step === 'restored' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>
              {busy ? <LoaderCircle className="size-3 animate-spin" aria-hidden /> : null}
              {moveSaid(one.move.step)}
            </span>
          ) : null}
          {!busy && one.keeps && one.move?.step === 'later' ? (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setConfirming(true)}>
              Move now
            </Button>
          ) : null}
          {!busy && one.folder ? <ModeChoice one={one} change={change} /> : null}
          {!busy && !on && one.runs.from === 'folder' ? (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void change({ module: one.id, move: true })}>
              Use the release
            </Button>
          ) : null}
          {!busy && on && !one.folder && one.found ? (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void change({ module: one.id, folder: one.found })}>
              Use {pathSaid(one.found, home)}
            </Button>
          ) : null}
          {!busy && on && !one.folder && !adding ? (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setAdding(true)}>
              Use my folder…
            </Button>
          ) : null}
        </div>
      </div>
      {confirming ? (
        <div role="alertdialog" aria-label={`Move ${one.name} now`} className="mt-1.5 space-y-1.5 rounded-md border px-2.5 py-2" data-move-now={one.id}>
          <p className="leading-relaxed">{moveNowWarning(one.name)}</p>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => {
                setConfirming(false)
                void change({ module: one.id, move: true, now: true })
              }}
            >
              Restart and move
            </Button>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {one.move?.why ? <p className="mt-1 leading-relaxed break-words text-amber-600 dark:text-amber-400">{one.move.why}</p> : null}
      {on && one.folder && one.release ? <p className="text-muted-foreground mt-0.5">Your folder: {pathSaid(one.folder, home)}</p> : null}
      {adding ? (
        <form
          className="mt-1.5 flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            void change({ module: one.id, folder: path.trim() }).then((ok) => ok && setAdding(false))
          }}
        >
          <Input value={path} onChange={(event) => setPath(event.target.value)} placeholder={`Full path to your copy of ${one.name}`} aria-label={`Your folder for ${one.name}`} className="h-7 text-xs" autoFocus />
          <Button type="submit" size="sm" className="h-7 px-2 text-xs" disabled={!path.trim()}>
            Use it
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </form>
      ) : null}
    </li>
  )
}

/**
 * Where a module runs from, on its row in the modules list: only while development is on, or when
 * it runs from a folder although it should run from its release — then with the one press that
 * moves it.
 */
export function RunsFrom({ one, on, home, change }: { one: DevModule | undefined; on: boolean; home: string | null; change(what: DevelopmentChange): Promise<boolean> }) {
  if (!one || !showsRuns(on, one)) return null
  const unexpected = drifted(one) && !on && one.runs.from === 'folder'
  return (
    <p className={cn('text-xs leading-relaxed break-words', unexpected ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')} data-runs-from={one.runs.from}>
      {runsSaid(one.runs, home)}
      {one.mode === 'folder' && one.runs.from === 'folder' ? ' (kept in development)' : null}
      {unexpected ? ' — Kehikko development is off, so this should run from its release. ' : null}
      {one.move ? ` · ${moveSaid(one.move.step)}` : null}
      {unexpected && !one.move ? (
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => void change({ module: one.id, move: true })}>
          Use the release
        </Button>
      ) : null}
      {one.folder && !one.move ? (
        <>
          {' '}
          <ModeChoice one={one} change={change} />
        </>
      ) : null}
    </p>
  )
}
