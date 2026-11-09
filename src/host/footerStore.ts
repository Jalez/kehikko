import type { FooterItem } from 'kehikot-module-protocol'
import { useMemo, useSyncExternalStore } from 'react'

import { NO_FOOTER, NO_FOOTERS, footedIds, footerDeclared, footerWithdrawn, type Footers } from './footer.ts'

/**
 * What each module last declared for its footer, held OUTSIDE the page's React state.
 *
 * A footer is where a module puts its live readouts — a call rate, a load, a context count — and a
 * module re-declares it as often as a readout moves, every second for some. Held in `App`'s state,
 * each re-declaration re-rendered the whole page: every container, the bar, every memo. Held here,
 * a re-declaration notifies only who subscribed to that one module's footer (its container's footer
 * row, through `source(id)`), and whoever subscribed to all of them (`subscribe`) decides for
 * itself whether what it reads changed — `App` reads only which containers have a footer
 * (`footedIds`), which a ticking readout never changes.
 *
 * Pure but for its listeners, so it is tested without a browser. The rules about what a footer is
 * stay in `footer.ts`; this only holds and tells.
 */

/** One module's footer, as `useSyncExternalStore` reads it: the same array until it is re-declared different. */
export interface FooterSource {
  get(): readonly FooterItem[]
  subscribe(listener: () => void): () => void
}

export class FooterStore {
  #held: Footers = NO_FOOTERS
  readonly #each = new Map<string, Set<() => void>>()
  readonly #all = new Set<() => void>()
  readonly #sources = new Map<string, FooterSource>()

  /** Every footer held, by module id. A new object only when one changed. */
  all = (): Footers => this.#held

  get(id: string): readonly FooterItem[] {
    return this.#held[id] ?? NO_FOOTER
  }

  /** A module's list replaced whole (`footerDeclared`); nobody is told when nothing changed. */
  declare(id: string, items: readonly FooterItem[]): void {
    this.#set(id, footerDeclared(this.#held, id, items))
  }

  /** A module's document is gone, and so is what it declared. */
  withdraw(id: string): void {
    this.#set(id, footerWithdrawn(this.#held, id))
  }

  /** Told after any footer changed. */
  subscribe = (listener: () => void): (() => void) => {
    this.#all.add(listener)
    return () => this.#all.delete(listener)
  }

  /** One module's footer, the same object for every call with that id, so a component can hand it down without re-rendering. */
  source(id: string): FooterSource {
    let source = this.#sources.get(id)
    if (!source) {
      source = {
        get: () => this.get(id),
        subscribe: (listener) => {
          let set = this.#each.get(id)
          if (!set) this.#each.set(id, (set = new Set()))
          set.add(listener)
          return () => {
            set.delete(listener)
            if (!set.size) this.#each.delete(id)
          }
        },
      }
      this.#sources.set(id, source)
    }
    return source
  }

  #set(id: string, next: Footers): void {
    if (next === this.#held) return
    this.#held = next
    for (const listener of [...(this.#each.get(id) ?? [])]) listener()
    for (const listener of [...this.#all]) listener()
  }
}

const NEVER = () => () => {}

/** A footer that never changes, for a container handed a plain list (a test, a preview). One per list. */
const fixed = new WeakMap<readonly FooterItem[], FooterSource>()
export function fixedFooter(items: readonly FooterItem[]): FooterSource {
  let source = fixed.get(items)
  if (!source) fixed.set(items, (source = { get: () => items, subscribe: NEVER }))
  return source
}

/**
 * Which containers have a footer, for the page: re-renders its caller only when that set changes
 * (`footedIds`), never when a readout in one moves. What `App` reads of the footers.
 */
export function useFooted(store: FooterStore): ReadonlySet<string> {
  const key = useSyncExternalStore(store.subscribe, () => footedIds(store.all()))
  return useMemo(() => new Set(key ? key.split('\n') : []), [key])
}
