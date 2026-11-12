import { ChevronDown, ChevronRight, Layers, Pencil, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { nodeAt, type Space, type SpaceNode } from 'kehikot-module-protocol'

import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import {
  branchesTo,
  breadcrumb,
  keyOf,
  readOpenBranches,
  spacesUnder,
  treeKey,
  treeRows,
  typeAhead,
  writeOpenBranches,
} from '@/host/spaces.ts'
import { SORT_WORDS, type PickerSort } from '@/host/pickerOrder.ts'
import { loadVisits, setSort, usePickerSort, useVisits } from '@/host/pickerStore.ts'
import {
  BUCKET_WORDS,
  bucketOf,
  headings,
  lifeWords,
  matchedTree,
  sortedTree,
  spaceLives,
  worstElsewhere,
  type Bucket,
  type SpaceActivity,
} from '@/host/spaceRecency.ts'
import { ActivityDot } from './Activity.tsx'
import { Hint } from './Hint.tsx'

/**
 * The space picker in the bar: one breadcrumb, "Project › Space › Sub-space", in place of the epic and
 * parts pickers it replaced.
 *
 * Its list is a TREE (`role="tree"`): the top-level spaces, each with a chevron, every subtree closed
 * until it is opened — except the branch holding the space the project is on, which is opened so the
 * current space is in view, and marked. What is open is the person's, per project, in this browser
 * (`readOpenBranches`). The keyboard is the tree pattern's (`treeKey`): Up and Down move, Right opens,
 * Left closes, Enter picks; typing a letter jumps to the next row starting with it, and the filter at
 * the top searches every depth and opens the branches above a match.
 *
 * Each row can add a space under it, be renamed and be removed (armed: the second press, with the
 * server's own sentence of what goes). The children of the space the project is on carry checkboxes:
 * several siblings picked at once, which is what picking several parts was.
 *
 * Each row carries the activity dot the epic and part rows had (the worst live item of the Inbox
 * record in it; a closed branch shows the worst of everything under it), and the list is ordered by a
 * switch at its top, Recent activity or Alphabetical — the choice the epic picker kept (`PickerSorts`,
 * its `epics` entry). Recent sorts each level's siblings by the later of the person's last visit and
 * the last activity by anyone, in the space or under it, and groups them under time headings.
 *
 * Every rule is in `src/host/spaces.ts` and `src/host/spaceRecency.ts`; this draws.
 */

export type SpaceEditAsked =
  | { create: { parent: string[]; name: string } }
  | { rename: { path: string[]; name: string } }
  | { remove: { path: string[]; confirm?: boolean } }

/** What the server said to an edit: whether it changed, and its sentence when not. */
export interface SpaceEditAnswer {
  outcome: string
  why: string
  path: string[] | null
}

export interface SpacePickerProps {
  tree: readonly SpaceNode[]
  /** The space the project is on, with names; null for none. */
  here: Space | null
  /** "All spaces": the whole project at once. */
  all: boolean
  project: { id: number; name: string } | null
  onPick(ids: string[], picked?: string[]): void
  onPickAll(): void
  /** Null when the spaces cannot be edited here (no project, or one nothing may be written into). */
  onEdit: ((edit: SpaceEditAsked) => Promise<SpaceEditAnswer>) | null
  /** For tests: where open branches are remembered. Defaults to this browser's storage. */
  store?: Pick<Storage, 'getItem' | 'setItem'> | null
  /** Whether the list starts open (a test, or a tour step that shows it). */
  defaultOpen?: boolean
  /** The open project's Inbox record, for the dots and for when each space last saw activity. */
  activity?: readonly SpaceActivity[]
  /** For tests: the clock the time headings are read against. */
  clock?: () => number
}

/** The words of the order switch: the space picker says what Recent means here. */
const ORDER_WORDS: Record<PickerSort, string> = { recent: 'Recent activity', az: 'Alphabetical' }
const ORDERS: readonly PickerSort[] = ['recent', 'az']
const NO_ACTIVITY: readonly SpaceActivity[] = []

const browserStore = (): Pick<Storage, 'getItem' | 'setItem'> | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function SpacePicker({
  tree,
  here,
  all,
  project,
  onPick,
  onPickAll,
  onEdit,
  store,
  defaultOpen = false,
  activity = NO_ACTIVITY,
  clock = Date.now,
}: SpacePickerProps) {
  const storage = store === undefined ? browserStore() : store
  const projectId = project?.id ?? null
  const [isOpen, setOpen] = useState(defaultOpen)
  const [opened, setOpened] = useState<Set<string>>(() => readOpenBranches(projectId, storage))
  const [filter, setFilter] = useState('')
  const [focus, setFocus] = useState(0)
  /** A name being typed: under which parent (a new space) or for which space (a rename). */
  const [naming, setNaming] = useState<{ parent: string[] } | { path: string[]; was: string } | null>(null)
  const [name, setName] = useState('')
  const [arming, setArming] = useState<{ key: string; why: string } | null>(null)
  const [trouble, setTrouble] = useState('')
  const typed = useRef({ text: '', at: 0 })
  const treeRef = useRef<HTMLDivElement | null>(null)
  const sort = usePickerSort('epics')
  const visits = useVisits()
  /* The clock the headings read, taken again each time the list opens. */
  const [now, setNow] = useState(clock)
  useEffect(() => {
    if (!isOpen) return
    setNow(clock())
    /* What another window visited since is in it. */
    void loadVisits()
  }, [isOpen]) // eslint-disable-line react-hooks/exhaustive-deps
  const lives = useMemo(() => spaceLives(tree, projectId, visits, activity, now), [tree, projectId, visits, activity, now])

  /* Another project remembers other branches. */
  useEffect(() => setOpened(readOpenBranches(projectId, storage)), [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  const hereIds = useMemo(() => (here ? here.path.map((step) => step.id) : []), [here])
  const hereKey = keyOf(hereIds)
  /* The current branch is always open while the list is drawn, on top of what the person opened. */
  /* And the current space itself, so its children — the siblings that can be picked together — are in view. */
  const shown = useMemo(() => new Set([...opened, ...branchesTo(hereIds), ...(hereIds.length ? [keyOf(hereIds)] : [])]), [opened, hereIds])
  /* Each level's siblings in the chosen order — by match while filtering — and the tree kept. */
  const ordered = useMemo(() => (filter.trim() ? matchedTree(tree, filter) : sortedTree(tree, sort, lives)), [tree, filter, sort, lives])
  const rows = useMemo(() => treeRows(ordered, shown, filter), [ordered, shown, filter])
  /* The time headings: under Recent only, and never while filtering. */
  const headed = useMemo(
    () => (sort === 'recent' && !filter.trim() ? headings(rows, (ids) => bucketOf(lives.get(keyOf(ids))?.last, now)) : new Map<number, Bucket>()),
    [rows, sort, filter, lives, now],
  )
  const elsewhere = all ? null : worstElsewhere(lives, tree, hereIds)

  /* Opening the list puts the focus on the current space. */
  useEffect(() => {
    if (!isOpen) return
    const at = rows.findIndex((row) => keyOf(row.ids) === hereKey)
    setFocus(at >= 0 ? at : 0)
  }, [isOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  const remember = (next: Set<string>) => {
    setOpened(next)
    writeOpenBranches(projectId, next, storage)
  }
  const toggle = (key: string, open: boolean) => {
    const next = new Set(opened)
    if (open) next.add(key)
    else next.delete(key)
    remember(next)
  }

  const pick = (ids: string[], picked?: string[]) => {
    onPick(ids, picked)
    setOpen(false)
  }

  /* Several siblings: the children of the space the project is on, or the picked ones it has. */
  const pickedHere = here?.picked ?? []
  const siblingsOf = (ids: readonly string[]): boolean => !!here && ids.length === hereIds.length + 1 && keyOf(ids.slice(0, -1)) === hereKey
  const togglePicked = (id: string) => {
    const next = pickedHere.includes(id) ? pickedHere.filter((one) => one !== id) : [...pickedHere, id]
    onPick(hereIds, next)
  }

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (naming) return
    const move = treeKey(rows, focus, event.key)
    if (move) {
      event.preventDefault()
      if ('pick' in move) return pick(move.pick)
      setFocus(move.focus)
      if ('open' in move) toggle(move.open, true)
      if ('close' in move) toggle(move.close, false)
      return
    }
    if (event.key.length === 1 && /\S/.test(event.key) && !event.metaKey && !event.ctrlKey) {
      const now = Date.now()
      typed.current = { text: now - typed.current.at < 700 ? typed.current.text + event.key : event.key, at: now }
      setFocus(typeAhead(rows, typed.current.text.length > 1 ? focus - 1 : focus, typed.current.text))
    }
  }

  useEffect(() => {
    const row = treeRef.current?.querySelector<HTMLElement>(`[data-row="${focus}"]`)
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [focus])

  const submit = async () => {
    if (!naming || !onEdit) return
    const said = name.trim()
    if (!said) return
    const answer = await onEdit('parent' in naming ? { create: { parent: naming.parent, name: said } } : { rename: { path: naming.path, name: said } })
    if (answer.outcome === 'changed' || answer.outcome === 'unchanged') {
      if ('parent' in naming && naming.parent.length) toggle(keyOf(naming.parent), true)
      setNaming(null)
      setName('')
      setTrouble('')
    } else setTrouble(answer.why)
  }

  const remove = async (ids: string[]) => {
    if (!onEdit) return
    const key = keyOf(ids)
    const armed = arming?.key === key
    const answer = await onEdit({ remove: { path: ids, confirm: armed } })
    if (answer.outcome === 'confirm') setArming({ key, why: answer.why })
    else if (answer.outcome === 'changed') {
      setArming(null)
      setTrouble('')
    } else setTrouble(answer.why)
  }

  /* Which heading each row sits under: the last one opened among its siblings. */
  const headingIds = useMemo(() => {
    const out = new Map<number, string>()
    const current = new Map<string, string>()
    rows.forEach((row, index) => {
      const parent = keyOf(row.ids.slice(0, -1))
      if (headed.has(index)) current.set(parent, `space-heading-${index}`)
      const id = current.get(parent)
      if (id) out.set(index, id)
    })
    return out
  }, [rows, headed])
  const headingOf = (index: number): string | undefined => headingIds.get(index)

  const crumbs = breadcrumb(null, here, all)
  const label = !project
    ? 'no project is open, so there are no spaces'
    : tree.length === 0
      ? 'this project has no spaces yet — open this to make one'
      : all
        ? 'every space of this project at once'
        : here
          ? `the space every module on this kehikko works in: ${crumbs.join(' › ')}`
          : 'no space is picked'

  return (
    <Popover
      open={isOpen}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setFilter('')
          setNaming(null)
          setArming(null)
          setTrouble('')
        }
      }}
    >
      <Hint label={label} align="start">
        <span className="inline-flex min-w-16 shrink-[20] max-[480px]:min-w-12 max-[400px]:min-w-5">
          <PopoverTrigger asChild disabled={!project}>
            <Button
              variant="ghost"
              size="sm"
              aria-label="the space this project is on"
              data-tour="space"
              disabled={!project}
              className="h-6 max-w-96 min-w-6 shrink gap-1 px-1.5 text-xs disabled:pointer-events-none"
            >
              {all ? <Layers className="text-muted-foreground size-3 shrink-0 max-[640px]:hidden" /> : null}
              <nav aria-label="space" className="flex min-w-0 items-center gap-0.5">
                {crumbs.length === 0 ? (
                  <span className="text-muted-foreground truncate">{project ? 'no space' : 'no project'}</span>
                ) : (
                  crumbs.map((crumb, index) => (
                    <span key={`${index}-${crumb}`} className="flex min-w-0 items-center gap-0.5">
                      {index > 0 ? <span className="text-muted-foreground shrink-0">›</span> : null}
                      <span className={index === crumbs.length - 1 ? 'min-w-0 truncate' : 'text-muted-foreground min-w-0 truncate max-[640px]:hidden'}>
                        {crumb}
                      </span>
                    </span>
                  ))
                )}
                {here && here.picked.length > 1 ? <span className="text-muted-foreground shrink-0">({here.picked.length})</span> : null}
              </nav>
              {/* Another space holds something: said on the closed control, so it is not found only by opening the list. */}
              {elsewhere ? <ActivityDot state={elsewhere} what="another space" /> : null}
              {project ? <ChevronDown className="text-muted-foreground size-3 shrink-0 max-[640px]:hidden" /> : null}
            </Button>
          </PopoverTrigger>
        </span>
      </Hint>
      <PopoverContent align="start" className="w-80 p-1" data-space-picker>
        <Input
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value)
            setFocus(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'Enter') {
              event.preventDefault()
              if (event.key === 'Enter' && rows[0]) return pick(rows.find((row) => row.match)?.ids ?? rows[0].ids)
              treeRef.current?.focus()
            }
          }}
          placeholder="Find a space"
          aria-label="find a space"
          data-space-filter
          className="mb-1 h-7 text-xs"
        />
        {tree.length > 1 ? (
          <div
            role="radiogroup"
            aria-label="order of spaces"
            data-space-order
            className="bg-muted mb-1 flex gap-0.5 rounded-md p-0.5"
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              event.preventDefault()
              const next = sort === 'recent' ? 'az' : 'recent'
              void setSort('epics', next).catch(() => undefined)
              event.currentTarget.querySelector<HTMLElement>(`[data-order="${next}"]`)?.focus()
            }}
          >
            {ORDERS.map((one) => (
              <button
                key={one}
                type="button"
                role="radio"
                aria-checked={sort === one}
                tabIndex={sort === one ? 0 : -1}
                data-order={one}
                title={one === 'recent' ? 'the latest visit or activity first, under time headings' : SORT_WORDS.az.says}
                onClick={() => {
                  if (one !== sort) void setSort('epics', one).catch(() => undefined)
                }}
                className={`flex min-w-0 flex-1 items-center justify-center truncate rounded-sm px-2 py-0.5 text-[11px] ${sort === one ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground'}`}
              >
                {ORDER_WORDS[one]}
              </button>
            ))}
            <span role="status" className="sr-only">
              spaces ordered {sort === 'recent' ? 'by recent activity' : 'alphabetically'}
            </span>
          </div>
        ) : null}
        <button
          type="button"
          role="option"
          aria-selected={all}
          className={`hover:bg-accent w-full rounded-sm px-2 py-1 text-left text-xs ${all ? 'font-medium' : ''}`}
          onClick={() => {
            onPickAll()
            setOpen(false)
          }}
          data-space-all
        >
          All spaces
        </button>
        <div
          ref={treeRef}
          role="tree"
          aria-label="spaces"
          tabIndex={0}
          aria-activedescendant={rows[focus] ? `space-row-${keyOf(rows[focus]!.ids)}` : undefined}
          onKeyDown={onKey}
          className="max-h-[50vh] overflow-auto outline-none"
        >
          {rows.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1 text-xs">{filter ? 'No space matches.' : 'No spaces yet.'}</p>
          ) : (
            rows.map((row, index) => {
              const key = keyOf(row.ids)
              const bucket = headed.get(index)
              const headingId = headingOf(index)
              const life = lives.get(key)
              /* An open branch shows its own; a closed one the worst of its whole subtree. */
              const dot = row.open ? (life?.mark ?? null) : (life?.markBelow ?? null)
              const said = lifeWords(life, now)
              const node = nodeAt(tree, row.ids)
              const current = key === hereKey
              const under = node ? spacesUnder(node) : 0
              const sibling = siblingsOf(row.ids)
              const renaming = naming && 'path' in naming && keyOf(naming.path) === key
              return (
                <div key={key}>
                  {bucket ? (
                    <div
                      id={`space-heading-${index}`}
                      aria-hidden
                      data-space-heading={bucket}
                      className="text-muted-foreground px-2 pt-1.5 pb-0.5 text-[10px] font-medium tracking-wide uppercase"
                      style={{ paddingLeft: `${row.depth * 12 + 8}px` }}
                    >
                      {BUCKET_WORDS[bucket]}
                    </div>
                  ) : null}
                  <div
                    id={`space-row-${key}`}
                    aria-describedby={headingId}
                    role="treeitem"
                    aria-level={row.depth + 1}
                    aria-expanded={row.children ? row.open : undefined}
                    aria-selected={current}
                    aria-current={current ? 'location' : undefined}
                    data-row={index}
                    data-space-row={key}
                    data-focused={index === focus || undefined}
                    className={`group flex items-center gap-1 rounded-sm py-0.5 pr-1 text-xs ${index === focus ? 'bg-accent' : ''} ${current ? 'font-medium' : ''} ${row.match ? '' : 'text-muted-foreground'}`}
                    style={{ paddingLeft: `${row.depth * 12 + 2}px` }}
                    onMouseEnter={() => setFocus(index)}
                  >
                    {row.children ? (
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={row.open ? `close ${row.name}` : `open ${row.name}`}
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => toggle(key, !row.open)}
                        data-space-chevron
                      >
                        {row.open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                      </button>
                    ) : (
                      <span className="inline-block size-3" />
                    )}
                    {sibling ? (
                      <Checkbox
                        checked={pickedHere.includes(row.ids[row.ids.length - 1]!)}
                        onCheckedChange={() => togglePicked(row.ids[row.ids.length - 1]!)}
                        aria-label={`pick ${row.name} beside its siblings`}
                        data-space-check
                      />
                    ) : null}
                    {renaming ? (
                      <Input
                        autoFocus
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        onKeyDown={(event) => {
                          event.stopPropagation()
                          if (event.key === 'Enter') void submit()
                          if (event.key === 'Escape') setNaming(null)
                        }}
                        aria-label="the space's name"
                        className="h-6 flex-1 text-xs"
                      />
                    ) : (
                      <button type="button" tabIndex={-1} className="min-w-0 flex-1 truncate text-left" title={said || undefined} onClick={() => pick(row.ids)}>
                        {row.name}
                      </button>
                    )}
                    {dot ? <ActivityDot state={dot} what={dot === life?.mark ? row.name : `inside ${row.name}`} /> : null}
                    {under ? (
                      <span className="text-muted-foreground shrink-0 tabular-nums" title={`${under} space${under === 1 ? '' : 's'} under it`}>
                        {under}
                      </span>
                    ) : null}
                    {onEdit && !renaming ? (
                      <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex group-data-[focused]:flex">
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label={`add a space under ${row.name}`}
                          title="Add a space under it"
                          data-tour={index === 0 ? 'space-add' : undefined}
                          data-space-add
                          onClick={() => {
                            setNaming({ parent: row.ids })
                            setName('')
                          }}
                        >
                          <Plus className="size-3" />
                        </button>
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label={`rename ${row.name}`}
                          title="Rename"
                          onClick={() => {
                            setNaming({ path: row.ids, was: row.name })
                            setName(row.name)
                          }}
                        >
                          <Pencil className="size-3" />
                        </button>
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label={arming?.key === key ? `really remove ${row.name}` : `remove ${row.name}`}
                          title={arming?.key === key ? 'Press again to remove it' : 'Remove'}
                          className={arming?.key === key ? 'text-destructive' : ''}
                          data-space-remove
                          onClick={() => void remove(row.ids)}
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    ) : null}
                  </div>
                  {arming?.key === key ? <p className="text-muted-foreground px-6 pb-1 text-[11px]">{arming.why}</p> : null}
                  {naming && 'parent' in naming && keyOf(naming.parent) === key ? (
                    <div className="py-0.5" style={{ paddingLeft: `${(row.depth + 1) * 12 + 16}px` }}>
                      <Input
                        autoFocus
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        onKeyDown={(event) => {
                          event.stopPropagation()
                          if (event.key === 'Enter') void submit()
                          if (event.key === 'Escape') setNaming(null)
                        }}
                        placeholder={`A space in ${row.name}`}
                        aria-label="the new space's name"
                        data-tour="space-form"
                        className="h-6 text-xs"
                      />
                    </div>
                  ) : null}
                </div>
              )
            })
          )}
        </div>
        {onEdit ? (
          naming && 'parent' in naming && naming.parent.length === 0 ? (
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key === 'Enter') void submit()
                if (event.key === 'Escape') setNaming(null)
              }}
              placeholder="The new space’s name"
              aria-label="the new space's name"
              data-tour="space-form"
              className="mt-1 h-7 text-xs"
            />
          ) : (
            <button
              type="button"
              className="hover:bg-accent text-muted-foreground mt-1 flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-xs"
              onClick={() => {
                setNaming({ parent: [] })
                setName('')
              }}
              data-tour="new-space"
            >
              <Plus className="size-3" /> new space…
            </button>
          )
        ) : null}
        {trouble ? (
          <p role="alert" className="text-destructive px-2 py-1 text-[11px]">
            {trouble}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
