import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal.tsx'
import { bytesSaid } from '@/host/storage.ts'
import {
  agoSaid,
  removeSaid,
  reportSaid,
  sizeSaid,
  WORKTREE_CLEANUP,
  type RemoveAnswer,
  type Row,
  type Scan,
  type ScanState,
} from '@/host/worktrees.ts'

/** How the dialog reaches the host: the routes, unless a test says otherwise. */
export interface WorktreesApi {
  state(): Promise<ScanState>
  scan(): Promise<ScanState>
  remove(paths: string[]): Promise<RemoveAnswer>
}

async function answered<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as (T & { ok?: boolean; why?: unknown }) | null
  if (!response.ok || !body) throw new Error(typeof body?.why === 'string' ? body.why : `Kehikot answered with error ${response.status}`)
  return body
}

const post = (path: string, body: unknown) =>
  fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export const worktreesApi: WorktreesApi = {
  state: async () => answered<ScanState>(await fetch('/host/worktrees', { cache: 'no-store' })),
  scan: async () => answered<ScanState>(await post('/host/worktrees/scan', {})),
  remove: async (paths) => answered<RemoveAnswer>(await post('/host/worktrees/remove', { paths })),
}

/**
 * "Clean up finished worktrees": every project's worktrees whose work is
 * merged or closed, each with why, its size and its last change, all checked;
 * one press and one confirmation removes the checked ones, and what was
 * removed and skipped is said. The rule is `src/host/worktrees.ts`; the host
 * decides each worktree again before removing it.
 */
export function Worktrees({ open, onOpenChange, api = worktreesApi }: { open: boolean; onOpenChange(open: boolean): void; api?: WorktreesApi }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ModalContent className="sm:max-w-2xl" data-worktrees-dialog="">
        <ModalHeader
          title={WORKTREE_CLEANUP.open}
          titleClassName="text-base"
          description={
            <>
              Worktrees whose pull or merge request is merged or closed, or whose work is already in the default branch.
              The main checkout and remote branches are never touched.
            </>
          }
          descriptionClassName="text-sm leading-relaxed"
        />
        {open ? <WorktreesBody api={api} /> : <ModalBody />}
      </ModalContent>
    </Dialog>
  )
}

/** The dialog's content: scans when shown, then the list, the confirmation and the report. */
export function WorktreesBody({ api, pollMs = 1000, now = Date.now }: { api: WorktreesApi; pollMs?: number; now?: () => number }) {
  const [state, setState] = useState<ScanState | null>(null)
  const [trouble, setTrouble] = useState<string | null>(null)
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [report, setReport] = useState<RemoveAnswer | null>(null)
  const alive = useRef(true)

  const follow = useCallback(
    async (first: Promise<ScanState>) => {
      try {
        let got = await first
        while (alive.current) {
          setState(got)
          if (!got.scanning) break
          await new Promise((done) => setTimeout(done, pollMs))
          got = await api.state()
        }
      } catch (error) {
        if (alive.current) setTrouble(error instanceof Error ? error.message : String(error))
      }
    },
    [api, pollMs],
  )

  useEffect(() => {
    alive.current = true
    void follow(api.scan())
    return () => {
      alive.current = false
    }
  }, [api, follow])

  const scan = state?.scan ?? null
  const offered = useMemo(() => (scan ? scan.projects.flatMap((p) => p.rows.filter((r) => r.kept === null)) : []), [scan])
  const chosen = offered.filter((r) => !unchecked.has(r.path))
  const bytes = chosen.reduce((sum, r) => sum + (r.bytes ?? 0), 0)
  const unmeasured = chosen.filter((r) => r.bytes === null).length

  const toggle = (path: string, on: boolean) =>
    setUnchecked((was) => {
      const next = new Set(was)
      if (on) next.delete(path)
      else next.add(path)
      return next
    })

  const remove = async () => {
    setRemoving(true)
    setTrouble(null)
    try {
      const answer = await api.remove(chosen.map((r) => r.path))
      setReport(answer)
      setConfirming(false)
      await follow(api.state())
    } catch (error) {
      setTrouble(error instanceof Error ? error.message : String(error))
    } finally {
      setRemoving(false)
    }
  }

  return (
    <>
    <ModalBody className="gap-3 text-sm" data-worktrees>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground min-w-0 flex-1" role="status">
          {state === null || state.scanning
            ? 'Looking at every project’s worktrees…'
            : scan
              ? `Looked at ${new Date(scan.at).toLocaleTimeString()}, in ${Math.round(scan.took / 1000)} s.`
              : null}
        </span>
        <Button variant="outline" size="sm" disabled={!state || state.scanning || removing} onClick={() => void follow(api.scan())}>
          Look again
        </Button>
      </div>

      {trouble || state?.error ? (
        <p role="alert" className="text-sm">
          {trouble ?? `The worktrees could not be read: ${state?.error}`}
        </p>
      ) : null}

      {report ? <Report answer={report} /> : null}

      {scan ? <ScanList scan={scan} unchecked={unchecked} onToggle={toggle} now={now()} disabled={removing} /> : null}
    </ModalBody>

      {scan && offered.length > 0 ? (
        <ModalFooter className="justify-start text-sm">
        {confirming ? (
          <div role="alertdialog" aria-label="Confirm removal" className="flex min-w-0 flex-col gap-2" data-worktrees-confirm>
            <p>
              {removeSaid(chosen.length, bytes, unmeasured)}? Their folders are deleted, with files git ignores such as{' '}
              <span className="font-mono">node_modules</span>. A local branch is deleted only when it is merged or its request is
              merged or closed. Each worktree is checked again first.
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" disabled={removing} onClick={() => void remove()}>
                {removing ? 'Removing…' : 'Remove'}
              </Button>
              <Button size="sm" variant="outline" disabled={removing} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" disabled={chosen.length === 0 || state?.scanning} onClick={() => setConfirming(true)}>
            {removeSaid(chosen.length, bytes, unmeasured)}
          </Button>
        )}
        </ModalFooter>
      ) : null}
    </>
  )
}

