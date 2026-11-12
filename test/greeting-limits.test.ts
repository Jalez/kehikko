import { describe, expect, test } from 'bun:test'
import { hostMessageSchema, LIMITS, MESSAGE } from 'kehikot-module-protocol'
/* The schemas pages built on older protocols read the greeting with, from the tagged packages
   (`devDependencies`). 2.85.0 is what most installed modules are built on; 2.82.0 the oldest. */
import { hostMessageSchema as schema285 } from '../node_modules/protocol-2.85.0/src/index.ts'
import { hostMessageSchema as schema282 } from '../node_modules/protocol-2.82.0/src/index.ts'

import { promptFor, type Placement } from '@/host/canvases.ts'
import { Conversation, type ConversationWatcher } from '@/host/conversation.ts'
import { toWireContext } from '@/host/context.ts'
import { fitContext } from '@/host/fitContext.ts'

/**
 * A greeting every page can read, whatever protocol it was built on.
 *
 * A kehikko with ten modules on it composed a prompt over `LIMITS.PROMPT` (each module's note is
 * up to `LIMITS.GUIDANCE`). A page reads the greeting with its own schema, which caps the prompt
 * at 8 KiB in every version. A page on 2.93.0 says it could not read it; a page built before drops
 * it without a word, and the container reported it as having "said nothing for 60 seconds",
 * reload after reload. Measured on a real canvas: a prompt of 8474 characters.
 */

const SCHEMAS = [
  ['this host’s', hostMessageSchema],
  ['2.85.0', schema285],
  ['2.82.0', schema282],
] as const

const container = (i: string, y: number, prompt = '', aimedAt: string | null = null): Placement => ({
  i,
  x: 0,
  y,
  w: 6,
  h: 10,
  grow: false,
  pinned: false,
  prompt,
  promptFor: aimedAt,
  collapsed: false,
  wish: 10,
  selected: false,
  filters: {},
  refreshEvery: null,
  version: null,
  scope: null,
})

/** Ten modules on one kehikko, each with a full note, and one instruction aimed at the target. */
function crowded() {
  const ids = Array.from({ length: 10 }, (_, n) => `kehikot.m${n}`)
  const placements = [...ids.map((id, n) => container(id, n * 10)), container('kehikot.writer', 200, 'Keep the slides in step with chapter 3.', 'kehikot.target')]
  const guidance = new Map(ids.map((id) => [id, `${id} `.repeat(Math.floor(LIMITS.GUIDANCE / (id.length + 1)))]))
  return { placements, guidance, ids }
}

function aFrame() {
  const posted: unknown[] = []
  const contentWindow = { postMessage: (message: unknown) => posted.push(message) } as unknown as Window
  const watcher: ConversationWatcher = {
    ready: () => {},
    silent: () => {},
    fault: () => {},
    height: () => {},
    filters: () => {},
    clearable: () => {},
    refreshable: () => {},
    header: () => {},
  }
  const conversation = new Conversation({ contentWindow }, 'kehikot.target', null, async () => ({ ok: true, data: null }), watcher, {
    name: 'Target',
    readyTimeoutMs: 10_000,
  })
  return { conversation, posted }
}

describe('the prompt a crowded kehikko composes', () => {
  test('stays within the limit, keeps what the person wrote, and names the notes left out', () => {
    const { placements, guidance, ids } = crowded()
    const prompt = promptFor(placements, 'kehikot.target', guidance)!
    expect(prompt.length).toBeLessThanOrEqual(LIMITS.PROMPT)
    expect(prompt).toContain('## from kehikot.writer\n\nKeep the slides in step with chapter 3.')
    expect(prompt).toContain('## kehikot.m0 is on this kehikko')
    expect(prompt).toContain('## Also on this kehikko')
    const left = ids.filter((id) => !prompt.includes(`## ${id} is on this kehikko`))
    expect(left.length).toBeGreaterThan(0)
    expect(prompt).toContain(`${left.join(', ')}: their notes did not fit`)
  })

  test('a kehikko that fits is composed exactly as before', () => {
    const placements = [container('kehikot.a', 0), container('kehikot.b', 10, 'do this', 'kehikot.target')]
    expect(promptFor(placements, 'kehikot.target', new Map([['kehikot.a', 'note']]))).toBe('## kehikot.a is on this kehikko\n\nnote\n\n## from kehikot.b\n\ndo this')
  })
})

describe('a context over the limits is cut to fit', () => {
  const over = () => ({ ...toWireContext({ epic: 'thesis', project: null }, 'dark'), prompt: 'x'.repeat(LIMITS.PROMPT + 282) })

  test('as it was, no page of any version can read it — which is the bug', () => {
    for (const [, schema] of SCHEMAS) {
      expect(schema.safeParse({ type: MESSAGE.HELLO, protocol: 2, session: 's', context: over(), state: null }).success).toBe(false)
    }
  })

  test('only the fields over a limit are cut, and they are named', () => {
    const { context, cut } = fitContext(over())
    expect(cut).toEqual(['prompt'])
    expect(context.prompt!.length).toBe(LIMITS.PROMPT)
    expect(context.epic).toBe('thesis')
    expect(fitContext(context).cut).toEqual([])
  })

  test('a context within the limits is passed through untouched', () => {
    const context = toWireContext({ epic: 'thesis', project: null }, 'dark')
    expect(fitContext(context).context).toBe(context)
  })
})

describe('the greeting and every context after it parse under each supported protocol', () => {
  const crowdedContext = () => {
    const { placements, guidance } = crowded()
    /* What the canvas composed before it was bounded, so the greeting itself has to keep to the limit. */
    const unbounded = [...guidance.entries()].map(([id, note]) => `## ${id} is on this kehikko\n\n${note.trim()}`).join('\n\n')
    expect(unbounded.length).toBeGreaterThan(LIMITS.PROMPT)
    expect(promptFor(placements, 'kehikot.target', guidance)!.length).toBeLessThanOrEqual(LIMITS.PROMPT)
    return { ...toWireContext({ epic: 'thesis', project: null }, 'dark'), prompt: unbounded }
  }

  for (const [version, schema] of SCHEMAS) {
    test(`a ${version} page reads the greeting`, () => {
      const at = aFrame()
      at.conversation.greet(crowdedContext(), null, ['context.get'])
      const hello = at.posted.find((m) => (m as { type?: string }).type === MESSAGE.HELLO)
      const read = schema.safeParse(hello)
      expect(read.success ? 'read' : JSON.stringify(read.error.issues)).toBe('read')
      at.conversation.close()
    })

    test(`a ${version} page reads a context sent after it`, () => {
      const at = aFrame()
      at.conversation.greet(toWireContext({ epic: null, project: null }, 'dark'))
      at.conversation.sendContext(crowdedContext())
      const context = at.posted.find((m) => (m as { type?: string }).type === MESSAGE.CONTEXT)
      const read = schema.safeParse(context)
      expect(read.success ? 'read' : JSON.stringify(read.error.issues)).toBe('read')
      at.conversation.close()
    })
  }
})
