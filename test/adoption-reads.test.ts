import { afterEach, beforeEach, expect, test } from 'bun:test'

import * as client from '../src/host/adoptClient.ts'

/*
 * Whether an Inbox item can be adopted, asked once and kept (Jalez/kehikko#384): an Inbox page asks
 * again on every change of its record and every tick, so the page asked `/host/inbox/adoption`
 * about 1.7 times a second with the same answer each time. The answer is kept until something
 * that changes it is said (`forgetAdoptions`), asks out together are one request, and a person's
 * press asks afresh.
 */

const realFetch = globalThis.fetch
let asked: string[] = []
let failing = false

const OFFER = { outcome: 'ok', why: '', item: null, epics: [], suggested: null, conversations: [], agent: null, proposal: null }

beforeEach(() => {
  asked = []
  failing = false
  client.forgetAdoptions?.()
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = String(url)
    if (path.startsWith('/host/inbox/adoption')) asked.push(path)
    if (failing) return new Response(JSON.stringify({ error: 'down' }), { status: 500 })
    return new Response(JSON.stringify({ adoption: OFFER }))
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const KEY = { module: 'example.tracker', id: 'gh#41' }

test('an Inbox page asking again and again about an unchanged item makes one request', async () => {
  for (let i = 0; i < 6; i++) expect((await client.fetchAdoption(7, KEY, 'k1')).outcome).toBe('ok')
  expect(asked).toHaveLength(1)
})

test('asks out together are one request', async () => {
  await Promise.all([client.fetchAdoption(7, KEY, 'k1'), client.fetchAdoption(7, KEY, 'k1'), client.fetchAdoption(7, KEY, 'k1')])
  expect(asked).toHaveLength(1)
})

test('another item, project or kehikko is its own question', async () => {
  await client.fetchAdoption(7, KEY, 'k1')
  await client.fetchAdoption(7, KEY, 'k2')
  await client.fetchAdoption(8, KEY, 'k1')
  await client.fetchAdoption(7, { ...KEY, id: 'gh#42' }, 'k1')
  expect(asked).toHaveLength(4)
})

test('news that changes the answer, or a person’s press, asks again', async () => {
  await client.fetchAdoption(7, KEY, 'k1')
  client.forgetAdoptions()
  await client.fetchAdoption(7, KEY, 'k1')
  await client.fetchAdoption(7, KEY, 'k1', { fresh: true })
  expect(asked).toHaveLength(3)
})

test('a failed ask is not kept: the next one asks again', async () => {
  failing = true
  expect((await client.fetchAdoption(7, KEY, 'k1')).outcome).toBe('declined')
  failing = false
  expect((await client.fetchAdoption(7, KEY, 'k1')).outcome).toBe('ok')
  expect(asked).toHaveLength(2)
})
