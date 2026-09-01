import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'

import { listEpics, retitleEpic, withTitle } from '../server/holdings.ts'

/*
 * Changing what an epic is CALLED, without changing what it IS.
 *
 * Tested against real directories rather than a mocked filesystem, for the
 * reason `sharing.test.ts` gives about the `.gitignore` and with one more on
 * top of it: the whole of what this does is write a file somebody else wrote by
 * hand, and the property that matters most — that every byte it did not mean to
 * touch is where it was — cannot be observed through a fake `writeFileSync`. It
 * is observed by reading the file back and comparing it to the string it went
 * in as.
 */

const root = mkdtempSync(join(tmpdir(), 'kehikko-retitle-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let made = 0

/** A project folder with `data/epics` in it, and one epic written verbatim. */
function project(files: Record<string, string> = {}): string {
  const dir = join(root, `p${(made += 1)}`)
  mkdirSync(join(dir, 'data', 'epics'), { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'data', 'epics', name), text)
  return dir
}

function epicFile(dir: string, slug: string): string {
  return readFileSync(join(dir, 'data', 'epics', `${slug}.json`), 'utf8')
}

/*
 * A real epic's shape, in the roadmap's own formatting: two spaces, a trailing
 * newline, and — the part that matters — a nested `"title"` on every step. A
 * naive rewrite that looked for the first `"title": "…"` in the text would
 * rename a step in files like this one and the epic in files without steps,
 * depending on nothing anybody can see.
 */
const WRITTEN = `{
  "slug": "page-is-components",
  "title": "Every surface of the page is a component you can run",
  "lede": "Seven thousand lines of hand-written rendering, and a \\"template literal\\" the compiler never looks inside",
  "project": "Workbench",
  "steps": [
    {
      "title": "The one path that writes in public has a gate on it",
      "body": "A brace } and a bracket ] inside prose, which the walk has to step over."
    }
  ],
  "open": [
    "gh#41"
  ],
  "branches": null
}
`

describe('retitling an epic', () => {
  test('changes the title and leaves every other byte where it was', () => {
    const dir = project({ 'page-is-components.json': WRITTEN })
    const said = retitleEpic(dir, 'page-is-components', 'The page is components')
    expect(said.ok).toBe(true)

    const after = epicFile(dir, 'page-is-components')
    /* The whole assertion, spelled as a substitution rather than as a snapshot:
       what came out is what went in, with one span replaced. */
    expect(after).toBe(
      WRITTEN.replace(
        '"Every surface of the page is a component you can run"',
        '"The page is components"',
      ),
    )
    /* And the step is still called what its author called it. */
    expect(after).toContain('"title": "The one path that writes in public has a gate on it"')
  })

  test('the answer is the epic as a picker reads it, with its title already new', () => {
    const dir = project({ 'page-is-components.json': WRITTEN })
    const said = retitleEpic(dir, 'page-is-components', 'The page is components')
    if (!said.ok) throw new Error(said.why)
    expect(said.epic).toEqual({
      slug: 'page-is-components',
      title: 'The page is components',
      project: 'Workbench',
      lede: 'Seven thousand lines of hand-written rendering, and a "template literal" the compiler never looks inside',
      size: 2,
    })
    /* And the list agrees, which is what the header will draw. */
    expect(listEpics(dir)[0]?.title).toBe('The page is components')
  })

  test('a title with quotes and newlines in the value is escaped, not spliced raw', () => {
    const dir = project({ 'page-is-components.json': WRITTEN })
    const said = retitleEpic(dir, 'page-is-components', 'A "component" you can run')
    expect(said.ok).toBe(true)
    expect(epicFile(dir, 'page-is-components')).toContain('"title": "A \\"component\\" you can run"')
    /* Still one JSON document afterwards, which is the point of escaping. */
    expect(listEpics(dir)[0]?.title).toBe('A "component" you can run')
  })

  test('somebody else’s formatting survives — four spaces, no trailing newline, keys out of order', () => {
    const odd = `{\n    "title":   "Old",\n    "slug": "odd",\n    "lede": "kept"\n}`
    const dir = project({ 'odd.json': odd })
    expect(retitleEpic(dir, 'odd', 'New').ok).toBe(true)
    /* Not reformatted, not re-indented, and not given a trailing newline it did
       not have. One field changed; the rest is the author's. */
    expect(epicFile(dir, 'odd')).toBe(`{\n    "title":   "New",\n    "slug": "odd",\n    "lede": "kept"\n}`)
  })

  test('an epic with no title at all is given one, at the file’s own indentation', () => {
    const dir = project({ 'bare.json': '{\n  "slug": "bare",\n  "lede": "kept"\n}\n' })
    expect(retitleEpic(dir, 'bare', 'Now it has one').ok).toBe(true)
    expect(epicFile(dir, 'bare')).toBe(
      '{\n  "title": "Now it has one",\n  "slug": "bare",\n  "lede": "kept"\n}\n',
    )
  })

  test('a title that is already the title writes nothing at all', async () => {
    const dir = project({ 'page-is-components.json': WRITTEN })
    const path = join(dir, 'data', 'epics', 'page-is-components.json')
    const before = statSync(path).mtimeMs
    /* A moment, so that a write would have a different timestamp to show for
       itself. Pressing a control that is already where you pressed it must not
       put a modified file in somebody's `git status` — the same rule
       `shareKehikot` holds to about the `.gitignore`. */
    await new Promise((resume) => setTimeout(resume, 10))

    const said = retitleEpic(dir, 'page-is-components', '  Every surface of the page is a component you can run  ')
    expect(said.ok).toBe(true)
    expect(statSync(path).mtimeMs).toBe(before)
    expect(epicFile(dir, 'page-is-components')).toBe(WRITTEN)
  })
})

describe('what a retitle refuses', () => {
  /** Every refusal must leave the file alone, so they are all checked the same way. */
  function refused(dir: string, slug: string, title: string, status: number): string {
    const before = epicFile(dir, slug)
    const said = retitleEpic(dir, slug, title)
    expect(said.ok).toBe(false)
    if (said.ok) throw new Error('it was not refused')
    expect(said.status).toBe(status)
    /* A sentence rather than a code: this is shown to a person who has just
       pressed save and is owed the reason. */
    expect(said.why.length).toBeGreaterThan(20)
    expect(epicFile(dir, slug)).toBe(before)
    return said.why
  }

  test('an empty title, because an epic has to be called something', () => {
    const dir = project({ 'page-is-components.json': WRITTEN })
    refused(dir, 'page-is-components', '   ', 400)
  })

  test('a title longer than the ceiling, and the sentence says how long it was', () => {
    const dir = project({ 'page-is-components.json': WRITTEN })
    const why = refused(dir, 'page-is-components', 'x'.repeat(201), 400)
    expect(why).toContain('201')
  })

  test('a title with a line break in it, because a title is one line', () => {
    const dir = project({ 'page-is-components.json': WRITTEN })
    refused(dir, 'page-is-components', 'two\nlines', 400)
  })

  test('a slug that is not one, before anything is joined onto a path', () => {
    const dir = project({ 'page-is-components.json': WRITTEN })
    const said = retitleEpic(dir, '../../../etc/passwd', 'anything')
    expect(said.ok).toBe(false)
    if (!said.ok) expect(said.status).toBe(400)
  })

  test('an epic that is not in this project', () => {
    const dir = project({ 'page-is-components.json': WRITTEN })
    const said = retitleEpic(dir, 'somebody-elses-epic', 'anything')
    expect(said.ok).toBe(false)
    if (!said.ok) {
      expect(said.status).toBe(404)
      expect(said.why).toContain('somebody-elses-epic')
    }
  })

  test('a project with no data/epics, which is not a fault and is still a refusal', () => {
    const dir = join(root, 'thesis')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'main.tex'), '\\begin{document}\\end{document}')
    const said = retitleEpic(dir, 'anything', 'A title')
    expect(said.ok).toBe(false)
    if (!said.ok) {
      expect(said.status).toBe(409)
      expect(said.why).toContain('data/epics')
    }
  })

  test('a file that cannot be read as JSON is not overwritten with one that can', () => {
    const dir = project({ 'broken.json': '{ "slug": "broken", "title": "Half a f' })
    refused(dir, 'broken', 'A whole file', 409)
  })
})

