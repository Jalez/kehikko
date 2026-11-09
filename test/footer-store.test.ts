import { describe, expect, test } from 'bun:test'
import { footerItemsSchema } from 'kehikot-module-protocol'

import { FooterStore } from '../src/host/footerStore.ts'
import { NO_FOOTER } from '../src/host/footer.ts'

const rate = (text: string) => footerItemsSchema.parse([{ kind: 'text', id: 'rate', text }])

describe('the footers, held outside the page’s state', () => {
  test('a declaration tells that module’s listeners and the page’s, and no other module’s', () => {
    const store = new FooterStore()
    const told = { a: 0, b: 0, all: 0 }
    store.source('a').subscribe(() => told.a++)
    store.source('b').subscribe(() => told.b++)
    store.subscribe(() => told.all++)
    store.declare('a', rate('1/min'))
    expect(told).toEqual({ a: 1, b: 0, all: 1 })
    expect(store.source('a').get()).toEqual(rate('1/min'))
  })

  test('the same list again tells nobody, and its source keeps the same array', () => {
    const store = new FooterStore()
    store.declare('a', rate('1/min'))
    const held = store.source('a').get()
    let told = 0
    store.subscribe(() => told++)
    store.declare('a', rate('1/min'))
    expect(told).toBe(0)
    expect(store.source('a').get()).toBe(held)
  })

  test('a source is the same object every time; a withdrawn footer is none', () => {
    const store = new FooterStore()
    expect(store.source('a')).toBe(store.source('a'))
    store.declare('a', rate('1/min'))
    store.withdraw('a')
    expect(store.get('a')).toBe(NO_FOOTER)
    expect(store.all()).toEqual({})
  })

  test('a listener that unsubscribed is not told', () => {
    const store = new FooterStore()
    let told = 0
    const stop = store.source('a').subscribe(() => told++)
    stop()
    store.declare('a', rate('1/min'))
    expect(told).toBe(0)
  })
})
