import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { AGENT_SETUP_KEYS, agentSetupSettings, settingsValues } from 'kehikot-module-protocol'

import { ensureSettings, readSettings, writeSettings } from '../server/agentSettings.ts'
import { carriedValues, holderOf, isSetupKey, refreshChoice, WRITES_FOR, type SetupDeps } from '../server/agentSetup.ts'
import { active, automatic, carriedChoice, DEFAULT_SETTINGS, type AgentSettings } from '../src/host/agentSettings.ts'

/*
 * The agent setup choice moved to the agent module that provides `agent.setup` (protocol 2.91.0):
 * the host reads it into its stored copy, carries an earlier choice over once, and relays the
 * exceptions a module's Tools and Skills windows make. A fake module door stands in for the module.
 */

const DESCRIPTOR = { name: 'Agent', program: 'Agent CLI', cli: WRITES_FOR }
const FIELDS = agentSetupSettings('Agent CLI')

/**
 * A fake agent module: its settings door, which carries the host's earlier choice over on its first
 * read (as the Claude module does), or says it could not (`problem`).
 */
function door(opts: { answering?: boolean; unreachable?: boolean } = {}) {
  const db = new Database(':memory:')
  ensureSettings(db)
  let values: Record<string, unknown> | null = null
  const deps: SetupDeps = {
    db,
    providers: () => (opts.answering === false ? [] : [{ module: 'kehikot.agent', name: 'Agent', descriptor: DESCRIPTOR }]),
    read: async () => {
      if (values === null) {
        if (opts.unreachable) return { ok: true, values: settingsValues(FIELDS, {}), problem: 'Kehikot did not answer.' }
        values = { ...carriedValues(db) }
      }
      return { ok: true, values: settingsValues(FIELDS, values) }
    },
  }
  return { db, deps, set: (key: string, value: unknown) => ((values ??= {})[key] = value), values: () => values }
}

const OLD: AgentSettings = {
  providers: { claudeCode: { enabled: true } },
  tools: { auto: true, except: ['kehikot.notes'] },
  skills: { auto: false, except: ['kehikot.browser'] },
  asked: true,
}

/** What the sync decides for a few modules: the same before and after the move means nothing changed. */
const decisions = (settings: AgentSettings) =>
  ['kehikot.notes', 'kehikot.browser', 'kehikot.paper'].flatMap((module) => [
    automatic(settings, 'tools', module),
    automatic(settings, 'skills', module),
  ]).concat([active(settings, 'tools'), active(settings, 'skills')])

describe('whose choice: the agent module that provides agent.setup', () => {
  test('only a descriptor that parses and names the command this host writes for', () => {
    expect(holderOf([{ module: 'kehikot.agent', name: 'Agent', descriptor: DESCRIPTOR }])).toEqual({ module: 'kehikot.agent', name: 'Agent', program: 'Agent CLI' })
    expect(holderOf([{ module: 'kehikot.other', name: 'Other', descriptor: { ...DESCRIPTOR, cli: 'other' } }])).toBeNull()
    expect(holderOf([{ module: 'kehikot.bad', name: 'Bad', descriptor: { name: 'x' } }])).toBeNull()
    expect(holderOf([])).toBeNull()
    expect(isSetupKey(AGENT_SETUP_KEYS.toolsExcept)).toBe(true)
    expect(isSetupKey('resumeCutOff')).toBe(false)
  })
})

describe('carrying the earlier choice over', () => {
  test('the module takes the host’s earlier choice once, and the sync decides the same', async () => {
    const at = door()
    writeSettings(at.db, OLD)
    const before = decisions(readSettings(at.db))
    expect(carriedValues(at.db)).toEqual({
      [AGENT_SETUP_KEYS.tools]: true,
      [AGENT_SETUP_KEYS.toolsExcept]: ['kehikot.notes'],
      [AGENT_SETUP_KEYS.skills]: false,
      [AGENT_SETUP_KEYS.skillsExcept]: ['kehikot.browser'],
    })
    expect(await refreshChoice(at.deps)).toBe('read')
    expect(decisions(readSettings(at.db))).toEqual(before)
    /* After that the module's own setting is what is read. */
    at.set(AGENT_SETUP_KEYS.skills, true)
    expect(await refreshChoice(at.deps)).toBe('read')
    expect(readSettings(at.db).skills).toEqual({ auto: true, except: ['kehikot.browser'] })
  })

  test('an unanswered question, or the agent switched off, carries over as off: nothing changes', async () => {
    expect(carriedChoice(DEFAULT_SETTINGS)).toEqual({ tools: { auto: false, except: [] }, skills: { auto: false, except: [] } })
    expect(carriedChoice({ ...OLD, providers: { claudeCode: { enabled: false } } }).tools.auto).toBe(false)
    const at = door()
    const before = decisions(readSettings(at.db))
    await refreshChoice(at.deps)
    expect(decisions(readSettings(at.db))).toEqual(before)
  })

  test('with no holder answering, or one that could not carry it over, the stored choice stands', async () => {
    const asleep = door({ answering: false })
    writeSettings(asleep.db, OLD)
    expect(await refreshChoice(asleep.deps)).toBe('kept')
    expect(readSettings(asleep.db)).toEqual(OLD)
    const cut = door({ unreachable: true })
    writeSettings(cut.db, OLD)
    expect(await refreshChoice(cut.deps)).toBe('kept')
    expect(readSettings(cut.db)).toEqual(OLD)
  })
})