/*
 * The splice itself, at the level where the offsets are.
 *
 * `retitleEpic` above is the behaviour; these are the two shapes that make the
 * walk necessary and one that it is right to refuse.
 */
describe('finding the outermost title', () => {
  test('a nested title in a deeply awkward document is not the one that moves', () => {
    const raw = '{"a":{"title":"inner"},"b":["{\\"title\\": \\"in a string\\"}"],"title":"outer"}'
    expect(withTitle(raw, 'moved')).toBe(
      '{"a":{"title":"inner"},"b":["{\\"title\\": \\"in a string\\"}"],"title":"moved"}',
    )
  })

  test('numbers, booleans and nulls beside it are stepped over rather than parsed', () => {
    const raw = '{"size":12,"live":true,"branches":null,"title":"here"}'
    expect(withTitle(raw, 'there')).toBe('{"size":12,"live":true,"branches":null,"title":"there"}')
  })

  test('anything that is not an object of named members is refused rather than guessed at', () => {
    /* The caller turns `null` into a sentence and leaves the file alone. It
       cannot be reached through `retitleEpic` — `parse` has already refused an
       array — and it is the answer this function owes anyway, because a
       function that returns text is a function whose text gets written. */
    expect(withTitle('[1, 2, 3]', 'x')).toBe(null)
    expect(withTitle('{}', 'x')).toBe(null)
  })
})
