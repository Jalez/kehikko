import { describe, expect, test } from 'bun:test'

import { MESSAGE, PROTOCOL, WELL_KNOWN } from 'kehikot-module-protocol'

import { Conversation, type Answer } from '@/host/conversation.ts'
import { toWireContext } from '@/host/context.ts'
import { look } from '../server/discover.ts'
import { serialize } from '../server/kehikot.ts'
import { originEnv } from '../server/launch.ts'

/*
 * How the host finds a module, greets it, and says who may frame it: one
 * well-known path, one spelling of the wire, one list of origins.
 */

const AT = 'http://127.0.0.1:7940'

/** A manifest in some other app's dialect, served at that app's own path. */
const foreignManifest = {
  kind: 'other.module',
  protocol: PROTOCOL,
  id: 'other.notes',
  name: 'Notes',
  entry: '/app',
  modes: [{ id: 'notes', label: 'Notes' }],
  extensions: { emits: ['other.notifications@1'], consumes: [] },
  declares: { protocol: `>=${PROTOCOL} <${PROTOCOL + 1}` },
}

/** A fetch that serves one document at one path and 404s everything else. */
function servingAt(path: string, document: unknown) {
  const asked: string[] = []
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input)
    asked.push(new URL(url).pathname)
    if (!url.endsWith(path)) return new Response('not here', { status: 404 })
    return new Response(JSON.stringify(document), { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, asked }
}

describe('finding a module', () => {
  test('only the well-known path is asked, and another kind is not a manifest', async () => {
    const foreign = servingAt('/.well-known/other-module.json', foreignManifest)
    const presence = await look({ id: 'kehikot.notes', url: AT, file: '/r/kehikot.notes.json' }, foreign.fetchImpl)
    expect(foreign.asked).toEqual([WELL_KNOWN])
    expect(presence.condition).toBe('silent')
  })

  test('a current module is asked once, at the current path', async () => {
    const { fetchImpl, asked } = servingAt(WELL_KNOWN, { ...foreignManifest, kind: 'kehikot.module', id: 'kehikot.notes', extensions: { emits: ['kehikot.notifications@1'], consumes: [] }, partless: 'Notes on a file, not on a part.' })
    const presence = await look({ id: 'kehikot.notes', url: AT, file: '/r/kehikot.notes.json' }, fetchImpl)
    expect(asked).toEqual([WELL_KNOWN])
    expect(presence.condition).toBe('ready')
  })

  test('nothing at the path is said about that path', async () => {
    const { fetchImpl } = servingAt('/nowhere', {})
    const presence = await look({ id: 'kehikot.notes', url: AT, file: '/r/x.json' }, fetchImpl)
    expect(presence.condition).toBe('silent')
    expect(presence.line).toContain(WELL_KNOWN)
  })
})

describe('a project’s kehikot.json', () => {
  test('serialize writes only what it was given', () => {
    expect(serialize([])).toContain('"version": 2')
  })
})

function frameAndWindow() {
  const sent: Record<string, unknown>[] = []
  const contentWindow = {
    postMessage(message: unknown) {
      sent.push(message as Record<string, unknown>)
    },
  } as unknown as Window
  return { frame: { contentWindow }, contentWindow, sent }
}

const quiet = () => ({
  ready: () => {},
  silent: () => {},
  fault: () => {},
  height: () => {},
  filters: () => {},
  clearable: () => {},
  refreshable: () => {},
  header: () => {},
})

const nothing: Answer = { ok: true, data: null }

describe('talking to a module', () => {
  test('a module is greeted in the one spelling there is', () => {
    const { frame, sent } = frameAndWindow()
    const conversation = new Conversation(frame, 'kehikot.notes', null, async () => nothing, quiet())
    conversation.greet(toWireContext({ epic: null, project: null }, 'dark'))
    expect(sent[0]?.type).toBe(MESSAGE.HELLO)
  })
})

describe('who may frame a module this host starts', () => {
  test('KEHIKOT_ORIGINS lists the dev page, the app page, the desktop window and this page', () => {
    const env = originEnv({}, ['http://127.0.0.1:4291'])
    const list = env.KEHIKOT_ORIGINS!.split(' ')
    for (const origin of ['http://127.0.0.1:4181', 'http://127.0.0.1:4170', 'tauri://localhost', 'http://127.0.0.1:4291']) {
      expect(list).toContain(origin)
    }
    /* The single name carries the same list: a module reading it puts it
       straight into `frame-ancestors`. */
    expect(env.KEHIKOT_ORIGIN).toBe(env.KEHIKOT_ORIGINS)
  })

  test('the origins the host was started with come first, and nothing is lost', () => {
    const env = originEnv({ KEHIKOT_ORIGIN: 'tauri://localhost http://tauri.localhost' }, [])
    expect(env.KEHIKOT_ORIGINS!.startsWith('tauri://localhost http://tauri.localhost ')).toBe(true)
    expect(env.KEHIKOT_ORIGINS!.split(' ')).toContain('http://127.0.0.1:4181')
    expect(env.KEHIKOT_ORIGIN).toBe(env.KEHIKOT_ORIGINS)
  })

  test('a list the host was given is kept, first', () => {
    const env = originEnv({ KEHIKOT_ORIGINS: 'http://a http://b' }, [])
    expect(env.KEHIKOT_ORIGINS!.startsWith('http://a http://b ')).toBe(true)
  })
})

