import { FileJson, Lock, Plus, Settings as Gear, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react'
import { Loading } from '@/components/ui/loading.tsx'

import { Button } from '@/components/ui/button.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { ModalBody, ModalContent, ModalHeader } from '@/components/ui/modal.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import {
  controlFor,
  notAnswering,
  numberOf,
  SETTINGS_READ_MS,
  savedSaid,
  settingsHint,
  settingsPlaceFor,
  type SetAnswer,
  type SettingField,
  type SettingsAnswer,
  type SettingsListed,
} from '@/host/moduleSettings.ts'
import { modeFor, type MenuMode } from './HeaderMenus.tsx'
import { ModuleIcon } from './ModuleIcon.tsx'
import { ConnectionsTab, type ConnectionsProps } from './Connections.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx'
import type { ModuleScope } from 'kehikot-module-protocol'
import { scopeTooltip, type ContainerScope } from '@/host/scope.ts'
import { moduleSettingsTarget } from '@/host/agentSettings.ts'
import { TARGET_ATTR } from '@/host/settingsTarget.ts'
import { ScopeControl, ScopeIcon } from './Scope.tsx'
import { revealTarget, TARGET_ATTR } from '@/host/settingsTarget.ts'

/**
 * A module's settings, drawn from what it declared (`declares.settings`, protocol 2.15.0) and
 * changed through the module's own door, one change at a time: the module writes, and says
 * "saved" or why not. This page holds no value of its own between reads. Reached from the gear in
 * a container's header, from the Container menu's "Settings…", and from Settings › Modules. Rules and
 * words: `host/moduleSettings.ts`.
 */

/* ------------------------------------------------------------------ *
 * Asking the host
 * ------------------------------------------------------------------ */

export interface SettingsApi {
  list(): Promise<readonly SettingsListed[]>
  read(module: string, project: number | null): Promise<SettingsAnswer>
  set(module: string, project: number | null, key: string, value: unknown): Promise<SetAnswer>
  file(module: string, project: number | null): Promise<{ ok: true; path: string; file: string; text: string } | { ok: false; why: string }>
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', signal })
  const read = (await response.json().catch(() => null)) as T | null
  if (read === null) throw new Error('Kehikot did not answer.')
  return read
}

const said = (error: unknown) => ({ ok: false as const, why: error instanceof Error ? error.message : 'Kehikot did not answer.' })

export const HOST_SETTINGS_API: SettingsApi = {
  list: async () => (await post<{ modules?: SettingsListed[] }>('/host/module-settings/list', {})).modules ?? [],
  read: (module, project) => post<SettingsAnswer>('/host/module-settings', { module, project }).catch(said),
  set: (module, project, key, value) => post<SetAnswer>('/host/module-settings/set', { module, project, key, value }).catch(said),
  file: (module, project) => post<{ ok: true; path: string; file: string; text: string } | { ok: false; why: string }>('/host/module-settings/file', { module, project }).catch(said),
}

/* ------------------------------------------------------------------ *
 * The project a form is for, and whether a module can open a file
 * ------------------------------------------------------------------ */

export interface SettingsProject {
  id: number
  name: string
}

/**
 * Show a file read-only in a module that opens files (`opens: ['file']`, protocol 2.33.0): the page sets this
 * (`App.tsx`), and answers whether it could. Without one, the file is shown in a dialog here.
 */
let opener: ((path: string) => boolean) | null = null
export function setSettingsFileOpener(open: ((path: string) => boolean) | null): void {
  opener = open
}

/* ------------------------------------------------------------------ *
 * The form
 * ------------------------------------------------------------------ */

type Note = { tone: 'saved' | 'refused'; text: string }

/**
 * A read that has not come within `ms` is answered "not answering", so the form never spins without
 * end: the host gives a module a few seconds, and a host that is itself held up is waited for no
 * longer than this.
 */
export function readWithin(read: Promise<SettingsAnswer>, ms: number, name: string): Promise<SettingsAnswer> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<SettingsAnswer>((done) => {
    timer = setTimeout(() => done({ ok: false, why: notAnswering(name) }), ms)
  })
  return Promise.race([read, late]).finally(() => clearTimeout(timer))
}

