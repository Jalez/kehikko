import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SpaceNode } from 'kehikot-module-protocol'

import { SpacePicker } from '../src/canvas/SpacePicker.tsx'
import { TooltipProvider } from '../src/components/ui/tooltip.tsx'
import { branchesTo, breadcrumb, keyOf, readOpenBranches, spaceHere, treeKey, treeRows, typeAhead, writeOpenBranches } from '../src/host/spaces.ts'

/**
 * The space picker: a breadcrumb in the bar, a tree in its list. Every subtree closed until opened,
 * the branch holding the current space open, the tree pattern's keyboard, and a filter that searches
 * every depth.
 */

const TREE: SpaceNode[] = [
  {
    id: 'auth',
    name: 'Auth',
    children: [
      { id: 'login', name: 'Login', children: [{ id: 'errors', name: 'Errors', children: [{ id: 'copy', name: 'Copy', children: [] }] }] },
      { id: 'signup', name: 'Sign-up', children: [] },
    ],
  },
  { id: 'billing', name: 'Billing', children: [{ id: 'invoices', name: 'Invoices', children: [] }] },
  { id: 'search', name: 'Search', children: [] },
]

const shown = (rows: ReturnType<typeof treeRows>) => rows.map((row) => keyOf(row.ids))

describe('the tree', () => {
  test('collapsed by default: only the top-level spaces', () => {
    const rows = treeRows(TREE, new Set())
    expect(shown(rows)).toEqual(['auth', 'billing', 'search'])
    expect(rows.map((row) => [row.children, row.open])).toEqual([[2, false], [1, false], [0, false]])
  })

  test('the branch holding the current space is open, so it is in view', () => {
    const open = new Set(branchesTo(['auth', 'login', 'errors']))
    expect(shown(treeRows(TREE, open))).toEqual(['auth', 'auth/login', 'auth/login/errors', 'auth/signup', 'billing', 'search'])
  })

  test('keyboard: down and up move, right opens, left closes or goes to the parent, Enter picks', () => {
    let open = new Set<string>()
    let rows = treeRows(TREE, open)
    expect(treeKey(rows, 0, 'ArrowDown')).toEqual({ focus: 1 })
    expect(treeKey(rows, 0, 'ArrowUp')).toEqual({ focus: 0 })
    expect(treeKey(rows, 0, 'ArrowRight')).toEqual({ focus: 0, open: 'auth' })
    open = new Set(['auth'])
    rows = treeRows(TREE, open)
    expect(treeKey(rows, 0, 'ArrowRight')).toEqual({ focus: 1 })
    expect(treeKey(rows, 1, 'ArrowLeft')).toEqual({ focus: 0 })
    expect(treeKey(rows, 0, 'ArrowLeft')).toEqual({ focus: 0, close: 'auth' })
    expect(treeKey(rows, 1, 'Enter')).toEqual({ pick: ['auth', 'login'] })
    expect(treeKey(rows, 0, 'End')).toEqual({ focus: rows.length - 1 })
    expect(treeKey(rows, 0, 'x')).toBeNull()
  })

  test('type-ahead jumps to the next name starting with what was typed', () => {
    const rows = treeRows(TREE, new Set())
    expect(typeAhead(rows, 0, 's')).toBe(2)
    expect(typeAhead(rows, 2, 'a')).toBe(0)
    expect(typeAhead(rows, 1, 'zz')).toBe(1)
  })

  test('the filter searches every depth and opens the branches above a match', () => {
    const rows = treeRows(TREE, new Set(), 'cop')
    expect(shown(rows)).toEqual(['auth', 'auth/login', 'auth/login/errors', 'auth/login/errors/copy'])
    expect(rows.map((row) => row.match)).toEqual([false, false, false, true])
    expect(rows.slice(0, 3).every((row) => row.open)).toBe(true)
    expect(treeRows(TREE, new Set(), 'nothing like it')).toEqual([])
  })

  test('picking a deep space from a filtered list', () => {
    const rows = treeRows(TREE, new Set(), 'copy')
    expect(treeKey(rows, 3, 'Enter')).toEqual({ pick: ['auth', 'login', 'errors', 'copy'] })
  })

  test('what is open is remembered per project, and storage that throws costs nothing', () => {
    const kept = new Map<string, string>()
    const store = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) }
    writeOpenBranches(7, new Set(['auth', 'billing']), store)
    expect([...readOpenBranches(7, store)]).toEqual(['auth', 'billing'])
    expect([...readOpenBranches(8, store)]).toEqual([])
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect([...readOpenBranches(7, broken)]).toEqual([])
    expect(() => writeOpenBranches(7, new Set(['auth']), broken)).not.toThrow()
  })
})

describe('the breadcrumb', () => {
  test('Project › Space › Sub-space', () => {
    const here = spaceHere(TREE, { epic: 'auth', parts: ['login'], space: { ids: ['auth', 'login', 'errors'], picked: [] } })
    expect(breadcrumb('Thesis', here)).toEqual(['Thesis', 'Auth', 'Login', 'Errors'])
    expect(breadcrumb('Thesis', null, true)).toEqual(['Thesis', 'All spaces'])
  })

  test('drawn in the bar, with no epic or part word in it', () => {
    const here = spaceHere(TREE, { epic: 'auth', parts: ['login'], space: { ids: ['auth', 'login', 'errors'], picked: [] } })
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SpacePicker tree={TREE} here={here} all={false} project={{ id: 1, name: 'Thesis' }} onPick={() => {}} onPickAll={() => {}} onEdit={null} store={null} />
      </TooltipProvider>,
    )
    expect(html).toContain('data-tour="space"')
    expect(html).toContain('Auth')
    expect(html).toContain('Errors')
    expect(html).toContain('›')
    expect(html.toLowerCase()).not.toMatch(/\bepic|\bpart\b|\bparts\b/)
  })
})

