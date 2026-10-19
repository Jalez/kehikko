import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { locateProject, type Project } from '@/host/projects.ts'
import { Browser } from './Projects.tsx'

/**
 * "Locate…": a project whose folder is gone, pointed at where it went.
 *
 * The folder browser the add uses, with its own words. The person walks to the
 * folder and picks it; the HOST decides whether it is this project — it must
 * carry the project's own id in `.kehikot/project.json` — so a folder that only
 * looks right is refused with the host's sentence, here, above the buttons.
 * Found, the project keeps its kehikot and its Inbox history: only its path
 * changes.
 *
 * A project that never had an id (its folder was already gone when this host
 * first looked) has nothing to compare with. The host says so and offers a
 * second step, "Use this folder anyway", for that refusal only.
 */
export function Locate({
  project,
  onOpenChange,
  onLocated,
}: {
  /** The project being located, or null when the dialog is closed. */
  project: Pick<Project, 'id' | 'name' | 'path'> | null
  onOpenChange(open: boolean): void
  onLocated(project: Project): void
}) {
  const [refused, setRefused] = useState<{ why: string; anyway: boolean; path: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => setRefused(null), [project?.id])

  const ask = async (path: string, anyway: boolean) => {
    if (!project || busy) return
    setBusy(true)
    try {
      const found = await locateProject(project.id, path, anyway)
      if (found.ok) {
        setRefused(null)
        onLocated(found.project)
      } else {
        setRefused({ why: found.why, anyway: found.anyway, path })
      }
    } catch (error) {
      setRefused({ why: `The host did not answer: ${(error as Error).message}`, anyway: false, path })
    } finally {
      setBusy(false)
    }
  }

  /* Where the folder used to sit: the commonest move is a rename beside it. */
  const parent = project ? project.path.replace(/\/[^/]+\/?$/, '') || '/' : null

  return (
    <Browser
      open={project !== null}
      onOpenChange={(open) => {
        if (!open) setRefused(null)
        onOpenChange(open)
      }}
      start={parent}
      onPick={(path) => void ask(path, false)}
      title={project ? `Locate ${project.name}` : 'Locate'}
      description={
        <>
          Find the folder this project moved to. It is the same project only if it carries the project's own id, in{' '}
          <span className="font-mono">.kehikot/project.json</span>; its kehikot and Inbox come with it.
        </>
      }
      pick="this is the folder"
      pickOne="this one"
    >
      {refused ? (
        <div role="alert" className="flex flex-col gap-2 text-xs">
          <p className="text-destructive">{refused.why}</p>
          <p className="text-muted-foreground font-mono text-[11px] break-all">{refused.path}</p>
          {refused.anyway ? (
            <div>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void ask(refused.path, true)}>
                Use this folder anyway
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Browser>
  )
}