function ScanList({
  scan,
  unchecked,
  onToggle,
  now,
  disabled,
}: {
  scan: Scan
  unchecked: ReadonlySet<string>
  onToggle(path: string, on: boolean): void
  now: number
  disabled: boolean
}) {
  if (!scan.projects.some((p) => p.rows.length)) {
    return (
      <>
        <p className="text-muted-foreground text-xs">No finished worktrees in any project.</p>
        {scan.projects.map((p) => (p.notes.length ? <Notes key={p.id} name={p.name} notes={p.notes} /> : null))}
      </>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {scan.projects.map((project) => {
        const offered = project.rows.filter((r) => r.kept === null)
        const kept = project.rows.filter((r) => r.kept !== null)
        return (
          <section key={project.id} aria-label={project.name} className="flex flex-col gap-1">
            <h3 className="text-xs font-semibold">
              {project.name} <span className="text-muted-foreground font-normal">{project.path}</span>
            </h3>
            {offered.length ? (
              <ul className="flex flex-col gap-1">
                {offered.map((row) => (
                  <li key={row.path}>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={!unchecked.has(row.path)}
                        disabled={disabled}
                        onChange={(event) => onToggle(row.path, event.currentTarget.checked)}
                      />
                      <RowText row={row} now={now} />
                    </label>
                  </li>
                ))}
              </ul>
            ) : null}
            {kept.length ? (
              <details>
                <summary className="text-muted-foreground cursor-pointer text-xs">
                  {kept.length} finished but left alone
                </summary>
                <ul className="mt-1 flex flex-col gap-1 pl-5">
                  {kept.map((row) => (
                    <li key={row.path} className="text-xs">
                      <span className="font-mono">{row.branch ?? row.path}</span> — {row.done}, left alone: {row.kept}.
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {project.notes.length ? <Notes name={null} notes={project.notes} /> : null}
          </section>
        )
      })}
    </div>
  )
}

function RowText({ row, now }: { row: Row; now: number }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="font-mono text-xs break-all">{row.branch ?? '(no branch)'}</span>
      <span className="text-muted-foreground text-xs">
        {row.done} · {sizeSaid(row.bytes)} · last changed {agoSaid(row.changedAt, now)}
      </span>
      <span className="text-muted-foreground text-[11px] break-all">{row.path}</span>
    </span>
  )
}

function Notes({ name, notes }: { name: string | null; notes: string[] }) {
  return (
    <ul className="text-muted-foreground flex flex-col gap-0.5 text-[11px]">
      {notes.map((note) => (
        <li key={note}>
          {name ? `${name}: ` : ''}
          {note}
        </li>
      ))}
    </ul>
  )
}

function Report({ answer }: { answer: RemoveAnswer }) {
  return (
    <div role="status" className="flex flex-col gap-1 rounded-lg border p-3 text-xs" data-worktrees-report>
      <p className="text-sm">{reportSaid(answer)}</p>
      {answer.removed.length ? (
        <ul className="flex flex-col gap-0.5">
          {answer.removed.map((one) => (
            <li key={one.path}>
              Removed <span className="font-mono">{one.branch ?? one.path}</span>
              {one.bytes !== null ? ` (${bytesSaid(one.bytes)})` : ''}
              {one.branchDeleted ? ', and its local branch' : ''}.
            </li>
          ))}
        </ul>
      ) : null}
      {answer.skipped.length ? (
        <ul className="flex flex-col gap-0.5">
          {answer.skipped.map((one) => (
            <li key={one.path}>
              Skipped <span className="font-mono break-all">{one.path}</span>: {one.why}.
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
