import { Check, FolderOpen, Search } from 'lucide-react'

import { Input } from '@/components/ui/input.tsx'
import {
  findProjects,
  notInstalled,
  settingsSaid,
  type CopyGroup,
  type CopyTake,
  type ElsewhereKehikko,
  type ElsewhereProject,
} from '@/host/fromProject.ts'
import type { OfficialEntry } from '@/host/layouts.ts'
import { LayoutPreview } from './Layouts.tsx'

/**
 * "From another project" in the New kehikko dialog: pick a project this host knows (searchable,
 * recent first), see its kehikot as cards — the layout picture with the modules' icons, what settings
 * would come along, and "Not installed: …" for a module this computer lacks — pick one, and say which
 * of its settings to take. The name and Create are the dialog's footer (`LayoutPicker`).
 *
 * The rules are `src/host/fromProject.ts`; this file only draws them. Everything is `min-w-0` and
 * wraps: the dialog must not scroll sideways at any width (`test/from-project-dom.test.tsx`).
 */

const GROUP_SAID: Record<CopyGroup, string> = {
  general: 'General',
  skills: 'Skills',
  agents: 'Primary agent',
}

function KehikkoCard({
  kehikko,
  registered,
  official,
  chosen,
  onChoose,
}: {
  kehikko: ElsewhereKehikko
  registered: ReadonlyMap<string, string>
  official: readonly OfficialEntry[]
  chosen: boolean
  onChoose(): void
}) {
  const lacking = notInstalled(kehikko.containers, registered, official)
  const settings = settingsSaid(kehikko, registered)
  const count = kehikko.containers.length
  return (
    <button
      type="button"
      onClick={onChoose}
      aria-pressed={chosen}
      data-elsewhere-card={kehikko.key}
      className={
        'bg-card focus-visible:ring-ring/50 relative flex min-w-0 max-w-full flex-col gap-1.5 overflow-hidden rounded-lg border p-2 text-left outline-none transition-colors focus-visible:ring-[3px] ' +
        (chosen ? 'border-primary ring-primary/40 ring-2' : 'hover:border-foreground/30')
      }
    >
      <LayoutPreview
        containers={kehikko.containers}
        available={kehikko.containers.map((c) => ({
          module: c.module,
          name: registered.get(c.module) ?? official.find((one) => one.id === c.module)?.name ?? c.module,
          state: registered.has(c.module) ? 'here' : 'missing',
          optional: false,
        }))}
        className="h-32 w-full"
      />
      <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
        <span className="min-w-0 truncate" title={kehikko.name}>
          {kehikko.name}
        </span>
        {chosen ? <Check className="text-primary size-3.5 shrink-0" aria-hidden /> : null}
      </span>
      <span className="text-muted-foreground min-w-0 text-xs leading-snug [overflow-wrap:anywhere]">
        {count === 0 ? 'empty' : `${count} ${count === 1 ? 'container' : 'containers'}`}
        {kehikko.folded ? ` · ${kehikko.folded} folded or tiled` : ''}
        {settings ? ` · ${settings}` : ''}
      </span>
      {lacking.length ? (
        <span className="text-amber-700 dark:text-amber-400 min-w-0 text-[11px] leading-snug [overflow-wrap:anywhere]" data-elsewhere-lacking="">
          Not installed: {lacking.join(', ')}
        </span>
      ) : null}
    </button>
  )
}