export function ModuleSettingsForm({
  module,
  project,
  api = HOST_SETTINGS_API,
  onOpened,
  name,
  target = null,
  readMs = SETTINGS_READ_MS,
}: {
  module: string
  /** The project's id; null for a module whose settings are all machine settings, or none open. */
  project: number | null
  api?: SettingsApi
  /** The file was put in a module that opens files: the caller may close itself. */
  onOpened?(): void
  /** The module's name, for "<name> isn't answering"; its id when absent. */
  name?: string
  /** The setting to scroll to, focus and light once the form is drawn (`settings.open`, protocol 2.90.0). */
  target?: string | null
  /** How long a read is waited for; for tests. */
  readMs?: number
}) {
  const [answer, setAnswer] = useState<SettingsAnswer | null>(null)
  const [attempt, setAttempt] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const [notes, setNotes] = useState<Record<string, Note>>({})
  const [busy, setBusy] = useState<readonly string[]>([])
  const [shown, setShown] = useState<{ file: string; text: string } | null>(null)
  const [fileWhy, setFileWhy] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setAnswer(null)
    void readWithin(api.read(module, project), readMs, name ?? module).then((read) => {
      if (live) setAnswer(read)
    })
    return () => {
      live = false
    }
  }, [api, module, project, readMs, name, attempt])

  /* Once the form is drawn, the setting a module's page asked for is shown: scrolled to, focused, lit. */
  const drawn = answer?.ok === true
  useEffect(() => {
    if (drawn && target && root.current) revealTarget(root.current, target)
  }, [drawn, target])

  const change = useCallback(
    async (field: SettingField, value: unknown) => {
      setBusy((was) => [...was, field.key])
      const came = await api.set(module, project, field.key, value)
      setBusy((was) => was.filter((key) => key !== field.key))
      setNotes((was) => ({ ...was, [field.key]: savedSaid(came) }))
      if (!('ok' in came) && came.outcome === 'saved' && came.values) {
        const values = came.values
        setAnswer((was) => (was?.ok ? { ...was, values } : was))
      }
    },
    [api, module, project],
  )

  if (answer === null) return <Loading className="text-sm" label="Reading the settings…" />
  if (!answer.ok)
    return (
      <div className="flex min-w-0 flex-col items-start gap-2">
        <p className="text-muted-foreground text-sm" data-settings-why>
          {answer.why}
        </p>
        <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)} data-settings-retry>
          Try again
        </Button>
      </div>
    )

  const openFile = async () => {
    setFileWhy(null)
    const got = await api.file(module, project)
    if (!got.ok) return setFileWhy(got.why)
    if (opener?.(got.path)) return onOpened?.()
    setShown({ file: got.file, text: got.text })
  }

  return (
    <div ref={root} className="flex min-w-0 flex-col gap-4" data-module-settings={module}>
      {answer.problem ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs" data-settings-problem>
          {answer.problem}
        </p>
      ) : null}
      {answer.fields.map((field) => (
        <Field
          key={field.key}
          field={field}
          value={answer.values[field.key]}
          note={notes[field.key] ?? null}
          busy={busy.includes(field.key)}
          onChange={(value) => void change(field, value)}
        />
      ))}
      {answer.file ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 border-t pt-3">
          <Button variant="outline" size="sm" onClick={() => void openFile()} data-settings-open-file>
            <FileJson aria-hidden />
            Open the file
          </Button>
          <span className="text-muted-foreground min-w-0 truncate font-mono text-[11px]" title={answer.file}>
            {answer.file}
          </span>
          <span className="text-muted-foreground w-full text-[11px]">{answer.name} writes this file; change it here, not by hand.</span>
          {fileWhy ? <span className="text-destructive w-full text-xs">{fileWhy}</span> : null}
        </div>
      ) : null}
      <FileDialog shown={shown} name={answer.name} onClose={() => setShown(null)} />
    </div>
  )
}

