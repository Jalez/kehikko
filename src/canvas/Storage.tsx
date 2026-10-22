import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import {
  bytesSaid,
  CUT_SAID,
  filesSaid,
  modifiedSaid,
  moduleTotalSaid,
  READ_ONLY_SAID,
  tallySaid,
  type MachinePart,
  type ProjectStorage,
  type Share,
  type StorageReport,
  type Tally,
} from '@/host/storage.ts'
import { ModuleIcon } from './ModuleIcon.tsx'

/**
 * Where a module offers its own storage view (`storageViewOf` in
 * `host/storage.ts`): whether it does, and opening it. Only a module on the
 * open kehikko has declared a header here, so only those are offered.
 */
export interface StorageViews {
  of(module: string): boolean
  open(module: string): Promise<{ ok: boolean; why: string }>
}

/** The report, asked of this host's own server. Page-only (`PAGE_ONLY`), so a POST. */
export async function fetchStorage(fresh = false, signal?: AbortSignal): Promise<StorageReport> {
  const response = await fetch('/host/storage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fresh }),
    signal,
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { why?: unknown; error?: unknown } | null
    const why = typeof body?.why === 'string' ? body.why : typeof body?.error === 'string' ? body.error : null
    throw new Error(why ?? `the host's server answered ${response.status}`)
  }
  return (await response.json()) as StorageReport
}

/**
 * The storage overview: how much room every module's data takes, in every
 * project this host knows, and how much Kehikot's own machine data takes.
 *
 * Asked for from the projects menu, because it is about every project at once
 * and that menu is where projects are listed — and kept out of the header row,
 * which has no room. A dialog, so it reads at any width.
 *
 * It only measures. Clearing a module's data is that module's job: a module on
 * the open kehikko that offers its own storage view is linked from its row.
 * Every number is a sentence ("2.4 MB in 12 files"), and a number the
 * measuring did not finish says "at least" — nothing is told by colour alone.
 */
