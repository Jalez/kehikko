import { describe, expect, test } from 'bun:test'

import { firstUndone, isDone, NO_FACTS, TOUR_STEPS, type Facts } from '../src/host/tour.ts'

/* The stops a person is walked through, in order: the steps from the first not
   done, each by the title of the frame that points at the control itself. */
function walk(facts: Facts): Array<[string, string]> {
  const from = firstUndone(facts, 0)
  return TOUR_STEPS.slice(from).flatMap((step): Array<[string, string]> => (isDone(step, facts) ? [] : [[step.id, step.frames.at(-1)!.title]]))
}

describe('the tour’s steps', () => {
  test('a new user sets up first, then has the whole top bar explained', () => {
    expect(walk(NO_FACTS)).toEqual([
      ['project', 'Pick a project to start'],
      ['epic', 'Create your first epic'],
      ['parts', 'Divide it into parts — if you like'],
      ['kehikko', 'Your kehikot live here'],
      ['project-bar', 'Your projects'],
      ['epic-bar', 'The epic'],
      ['parts-bar', 'Its parts'],
      ['kehikko-bar', 'Your kehikot'],
      ['pinned', 'Pinned places'],
      ['modules', 'Kehikko modules'],
      ['header', 'A container’s header'],
      ['scope', 'What it belongs to'],
      ['frame', 'The Frame menu'],
      ['menus', 'The module’s own menus'],
      ['corners', 'Resize from any corner'],
      ['inbox', 'The Inbox'],
      ['focus', 'Container headers'],
      ['updates', 'Updates'],
      ['settings', 'Settings'],
      ['theme', 'Light or dark'],
      ['help', 'Help is here'],
    ])
  })

  test('an existing user with a project, an epic and a kehikko gets the explanations, never the setup', () => {
    const steps = walk({ project: true, projects: 10, epic: true, parts: false, kehikko: true })
    expect(steps.map(([id]) => id)).toEqual([
      'project-bar',
      'epic-bar',
      'parts-bar',
      'kehikko-bar',
      'pinned',
      'modules',
      'header',
      'scope',
      'frame',
      'menus',
      'corners',
      'inbox',
      'focus',
      'updates',
      'settings',
      'theme',
      'help',
    ])
    expect(steps.map(([, title]) => title).join('|')).not.toContain('first')
  })

  test('someone with a project and an epic but no kehikko still sets that up before the bar', () => {
    expect(walk({ project: true, projects: 1, epic: true, parts: false, kehikko: false }).slice(0, 3).map(([id]) => id)).toEqual(['parts', 'kehikko', 'project-bar'])
  })

  test('every explanation is one or two short sentences', () => {
    for (const step of TOUR_STEPS.filter((one) => one.kind === 'show')) {
      for (const frame of step.frames) {
        const body = typeof frame.body === 'function' ? frame.body(NO_FACTS) : frame.body
        expect(body.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(3)
        expect(body.length).toBeLessThan(260)
      }
    }
  })
})
