import { RotateCcw, Search } from 'lucide-react'
import { useId, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import {
  AUTOMATIC,
  CHOOSABLE,
  KIND_SAID,
  chosen,
  isAutomatic,
  reset,
  switched,
  type Connection,
  type ConnectionsSetting,
  type ModuleSide,
  type Row,
} from '@/host/connections.ts'
import { ModuleIcon } from './ModuleIcon.tsx'

/**
 * Providers & Consumers: how the modules on the open kehikko affect each other, as their manifests
 * say (`host/connections.ts`), and the person's switches for this kehikko. One module's side is the
 * tab of its settings window (`ModuleSettingsDialog`); "See all on this kehikko" lists every module.
 *
 * Every connection is a sentence and a switch; an off one says "off" in words beside its switch, never
 * by colour alone. A consumer of a kind several modules here provide chooses which ("From"). Each row
 * has "Reset to automatic"; the whole kehikko has one too. A module's strings are text.
 */

export interface ConnectionsProps {
  sides: readonly ModuleSide[]
  setting: ConnectionsSetting
  onChange(next: ConnectionsSetting): void
}

const rowTitle = (row: Row) => (row.kind === 'extension' ? `${KIND_SAID.extension}: ${row.about}` : row.kind === 'skill' ? `Skill /${row.about}` : KIND_SAID[row.kind])

/** Whether anything in this row is not as the manifests say. */
const changed = (row: Row) => row.only !== null || row.edges.some((edge) => edge.switchable && !edge.on)

function Edge({ edge, side, nameOf, setting, onChange }: { edge: Connection; side: 'provides' | 'consumes'; nameOf(id: string): string } & Omit<ConnectionsProps, 'sides'>) {
  const other = side === 'provides' ? edge.to : edge.from
  return (
    <li className="flex min-w-0 items-start gap-2 py-1" data-connection={edge.key} data-on={edge.on ? 'on' : 'off'}>
      <ModuleIcon id={other} name={nameOf(other)} className="text-muted-foreground mt-0.5 size-3.5" />
      <div className="min-w-0 flex-1">
        <p className={`text-xs leading-snug break-words ${edge.on ? '' : 'text-muted-foreground'}`}>{edge.on ? edge.said : edge.offSaid}</p>
        {edge.switchable ? null : <p className="text-muted-foreground text-[11px] leading-snug">{edge.why}</p>}
      </div>
      {edge.switchable ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="text-muted-foreground w-5 text-right text-[11px]" aria-hidden>
            {edge.on ? 'on' : 'off'}
          </span>
          <Switch
            checked={edge.on}
            aria-label={edge.said}
            onCheckedChange={(on) => onChange(switched(setting, edge, on))}
          />
        </span>
      ) : null}
    </li>
  )
}

function RowView({ row, side, nameOf, setting, onChange }: { row: Row; side: 'provides' | 'consumes'; nameOf(id: string): string } & Omit<ConnectionsProps, 'sides'>) {
  const selectId = useId()
  const choosable = side === 'consumes' && CHOOSABLE.has(row.kind) && row.edges.length > 1
  const owner = side === 'consumes' ? row.edges[0]!.to : row.edges[0]!.from
  const choice = row.only === null ? 'any' : row.only.length === 1 ? row.only[0]! : 'some'
  return (
    <section className="min-w-0 rounded-md border px-3 py-2" data-connection-row={row.key} aria-label={`${rowTitle(row)}, ${side === 'provides' ? 'provided' : 'taken'}`}>
      <div className="flex min-w-0 items-center gap-2">
        <h4 className="min-w-0 flex-1 truncate text-xs font-medium" title={rowTitle(row)}>
          {rowTitle(row)}
        </h4>
        {changed(row) ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground h-6 shrink-0 gap-1 px-1.5 text-[11px]"
            data-reset-row
            onClick={() => onChange(reset(setting, row.edges))}
          >
            <RotateCcw className="size-3" aria-hidden />
            Reset to automatic
          </Button>
        ) : null}
      </div>
      {choosable ? (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
          <label htmlFor={selectId} className="text-muted-foreground text-[11px]">
            From
          </label>
          <div className="min-w-40 flex-1">
            <NativeSelect
              id={selectId}
              className="h-7 text-xs"
              value={choice}
              data-choose-provider
              onChange={(event) => {
                const value = event.target.value
                if (value === 'some') return
                onChange(chosen(setting, { kind: row.kind, to: owner, about: row.about }, value === 'any' ? null : [value]))
              }}
            >
              <NativeSelectOption value="any">any module here that provides it</NativeSelectOption>
              {row.edges.map((edge) => (
                <NativeSelectOption key={edge.from} value={edge.from}>
                  only {nameOf(edge.from)}
                </NativeSelectOption>
              ))}
              {choice === 'some' ? <NativeSelectOption value="some">some of them (switched below)</NativeSelectOption> : null}
            </NativeSelect>
          </div>
        </div>
      ) : null}
      <ul className="mt-1">
        {row.edges.map((edge) => (
          <Edge key={edge.key} edge={edge} side={side} nameOf={nameOf} setting={setting} onChange={onChange} />
        ))}
      </ul>
    </section>
  )
}