function Field({
  field,
  value,
  note,
  busy,
  onChange,
}: {
  field: SettingField
  value: unknown
  note: Note | null
  busy: boolean
  onChange(value: unknown): void
}) {
  const id = `setting-${field.key}`
  const control = controlFor(field)
  const described = field.description ? `${id}-about` : undefined
  const label = (
    <Label htmlFor={id} className="text-sm leading-snug font-medium">
      {field.label}
    </Label>
  )
  return (
    <div className="-mx-1.5 flex min-w-0 flex-col gap-1.5 rounded-md px-1.5 py-1 transition-colors data-[lit=true]:bg-amber-500/10 data-[lit=true]:ring-2 data-[lit=true]:ring-amber-500/50" data-setting={field.key} data-control={control} {...{ [TARGET_ATTR]: field.key }}>
      {control === 'switch' ? (
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            {label}
            <About id={described} field={field} />
          </div>
          <Switch
            id={id}
            checked={value === true}
            disabled={busy}
            aria-describedby={described}
            onCheckedChange={(next) => onChange(next === true)}
          />
        </div>
      ) : (
        <>
          {label}
          <About id={described} field={field} />
          {control === 'select' ? (
            <NativeSelect id={id} value={typeof value === 'string' ? value : ''} disabled={busy} aria-describedby={described} onChange={(event) => onChange(event.target.value)}>
              {(field.choices ?? []).map((choice) => (
                <NativeSelectOption key={choice.value} value={choice.value}>
                  {choice.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : control === 'lines' ? (
            <Lines id={id} value={Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []} busy={busy} onChange={onChange} />
          ) : (
            <Typed id={id} number={control === 'number'} value={value} busy={busy} described={described} onChange={onChange} />
          )}
        </>
      )}
      <span role="status" aria-live="polite" className={note?.tone === 'refused' ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'} data-setting-note={note?.tone}>
        {note?.text ?? ''}
      </span>
    </div>
  )
}

function About({ id, field }: { id: string | undefined; field: SettingField }) {
  if (!field.description && !field.personOnly && field.scope !== 'machine') return null
  return (
    <p id={id} className="text-muted-foreground text-xs leading-relaxed">
      {field.description}
      {field.personOnly ? (
        <span className="ml-1 inline-flex items-center gap-1 whitespace-nowrap" data-person-only>
          <Lock className="size-3" aria-hidden />
          only you can change this
        </span>
      ) : null}
      {field.scope === 'machine' ? <span className="ml-1 whitespace-nowrap">· for this computer</span> : null}
    </p>
  )
}

/** A text or number field: saved on Enter and when it loses focus, when it changed. */
function Typed({
  id,
  number,
  value,
  busy,
  described,
  onChange,
}: {
  id: string
  number: boolean
  value: unknown
  busy: boolean
  described: string | undefined
  onChange(value: unknown): void
}) {
  const shown = value === undefined || value === null ? '' : String(value)
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  const commit = () => {
    if (text === shown) return
    if (!number) return onChange(text)
    const read = numberOf(text)
    onChange(read === null ? text : read)
  }
  return (
    <Input
      id={id}
      type={number ? 'number' : 'text'}
      value={text}
      disabled={busy}
      aria-describedby={described}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') setText(shown)
      }}
    />
  )
}

/** A list: one line each, edited in place, removed with ✕ and added at the foot. Each edit is one change. */
function Lines({ id, value, busy, onChange }: { id: string; value: readonly string[]; busy: boolean; onChange(value: string[]): void }) {
  const [adding, setAdding] = useState('')
  const add = () => {
    const line = adding.trim()
    if (!line) return
    onChange([...value, line])
    setAdding('')
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-lines>
      {value.map((line, at) => (
        <div key={`${at}:${line}`} className="flex min-w-0 items-center gap-1.5">
          <Line
            value={line}
            busy={busy}
            label={`line ${at + 1}`}
            onChange={(next) => onChange(next.trim() ? value.map((one, n) => (n === at ? next.trim() : one)) : value.filter((_, n) => n !== at))}
          />
          <Button variant="ghost" size="icon" className="size-8" disabled={busy} aria-label={`remove line ${at + 1}`} onClick={() => onChange(value.filter((_, n) => n !== at))}>
            <X className="size-3.5" aria-hidden />
          </Button>
        </div>
      ))}
      <div className="flex min-w-0 items-center gap-1.5">
        <Input
          id={id}
          value={adding}
          placeholder="Add a line"
          disabled={busy}
          onChange={(event) => setAdding(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') add()
          }}
        />
        <Button variant="outline" size="icon" className="size-8" disabled={busy || !adding.trim()} aria-label="add the line" onClick={add}>
          <Plus className="size-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  )
}

function Line({ value, busy, label, onChange }: { value: string; busy: boolean; label: string; onChange(value: string): void }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = () => {
    if (text !== value) onChange(text)
  }
  return (
    <Input
      value={text}
      aria-label={label}
      disabled={busy}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
    />
  )
}

/** The file, read-only, when no module here opens files. */
function FileDialog({ shown, name, onClose }: { shown: { file: string; text: string } | null; name: string; onClose(): void }) {
  return (
    <Dialog open={shown !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <ModalContent className="sm:max-w-2xl" data-settings-file>
        <ModalHeader title={shown?.file} titleClassName="font-mono" description={<>Read-only. {name} writes this file; change its settings in the form.</>} />
        <ModalBody>
          <pre className="bg-muted/50 rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
            {shown?.text ? shown.text : '(The file is not there yet: every setting has its default.)'}
          </pre>
        </ModalBody>
      </ModalContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ *
 * The modal, and how it is reached
 * ------------------------------------------------------------------ */

export function ModuleSettingsDialog({
  open,
  onOpenChange,
  module,
  name,
  project,
  api,
  hasSettings = true,
  connections = null,
  scope = null,
  target = null,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  module: string
  name: string
  project: SettingsProject | null
  api?: SettingsApi
  /** Whether the module declared settings: the "Settings" tab is drawn only then. */
  hasSettings?: boolean
  /**
   * The module's connections on the open kehikko (`host/connections.ts`): the "Providers & Consumers"
   * tab. Null, there is no kehikko open, and no tab.
   */
  connections?: ConnectionsProps | null
  /**
   * The container's scope on the open kehikko (protocol 2.29.0): drawn beside the title and as the
   * "Scope" control at the top, above both tabs. `onPick` is the person's pick among the scopes the
   * module lists; absent, the control is read-only. Null: no container of it is open, nothing drawn.
   */
  scope?: { value: ContainerScope; onPick?(scope: ModuleScope): void } | null
  /** The setting to open at (`settings.open`, protocol 2.90.0): the Settings tab, scrolled to it. */
  target?: string | null
}) {
  const tabs = [...(hasSettings ? (['settings'] as const) : []), ...(connections ? (['connections'] as const) : [])]
  const [tab, setTab] = useState<string>(tabs[0] ?? 'settings')
  /* A module asking for one setting brings the Settings tab forward, whichever tab was showing. */
  useEffect(() => {
    if (target) setTab('settings')
  }, [target])
  const shown = (tabs as readonly string[]).includes(tab) ? tab : (tabs[0] ?? 'settings')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ModalContent className="max-h-[min(720px,calc(100dvh-2rem))] sm:max-w-xl" data-module-settings-dialog={module}>
        <ModalHeader
          icon={<ModuleIcon id={module} name={name} className="text-muted-foreground size-4" />}
          title={settingsHint(name)}
          context={
            scope ? (
              <span data-testid="settings-scope" data-scope={scope.value.active} title={scopeTooltip(scope.value)} className="text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded border px-1 text-[10px] font-normal">
                <ScopeIcon scope={scope.value.active} />
                {scope.value.name}
                <span className="sr-only"> scope ({scope.value.isDefault ? 'default' : 'changed'})</span>
              </span>
            ) : null
          }
          description={
            shown === 'settings'
              ? `${project ? `For ${project.name}. ` : ''}Each change is saved by ${name} as you make it.`
              : `How ${name} and the other modules on this kehikko affect each other.`
          }
        />
        {/* The scope and the tab strip stay put; only the tab's own content scrolls. */}
        <ModalBody scroll={false} className="gap-4 px-4 py-4 sm:px-5">
        {scope ? <ScopeControl module={module} scope={scope.value} onPick={scope.onPick} /> : null}
        <Tabs value={shown} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-3">
          {tabs.length > 1 ? (
            <TabsList aria-label={`${name} settings sections`} className="w-full">
              <TabsTrigger value="settings" data-tab="settings" className="text-xs">
                Settings
              </TabsTrigger>
              <TabsTrigger value="connections" data-tab="connections" className="text-xs">
                Providers &amp; Consumers
              </TabsTrigger>
            </TabsList>
          ) : null}
          {hasSettings ? (
            <TabsContent value="settings" className="min-h-0 overflow-y-auto overscroll-contain pr-1" data-modal-scroll="">
              {open && shown === 'settings' ? <ModuleSettingsForm module={module} name={name} target={target} project={project?.id ?? null} api={api} onOpened={() => onOpenChange(false)} /> : null}
            </TabsContent>
          ) : null}
          {connections ? (
            <TabsContent value="connections" className="min-h-0 overflow-y-auto overscroll-contain pr-1" data-modal-scroll="">
              {open && shown === 'connections' ? <ConnectionsTab module={module} {...connections} /> : null}
            </TabsContent>
          ) : null}
          {!tabs.length && !scope ? <p className="text-muted-foreground text-xs">{name} has no settings, and no kehikko is open.</p> : null}
        </Tabs>
        </ModalBody>
      </ModalContent>
    </Dialog>
  )
}

/** How wide the header this is drawn in is, as a menu mode, kept as it is resized. */
function useHeaderMode(anchor: RefObject<HTMLElement | null>): MenuMode {
  const [mode, setMode] = useState<MenuMode>('words')
  useLayoutEffect(() => {
    const header = anchor.current?.closest<HTMLElement>('.container-grip')
    if (!header) return
    const measure = () => setMode(modeFor(header.offsetWidth || null))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const watching = new ResizeObserver(measure)
    watching.observe(header)
    return () => watching.disconnect()
  }, [anchor])
  return mode
}

/**
 * The gear in a container's header, for a module that declared settings. Icon-only, with the
 * tooltip "<Module> settings". Under 220 px it is not drawn: "Settings…" is then a Container row in
 * the one "⋯" (`settingsPlaceFor`). `mode` is for tests;
 * left out, the header is measured.
 */
export function SettingsButton({ name, onOpen, mode: asked, hint }: { name: string; onOpen(): void; mode?: MenuMode; hint?: (children: ReactElement) => ReactNode }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const measured = useHeaderMode(anchor)
  const place = settingsPlaceFor(asked ?? measured)
  return (
    <span ref={anchor} className="contents" data-settings-place={place}>
      {place === 'button'
        ? (hint ?? ((children: ReactElement): ReactNode => children))(
            <Button
              variant="ghost"
              size="icon"
              aria-label={settingsHint(name)}
              title={hint ? undefined : settingsHint(name)}
              data-settings-button
              className="text-muted-foreground hover:text-foreground pointer-events-auto size-6 shrink-0 cursor-default"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={onOpen}
            >
              <Gear className="size-3" aria-hidden />
            </Button>,
          )
        : null}
    </span>
  )
}

/* ------------------------------------------------------------------ *
 * Settings › Modules
 * ------------------------------------------------------------------ */

/** Every installed module, its icon and its settings, each form for the project the page has open. */
export function ModulesSettings({ api = HOST_SETTINGS_API, project }: { api?: SettingsApi; project: SettingsProject | null }) {
  const [modules, setModules] = useState<readonly SettingsListed[] | null>(null)
  const [why, setWhy] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api
      .list()
      .then((listed) => live && setModules([...listed].sort((a, b) => Number(b.fields.length > 0) - Number(a.fields.length > 0) || a.name.localeCompare(b.name))))
      .catch(() => live && setWhy('Kehikot did not answer with its modules.'))
    return () => {
      live = false
    }
  }, [api])

  if (why) return <p className="text-muted-foreground text-sm">{why}</p>
  if (!modules) return <Loading className="text-sm" label="Reading the modules…" />
  return (
    <div className="flex min-w-0 flex-col gap-4" data-settings-modules>
      <p className="text-muted-foreground text-xs leading-relaxed">
        What each module lets you set{project ? ` for ${project.name}` : ''}. The module saves each change itself, in its own folder of the project; Kehikot never writes there.
      </p>
      {modules.map((one) => (
        <section key={one.id} className="min-w-0 rounded-lg border px-4 py-3" aria-labelledby={`module-settings-${one.id}`} data-settings-module={one.id} {...{ [TARGET_ATTR]: moduleSettingsTarget(one.id) }}>
          <h4 id={`module-settings-${one.id}`} className="mb-3 flex items-center gap-2 text-sm font-medium">
            <ModuleIcon id={one.id} icon={one.icon} name={one.name} className="text-muted-foreground size-4" />
            {one.name}
          </h4>
          {!one.ready ? (
            <p className="text-muted-foreground text-xs">Not running, so its settings cannot be read now.</p>
          ) : one.fields.length ? (
            <ModuleSettingsForm module={one.id} name={one.name} project={project?.id ?? null} api={api} />
          ) : (
            <p className="text-muted-foreground text-xs">No settings.</p>
          )}
        </section>
      ))}
    </div>
  )
}
