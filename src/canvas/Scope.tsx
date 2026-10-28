import { Flag, Folder, Laptop, LayoutGrid, Puzzle, type LucideIcon } from 'lucide-react'
import type { ModuleScope } from 'kehikot-module-protocol'

import { cn } from '@/lib/utils.ts'
import { onlyScopeSaid, scopeRowTooltip, scopeTooltip, type ContainerScope } from '@/host/scope.ts'
import { Hint } from './Hint.tsx'

/**
 * A module's scope, drawn (protocol 2.29.0): what its content belongs to — This
 * computer, Project, Epic, Part or Kehikko — as a small label with its icon.
 * Every rule (which scope is active, what the tooltip says) is in
 * `host/scope.ts`; this file only draws it. The scope is said in words in the
 * label, its tooltip and its accessible name, never only by its icon.
 */

const ICONS: Record<ModuleScope, LucideIcon> = {
  machine: Laptop,
  project: Folder,
  epic: Flag,
  part: Puzzle,
  kehikko: LayoutGrid,
}

/** A scope's icon, decorative: its name is always said beside it or in the control's name. */
export function ScopeIcon({ scope, className }: { scope: ModuleScope; className?: string }) {
  const Icon = ICONS[scope]
  return <Icon aria-hidden="true" className={cn('size-3 shrink-0', className)} />
}

/**
 * The scope in a container's header: the icon and the scope's name, or the icon
 * alone where the header has no room (`scopeText` in `host/headerFit.ts`, the
 * first thing to give way). A button: it opens the module's settings window,
 * where the scope is picked; its tooltip and name say the scope, whether it is
 * the default, and the module's line for it.
 */
export function ScopeLabel({ scope, text, onOpen }: { scope: ContainerScope; text: boolean; onOpen?(): void }) {
  const said = scopeTooltip(scope)
  return (
    <Hint label={said} side="bottom" align="start">
      <button
        type="button"
        data-testid="header-scope"
        data-scope={scope.active}
        data-scope-default={scope.isDefault ? 'true' : 'false'}
        aria-label={said}
        onClick={onOpen}
        className={cn(
          'text-muted-foreground hover:text-foreground inline-flex h-5 shrink-0 items-center gap-1 rounded border px-1 text-[10px] leading-none',
          !scope.isDefault && 'border-primary/40 text-foreground',
        )}
      >
        <ScopeIcon scope={scope.active} />
        {text ? <span className="whitespace-nowrap">{scope.name}</span> : null}
      </button>
    </Hint>
  )
}

/**
 * The scope on a module's row where modules are picked (the modules menu, My
 * modules): the default's icon and name, and a tooltip with the module's line
 * and the other scopes it can work at.
 */
export function ScopeChip({ scope, className }: { scope: ContainerScope; className?: string }) {
  const said = scopeRowTooltip(scope)
  return (
    <Hint label={said} side="bottom" align="start">
      <span
        data-testid="module-scope"
        data-scope={scope.active}
        tabIndex={0}
        aria-label={said}
        className={cn('text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded border px-1 text-[10px] leading-4', className)}
      >
        <ScopeIcon scope={scope.active} />
        <span className="whitespace-nowrap">{scope.name}</span>
      </span>
    </Hint>
  )
}

/**
 * The "Scope" control at the top of a module's settings window: every scope the
 * module can work at, each with its line, the default marked, the active one
 * chosen. A module with one scope shows it read-only with "This module only
 * works for <scope>." — Kehikot cannot make a module change what its content
 * belongs to. Only the person picks; nothing here is reachable by an agent.
 */
export function ScopeControl({ module, scope, onPick }: { module: string; scope: ContainerScope; onPick?(scope: ModuleScope): void }) {
  const one = scope.supported.length === 1
  return (
    <section data-testid="scope-control" data-scope={scope.active} aria-labelledby={`scope-heading-${module}`} className="flex flex-col gap-1.5 rounded-md border p-2">
      <h3 id={`scope-heading-${module}`} className="flex items-center gap-1.5 text-xs font-medium">
        Scope
        <span className="text-muted-foreground font-normal">— what this module&apos;s content belongs to</span>
      </h3>
      {one ? (
        <div data-testid="scope-only" className="flex flex-col gap-0.5 text-xs">
          <span className="inline-flex items-center gap-1.5">
            <ScopeIcon scope={scope.active} className="size-3.5" />
            <span className="font-medium">{scope.name}</span>
          </span>
          <span className="text-muted-foreground">
            {onlyScopeSaid(scope)} {scope.says}
          </span>
        </div>
      ) : (
        <div role="radiogroup" aria-labelledby={`scope-heading-${module}`} className="flex flex-col gap-1">
          {scope.supported.map((one) => {
            const id = `scope-${module}-${one.scope}`
            return (
              <label key={one.scope} htmlFor={id} data-scope-option={one.scope} className="hover:bg-accent/50 flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 text-xs">
                <input
                  id={id}
                  type="radio"
                  name={`scope-${module}`}
                  value={one.scope}
                  checked={scope.active === one.scope}
                  onChange={() => onPick?.(one.scope)}
                  className="mt-0.5"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="inline-flex items-center gap-1.5">
                    <ScopeIcon scope={one.scope} className="size-3.5" />
                    <span className="font-medium">{one.name}</span>
                    {one.isDefault ? <span className="text-muted-foreground">(default)</span> : null}
                  </span>
                  <span className="text-muted-foreground">{one.says}</span>
                </span>
              </label>
            )
          })}
        </div>
      )}
    </section>
  )
}