/** One module's two sides: what it provides here, and what it takes here. */
export function ModuleConnections({ side, nameOf, setting, onChange, heading = false }: { side: ModuleSide; nameOf(id: string): string; heading?: boolean } & Omit<ConnectionsProps, 'sides'>) {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-module-connections={side.id}>
      {heading ? (
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <ModuleIcon id={side.id} name={side.name} className="text-muted-foreground size-4" />
          {side.name}
        </h3>
      ) : null}
      {(['provides', 'consumes'] as const).map((which) => {
        const rows = which === 'provides' ? side.provides : side.consumes
        return (
          <div key={which} className="flex min-w-0 flex-col gap-2" data-side={which}>
            <h4 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">{which === 'provides' ? 'Provides' : 'Consumes'}</h4>
            {rows.length ? (
              rows.map((row) => <RowView key={row.key} row={row} side={which} nameOf={nameOf} setting={setting} onChange={onChange} />)
            ) : (
              <p className="text-muted-foreground text-xs">
                {which === 'provides' ? `Nothing ${side.name} provides is taken by another module here.` : `${side.name} takes nothing from another module here.`}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Every module on the kehikko, searchable, with "Reset all to automatic". */
export function KehikkoConnections({ sides, setting, onChange }: ConnectionsProps) {
  const [query, setQuery] = useState('')
  const nameOf = useMemo(() => nameReader(sides), [sides])
  const words = query.trim().toLowerCase()
  const shown = words
    ? sides
        .map((side) => {
          const hit = (row: Row) =>
            side.name.toLowerCase().includes(words) ||
            rowTitle(row).toLowerCase().includes(words) ||
            row.edges.some((edge) => `${edge.said} ${edge.offSaid} ${nameOf(edge.from)} ${nameOf(edge.to)}`.toLowerCase().includes(words))
          return { ...side, provides: side.provides.filter(hit), consumes: side.consumes.filter(hit) }
        })
        .filter((side) => side.provides.length || side.consumes.length)
    : sides
  return (
    <div className="flex min-w-0 flex-col gap-4" data-kehikko-connections>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" aria-hidden />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a module or a kind"
            aria-label="Find a module or a kind of connection"
            className="h-8 pl-7 text-xs"
          />
        </div>
        <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" disabled={isAutomatic(setting)} data-reset-all onClick={() => onChange(AUTOMATIC)}>
          <RotateCcw className="size-3" aria-hidden />
          Reset all to automatic
        </Button>
      </div>
      {shown.length ? (
        shown.map((side) => <ModuleConnections key={side.id} side={side} nameOf={nameOf} setting={setting} onChange={onChange} heading />)
      ) : (
        <p className="text-muted-foreground text-xs">{words ? 'Nothing here matches.' : 'No module here sets or publishes anything another one takes.'}</p>
      )}
    </div>
  )
}

export function nameReader(sides: readonly ModuleSide[]): (id: string) => string {
  const names = new Map(sides.map((side) => [side.id, side.name]))
  return (id) => names.get(id) ?? id
}

/** The tab of a module's settings window: its own sides, and the way to every module's. */
export function ConnectionsTab({ module, sides, setting, onChange }: { module: string } & ConnectionsProps) {
  const [all, setAll] = useState(false)
  const nameOf = useMemo(() => nameReader(sides), [sides])
  const mine = sides.find((side) => side.id === module) ?? { id: module, name: nameOf(module), provides: [], consumes: [] }
  return (
    <div className="flex min-w-0 flex-col gap-3" data-connections-tab={all ? 'all' : module}>
      <p className="text-muted-foreground text-xs leading-relaxed">
        {all ? 'What the modules on this kehikko provide each other' : `What ${mine.name} provides the other modules on this kehikko, and what it takes from them`},
        read from what each module says it does. A switch changes only this kehikko, travels with the project, and is yours alone: no agent can change it.
      </p>
      <div>
        <Button variant="link" size="sm" className="h-auto px-0 text-xs" data-see-all onClick={() => setAll(!all)}>
          {all ? `Back to ${mine.name}` : 'See all on this kehikko'}
        </Button>
      </div>
      {all ? (
        <KehikkoConnections sides={sides} setting={setting} onChange={onChange} />
      ) : (
        <ModuleConnections side={mine} nameOf={nameOf} setting={setting} onChange={onChange} />
      )}
    </div>
  )
}