export function Storage({
  open,
  onOpenChange,
  views,
  load = fetchStorage,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  views?: StorageViews
  /** How the report is read; the server's route unless a test says otherwise. */
  load?: (fresh: boolean) => Promise<StorageReport>
}) {
  const [report, setReport] = useState<StorageReport | null>(null)
  const [trouble, setTrouble] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)

  const read = useCallback(
    async (fresh: boolean) => {
      setBusy(true)
      setTrouble(null)
      try {
        setReport(await load(fresh))
      } catch (error) {
        setTrouble(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  useEffect(() => {
    if (open) void read(false)
  }, [open, read])

  const openView = async (module: string) => {
    if (!views) return
    const pressed = await views.open(module)
    if (pressed.ok) onOpenChange(false)
    else setSaid(pressed.why)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Storage</DialogTitle>
          <DialogDescription>
            How much room Kehikot data takes on this computer: each module’s folder in every project, and Kehikot’s own
            data. {READ_ONLY_SAID}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground min-w-0 flex-1">
            {busy
              ? 'Measuring…'
              : report
                ? `Measured at ${new Date(report.at).toLocaleTimeString()} in ${report.took} ms.`
                : null}
          </span>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void read(true)}>
            Measure again
          </Button>
        </div>

        {trouble ? (
          <p role="alert" className="text-sm">
            The storage could not be measured: {trouble}
          </p>
        ) : null}
        {said ? (
          <p role="status" className="text-sm">
            {said}
          </p>
        ) : null}

        {report ? <StorageBody report={report} views={views} onOpenView={(module) => void openView(module)} /> : null}
      </DialogContent>
    </Dialog>
  )
}

/** What the report says, drawn: by module, by project (each expandable), and the machine's own. */
export function StorageBody({
  report,
  views,
  onOpenView,
}: {
  report: StorageReport
  views?: StorageViews
  onOpenView(module: string): void
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4 text-sm">
      {report.cut ? <p className="text-xs">{CUT_SAID}</p> : null}

      <section aria-labelledby="storage-modules">
        <h3 id="storage-modules" className="mb-1 text-xs font-semibold">
          By module, across projects
        </h3>
        {report.modules.length === 0 ? (
          <p className="text-muted-foreground text-xs">No module has data in any project.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {report.modules.map((total) => (
              <li key={total.id ?? `folder:${total.name}`} className="flex flex-wrap items-center gap-x-2">
                {total.id ? <ModuleIcon id={total.id} name={total.name} className="text-muted-foreground size-3.5" /> : null}
                <span className="min-w-0">{moduleTotalSaid(total)}</span>
                <span className="text-muted-foreground text-xs">{filesSaid(total.files)}</span>
                {total.id && views?.of(total.id) ? (
                  <button
                    type="button"
                    className="text-xs underline underline-offset-2"
                    onClick={() => onOpenView(total.id!)}
                  >
                    open {total.name}’s storage view
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="storage-projects">
        <h3 id="storage-projects" className="mb-1 text-xs font-semibold">
          By project
        </h3>
        {report.projects.length === 0 ? (
          <p className="text-muted-foreground text-xs">No project here has been measured.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {report.projects.map((project) => (
              <ProjectRow key={project.id} project={project} />
            ))}
          </div>
        )}
        {report.missing.map((gone) => (
          <p key={gone.id} className="text-muted-foreground mt-1 text-xs">
            {gone.name}: its folder is gone, so it was not measured.
          </p>
        ))}
      </section>

      <section aria-labelledby="storage-machine">
        <h3 id="storage-machine" className="mb-1 text-xs font-semibold">
          Kehikot on this computer: {bytesSaid(report.machine.bytes)}
        </h3>
        <p className="text-muted-foreground mb-1 font-mono text-[11px] break-all">{report.machine.path}</p>
        <ul className="flex flex-col gap-1">
          {report.machine.parts.map((part) => (
            <MachineRow key={part.key} part={part} />
          ))}
        </ul>
      </section>
    </div>
  )
}

function Largest({ tally }: { tally: Tally }) {
  if (tally.largest.length === 0) return null
  return (
    <ul className="text-muted-foreground mt-0.5 ml-3 text-[11px]">
      {tally.largest.map((file) => (
        <li key={file.path} className="break-all">
          <span className="font-mono">{file.path}</span> — {bytesSaid(file.bytes)}
        </li>
      ))}
    </ul>
  )
}

function ShareRow({ share }: { share: Share }) {
  return (
    <li>
      {share.owner.id ? <ModuleIcon id={share.owner.id} name={share.owner.name} className="text-muted-foreground mr-1.5 inline size-3.5 align-[-2px]" /> : null}
      <span className="font-medium">{share.owner.name}</span>{' '}
      <span className="text-muted-foreground font-mono text-[11px]">.kehikot/{share.folder}/</span>
      {share.owner.id === null ? <span className="text-muted-foreground text-xs"> (no module this host knows claims it)</span> : null}
      <span>: {tallySaid(share.tally)}</span>
      {share.tally.modified ? <span className="text-muted-foreground text-xs">, {modifiedSaid(share.tally.modified)}</span> : null}
      <Largest tally={share.tally} />
    </li>
  )
}

/** One project, folded to its total; opened, its folders. A native disclosure, so the keyboard and a reader know it. */
function ProjectRow({ project }: { project: ProjectStorage }) {
  return (
    <details className="rounded border px-2 py-1">
      <summary className="cursor-pointer">
        <span className="font-medium">{project.name}</span>: {tallySaid(project.total)}
        {project.total.modified ? <span className="text-muted-foreground text-xs">, {modifiedSaid(project.total.modified)}</span> : null}
      </summary>
      <p className="text-muted-foreground mt-1 font-mono text-[11px] break-all">{project.path}</p>
      {project.shares.length === 0 ? (
        <p className="text-muted-foreground text-xs">There is no .kehikot/ data in this project.</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1">
          {project.shares.map((share) => (
            <ShareRow key={share.folder} share={share} />
          ))}
        </ul>
      )}
    </details>
  )
}

function MachineRow({ part }: { part: MachinePart }) {
  const said = part.tally ? tallySaid(part.tally) : 'nothing there'
  if (!part.modules?.length) {
    return (
      <li>
        {part.label}: {said}
        <span className="text-muted-foreground block font-mono text-[11px] break-all">{part.path}</span>
      </li>
    )
  }
  return (
    <li>
      <details>
        <summary className="cursor-pointer">
          {part.label}: {said}
        </summary>
        <span className="text-muted-foreground block font-mono text-[11px] break-all">{part.path}</span>
        <ul className="ml-3">
          {part.modules.map((one) => (
            <li key={one.folder}>
              {one.owner.name}: {tallySaid(one.tally)}
            </li>
          ))}
        </ul>
      </details>
    </li>
  )
}