export function FromProject({
  projects,
  failed,
  query,
  onQuery,
  project,
  onProject,
  chosen,
  onChoose,
  take,
  onTake,
  registered,
  official,
}: {
  /** Null while they are read. */
  projects: readonly ElsewhereProject[] | null
  failed: string | null
  query: string
  onQuery(query: string): void
  project: number | null
  onProject(id: number): void
  chosen: ElsewhereKehikko | null
  onChoose(kehikko: ElsewhereKehikko): void
  take: CopyTake
  onTake(take: CopyTake): void
  registered: ReadonlyMap<string, string>
  official: readonly OfficialEntry[]
}) {
  const found = findProjects(projects ?? [], query)
  const open = projects?.find((one) => one.id === project) ?? null
  const has: Record<CopyGroup, string | null> = chosen
    ? {
        general: chosen.connections ? 'its connection choices' : 'nothing set',
        skills: chosen.skills.length ? chosen.skills.join(', ') : 'none',
        agents: chosen.primary ? (registered.get(chosen.primary) ?? chosen.primary) : 'none chosen',
      }
    : { general: null, skills: null, agents: null }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]" data-from-project="">
      <section aria-label="Projects" className="flex min-w-0 flex-col gap-2">
        <label className="relative min-w-0">
          <span className="sr-only">Find a project</span>
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" aria-hidden />
          <Input
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Find a project"
            className="h-8 pl-7"
            data-elsewhere-search=""
          />
        </label>
        {failed ? <p className="text-destructive text-xs">{failed}</p> : null}
        {projects === null && !failed ? <p className="text-muted-foreground text-xs">Reading your projects…</p> : null}
        {projects !== null && projects.length === 0 ? (
          <p className="text-muted-foreground text-xs">There is no other project here yet. Add one from the project menu.</p>
        ) : null}
        {projects !== null && projects.length > 0 && found.length === 0 ? (
          <p className="text-muted-foreground text-xs">No project matches {JSON.stringify(query)}.</p>
        ) : null}
        <ul className="flex max-h-72 min-w-0 flex-col gap-1 overflow-y-auto" data-elsewhere-projects="">
          {found.map((one) => (
            <li key={one.id} className="min-w-0">
              <button
                type="button"
                onClick={() => onProject(one.id)}
                aria-pressed={one.id === project}
                data-elsewhere-project={one.id}
                className={
                  'flex w-full min-w-0 items-start gap-2 rounded-md border px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ' +
                  (one.id === project ? 'border-primary bg-accent/60' : 'hover:bg-accent/50 border-transparent')
                }
              >
                <FolderOpen className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="min-w-0 truncate" title={one.name}>
                    {one.name}
                  </span>
                  <span className="text-muted-foreground min-w-0 truncate text-[11px]" title={one.path}>
                    {one.missing ? 'folder missing · ' : ''}
                    {one.kehikot.length} {one.kehikot.length === 1 ? 'kehikko' : 'kehikot'}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section aria-label={open ? `${open.name}’s kehikot` : 'Kehikot'} className="flex min-w-0 flex-col gap-2">
        {open === null ? (
          <p className="text-muted-foreground text-xs">Pick a project to see its kehikot.</p>
        ) : open.kehikot.length === 0 ? (
          <p className="text-muted-foreground text-xs">{open.name} has no kehikot.</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 [&>*]:min-w-0" data-elsewhere-cards="">
            {open.kehikot.map((one) => (
              <KehikkoCard
                key={one.id}
                kehikko={one}
                registered={registered}
                official={official}
                chosen={chosen?.id === one.id}
                onChoose={() => onChoose(one)}
              />
            ))}
          </div>
        )}
        {chosen ? (
          <fieldset className="flex min-w-0 flex-col gap-1.5" data-elsewhere-take="">
            <legend className="mb-1 text-xs font-medium">
              Also take its settings <span className="text-muted-foreground font-normal">— the arrangement always comes; nothing of {open?.name ?? 'the other project'}’s own does</span>
            </legend>
            {(['general', 'skills', 'agents'] as const).map((group) => (
              <label key={group} className="flex min-w-0 items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={take[group]}
                  onChange={(event) => onTake({ ...take, [group]: event.target.checked })}
                  className="accent-primary mt-0.5 shrink-0"
                  data-elsewhere-group={group}
                />
                <span className="flex min-w-0 flex-col">
                  <span>{GROUP_SAID[group]}</span>
                  <span className="text-muted-foreground min-w-0 text-xs [overflow-wrap:anywhere]">{has[group]}</span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
      </section>
    </div>
  )
}
