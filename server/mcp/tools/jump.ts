import { doorSpace, epicPartsOf, findSpace, LIMITS, spaceWords as placeSpaceWords } from 'kehikot-module-protocol'
import { createHash } from 'node:crypto'

import { JUMP_SIGNED, paceRefusal, toldWords } from '../../../src/host/jump.ts'
import { listCanvases, readSubject, type Canvas } from '../../canvases.ts'
import { belongsWords } from '../../doorPlaces.ts'
import { epicsIn, listEpics, readParts, readStepsAnswer } from '../../holdings.ts'
import { mutedIn } from '../../messageMutes.ts'
import { listProjects, type Project } from '../../projects.ts'
import { spaceTree } from '../../spaces.ts'
import type { Door } from '../door.ts'
import { doorTool } from '../tool.ts'
import { listWords, missingSaid, same, spacesText, trimmedPath } from '../words.ts'

export const jump = doorTool({
  name: 'jump',
  schema: {
    description:
      'Jump the person’s view: to another project, kehikko, space (at any depth), or a step — any of these, and '
      + 'what you leave out stays where the person is. Use it when the person asks to be taken somewhere ("take me '
      + 'to the auth space", "show me Login", "open the Wide kehikko in project X"), or step by step during a '
      + 'walkthrough the person started; never on your own initiative otherwise — to show the person something '
      + 'they did not ask to see, use offer_jump, which lets them decide. It goes as the person’s own pickers go '
      + '(another project with the same calm switch), on the page on screen; with no Kehikot page open nothing '
      + 'moves. A step walks every container on the kehikko to it (kehikot.goto): every container that follows a '
      + 'walk shows the step and says so, and the answer names them. Name the space with space: its path of ids or '
      + 'one id. epic and parts are older names, still accepted (the top-level space / its direct sub-spaces). '
      + 'Names are resolved strictly: an unknown project, kehikko, space or step is refused with the ones that '
      + 'exist (read_canvas and my_place list what is here). The page marks the jump on the kehikko ("Jumped here '
      + 'by an agent") with Go back, which restores exactly where the person was — project, kehikko, space and '
      + 'step; tell the person where you took them and that Go back undoes it. A jump to where the person already '
      + 'is is ignored, and jumps are at least a few seconds apart. This conversation’s own place (my_place) does '
      + 'not follow the jump; call set_my_place if it should. Changes no data and no arrangement.',
    annotations: {
      title: 'Jump the view',
      /* It changes what the person sees, never any material. */
      readOnlyHint: false,
      destructiveHint: false,
      /* The same jump twice is one: the second finds the person there and is ignored. */
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'A project this host holds: its name, its folder or its id, as my_place and read_canvas print them. Left out: the project on screen.',
        },
        kehikko: {
          type: 'string',
          description: 'A kehikko of that project: its name or key, as read_canvas prints them. Left out: the one open there.',
        },
        space: {
          type: ['array', 'string'],
          items: { type: 'string' },
          description: 'A space at any depth: its path of ids from the top (["auth", "login", "errors"] or "auth/login/errors"), or one id when it names one space, as read_canvas prints them. Wins over the older epic and parts.',
        },
        epic: {
          type: 'string',
          description: 'Older name, still accepted: a top-level space of that project, by id (or its exact title). Use space instead. Left out: the space open there.',
        },
        parts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Older name, still accepted: direct sub-spaces of the top-level space to pick, by id or name; [] picks none (the whole space). Use space instead. Left out: the ones picked there now, or none in another space.',
        },
        step: {
          type: 'integer',
          minimum: 1,
          description: 'A step of that top-level space, by its 1-based number as the journey numbers it. Left out: no step is walked to.',
        },
      },
      required: [],
    },
  },
  /* The page on screen, wherever it is: it names no kehikko of its own. */
  run: ({ door }, args) => jumpOn(args, door),
})

export const offerJump = doorTool({
  name: 'offer_jump',
  schema: {
    description:
      'Offer to take the person somewhere in Kehikot — another project, kehikko, space (at any depth), or a step '
      + '— without moving their view. Use it when you want to show the person something they did not ask to see '
      + '("the failing test is in the space Auth › Login"); use jump only when they ask to be taken somewhere, or '
      + 'step by step during a walkthrough they started. It files ONE item in the person’s Inbox from this '
      + 'session: by your agent module’s name, saying `why`, with a "Take me there" button. The person decides: '
      + 'pressing it goes there as jump would, with Go back, and closes the offer; they can also dismiss it. One '
      + 'open offer per session: a new one replaces your last. The target arguments are jump’s (space first; epic '
      + 'and parts are older names, still accepted), resolved as strictly (unknown names are refused with the ones '
      + 'that exist); what you leave out stays where the person is when they take it, and a project left out is '
      + 'this conversation’s (my_place). Needs a session an agent module started; refused while the person turned '
      + 'off that module’s inbox or muted its messages. Nothing moves, and no data or arrangement changes.',
    annotations: {
      title: 'Offer to take the person somewhere',
      /* It files an item in the person's Inbox; it never moves the view. */
      readOnlyHint: false,
      destructiveHint: false,
      /* The same offer twice is one: the second replaces the first. */
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        why: {
          type: 'string',
          description: `What you want to show the person, and why, in one sentence — the Inbox item's words (plain text; past ${LIMITS.ACTIVITY_LABEL} characters it is clipped). E.g. "The failing test is in the space Auth › Login."`,
        },
        project: {
          type: 'string',
          description: 'A project this host holds: its name, its folder or its id, as my_place and read_canvas print them. Left out: this conversation’s project.',
        },
        kehikko: {
          type: 'string',
          description: 'A kehikko of that project: its name or key, as read_canvas prints them. Left out: the one the person has open when they take it.',
        },
        space: {
          type: ['array', 'string'],
          items: { type: 'string' },
          description: 'A space at any depth: its path of ids from the top (["auth", "login", "errors"] or "auth/login/errors"), or one id when it names one space, as read_canvas prints them. Wins over the older epic and parts.',
        },
        epic: {
          type: 'string',
          description: 'Older name, still accepted: a top-level space of that project, by id (or its exact title). Use space instead. Left out: the space the person has open when they take it.',
        },
        parts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Older name, still accepted: direct sub-spaces of the top-level space to pick, by id or name; [] picks none (the whole space). Use space instead. Left out: the ones picked when they take it.',
        },
        step: {
          type: 'number',
          description: 'A step of that top-level space, by its 1-based number as the journey numbers it. Left out: no step is walked to.',
        },
      },
      required: ['why'],
    },
  },
  run: ({ door }, args) => offerJumpOn(args, door),
})

/**
 * Where a target goes, in the words an answer says it: `space auth › login`, `space auth (sub-spaces a + b)`,
 * `space auth (the whole space, no sub-spaces picked)`, or the sub-spaces of the space open there. Null when
 * the call named no space, epic or parts.
 */
function targetSpaceWords(askedEpic: string | undefined, epic: string | null, parts: string[] | undefined, space: string[] | undefined): string | null {
  if (askedEpic !== undefined && epic !== null) {
    const words = placeSpaceWords({ epic, parts: parts ?? [], space: space ?? null })
    return parts !== undefined && parts.length === 0 && !space ? `${words} (the whole space, no sub-spaces picked)` : words
  }
  if (parts === undefined) return null
  return parts.length ? `sub-space${parts.length === 1 ? '' : 's'} ${parts.join(', ')}` : 'the whole space (no sub-spaces picked)'
}

/** A place an agent named, resolved strictly against this host: what `jump` sends and `offer_jump` files. */
interface Target {
  ok: true
  project: Project
  /** Another project than the base it was resolved from. */
  away: boolean
  askedProject: boolean
  kehikko: Canvas | undefined
  /** The epic named, resolved; undefined when none was named (the epic open there stays). */
  askedEpic: string | undefined
  epic: string | null
  parts: string[] | undefined
  step: number | null
  title: string | undefined
  /** The epic's steps are kept where this host cannot read them, so the step was not checked. */
  unchecked: boolean
  /** The space to stand in, by its path of ids, when the call named one deeper than epic and parts say (2.89.0). */
  space?: string[]
}

/**
 * The target arguments `jump` and `offer_jump` share — project, kehikko, epic, parts, step — read and
 * resolved strictly: an id, the folder, or the exact name, never a prefix or a guess; an unknown one is
 * refused with what exists. `base` is the project a call that names none means (the one on screen for
 * `jump`). `verb` names the tool in a refusal.
 */
function resolveTarget(
  args: Record<string, unknown>,
  door: Door,
  base: (projects: Project[]) => Project | { why: string },
  verb: string,
  refuse: (text: string) => { ok: false; text: string; failed: true },
): Target | { ok: false; text: string; failed: true } {
  const asked = targetArgsOf(args, verb)
  if ('why' in asked) return refuse(asked.why)
  const { askedProject, askedKehikko, askedEpic, askedSpace, askedParts, step } = asked

  const projects = listProjects(door.db)
  const here = base(projects)
  if ('why' in here) return refuse(here.why)
  const project = askedProject === undefined ? here : projectNamed(projects, askedProject)
  if ('why' in project) return refuse(project.why)
  const away = project.id !== here.id
  let kehikko: Canvas | undefined
  if (askedKehikko !== undefined) {
    const found = kehikkoNamed(listCanvases(door.db).filter((c) => c.project === project.id && c.key), project, askedKehikko)
    if ('why' in found) return refuse(found.why)
    kehikko = found
  }

  const subject = readSubject(door.db, project.id)
  const dir = epicsIn(project.path)
  const epics = dir ? listEpics(dir) : []
  let epic: string | null = subject?.scope === 'project' ? null : (subject?.epic ?? null)
  /* A space at any depth (2.89.0): it names the epic and the parts too, and wins over them. */
  let deep: string[] | undefined
  let spaceParts: string[] | undefined
  if (askedSpace) {
    const found = findSpace(spaceTree(project.path), askedSpace)
    if (!found.ok) return refuse(`${found.why} The spaces of ${project.name}:\n${spacesText(spaceTree(project.path))}`)
    const ids = found.path.map((one) => one.id)
    epic = ids[0]!
    spaceParts = epicPartsOf(ids).parts
    if (ids.length > 2) deep = ids
  }
  if (askedEpic !== undefined && !askedSpace) {
    const found = epicNamed(epics, project, askedEpic)
    if (typeof found !== 'string') return refuse(found.why)
    epic = found
  }
  if ((askedParts !== undefined || step != null) && epic === null) {
    return refuse(
      `${project.name} has ${subject?.scope === 'project' ? 'all spaces' : 'no space'} open, and sub-spaces and steps are a top-level space’s: name the space too. Its top-level spaces: ${listWords(epics.map((one) => one.slug))}.`,
    )
  }

  let parts: string[] | undefined
  if (askedParts !== undefined && epic !== null) {
    const found = partsNamed((dir ? readParts(dir, epic) : null) ?? [], epic, askedParts)
    if ('why' in found) return refuse(found.why)
    parts = found
  }

  let title: string | undefined
  let unchecked = false
  if (step != null && epic !== null) {
    const said = dir ? readStepsAnswer(dir, epic) : null
    const steps = said && Array.isArray(said.steps) ? (said.steps as { title?: unknown }[]) : null
    const found = stepNamed(steps, epic, step)
    if ('why' in found) return refuse(found.why)
    ;({ title, unchecked } = found)
  }

  return {
    ok: true,
    project,
    away,
    askedProject: askedProject !== undefined,
    kehikko,
    askedEpic: askedEpic === undefined && !askedSpace ? undefined : (epic ?? undefined),
    epic,
    parts: spaceParts ?? parts,
    step,
    title,
    unchecked,
    ...(deep ? { space: deep } : {}),
  }
}

/** The target arguments as given, each read and bounded; undefined for one left out. */
interface TargetArgs {
  askedProject: string | undefined
  askedKehikko: string | undefined
  askedEpic: string | undefined
  askedSpace: ReturnType<typeof doorSpace>
  askedParts: string[] | undefined
  step: number | null
}

/** One named target, trimmed: undefined when left out, null when it is not a name. */
function nameOf(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 512) return null
  return value.trim()
}

/** The target arguments `jump` and `offer_jump` share, read and bounded before anything is looked up; or why not. */
export function targetArgsOf(args: Record<string, unknown>, verb: string): TargetArgs | { why: string } {
  const askedProject = nameOf(args.project)
  const askedKehikko = nameOf(args.kehikko)
  const askedEpic = nameOf(args.epic)
  if (askedProject === null) return { why: 'project, when given, is a project’s name, folder or id, as my_place prints it.' }
  if (askedKehikko === null) return { why: 'kehikko, when given, is a kehikko’s name or key, as read_canvas prints it.' }
  if (askedEpic === null) return { why: 'epic (older name of a top-level space), when given, is a top-level space’s id, e.g. "share-links". space takes a space at any depth.' }
  const askedSpace = doorSpace(args)
  if (args.space !== undefined && args.space !== null && !askedSpace) return { why: 'space, when given, is a path of space ids (["auth", "login"] or "auth/login") or one id, as read_canvas prints them.' }
  let askedParts: string[] | undefined
  if (args.parts !== undefined && args.parts !== null) {
    if (!Array.isArray(args.parts) || args.parts.length > 64 || !args.parts.every((one) => typeof one === 'string' && one.trim() && one.length <= 200)) {
      return { why: 'parts (older name of direct sub-spaces), when given, is a list of ids or names of the top-level space’s direct sub-spaces, e.g. ["auth"]; [] picks none. space takes a space at any depth.' }
    }
    askedParts = [...new Set((args.parts as string[]).map((one) => one.trim()))]
  }
  const step = args.step
  if (step !== undefined && step !== null && (typeof step !== 'number' || !Number.isInteger(step) || step < 1 || step > 999)) {
    return { why: 'step, when given, is the step’s 1-based number in the top-level space’s steps, a whole number from 1, e.g. step: 7.' }
  }
  if (askedProject === undefined && askedKehikko === undefined && askedEpic === undefined && askedParts === undefined && step == null && !askedSpace) {
    return { why: `${verb} needs somewhere to go: a project, kehikko, space or step — any of them, and what is left out stays.` }
  }
  return { askedProject, askedKehikko, askedEpic, askedSpace, askedParts, step: step == null ? null : (step as number) }
}

/** The one of `many` an exact name picks, case aside — none when two share it. */
function onlyNamed<T>(many: readonly T[], named: (one: T) => boolean): T | undefined {
  const all = many.filter(named)
  return all.length === 1 ? all[0] : undefined
}

/** Each name, strictly: a project's id, its folder, or its exact name — never a prefix or a guess. */
export function projectNamed(projects: readonly Project[], asked: string): Project | { why: string } {
  const found =
    projects.find((one) => one.uid === asked)
    ?? projects.find((one) => trimmedPath(one.path) === trimmedPath(asked))
    ?? onlyNamed(projects, (one) => same(one.name, asked))
  if (!found) {
    const two = projects.filter((one) => same(one.name, asked)).length > 1
    return {
      why: `${two ? `More than one project is called ${asked}; name it by its folder.` : `This host has no project ${asked}.`} Its projects: ${listWords(
        projects.map((one) => `${one.name} (${one.path})`),
      )}.`,
    }
  }
  if (found.missing) return { why: missingSaid(found) }
  return found
}

/** A kehikko of the project by its key, id or exact name. */
export function kehikkoNamed(kehikot: readonly Canvas[], project: Pick<Project, 'name'>, asked: string): Canvas | { why: string } {
  const found = kehikot.find((c) => c.key === asked) ?? kehikot.find((c) => String(c.id) === asked) ?? onlyNamed(kehikot, (c) => same(c.name, asked))
  return found ?? { why: `${project.name} has no kehikko ${asked}. Its kehikot: ${listWords(kehikot.map((c) => `${c.name} (key ${c.key})`))}.` }
}

/** A top-level space by its slug or exact title, as its slug. */
export function epicNamed(epics: readonly { slug: string; title?: string | null }[], project: Pick<Project, 'name'>, asked: string): string | { why: string } {
  const found = epics.find((one) => one.slug === asked) ?? onlyNamed(epics, (one) => !!one.title && same(one.title, asked))
  if (found) return found.slug
  return { why: `${project.name} has no top-level space ${asked}. Its top-level spaces: ${listWords(epics.map((one) => (one.title ? `${one.slug} (${one.title})` : one.slug)))}.` }
}

/** Direct sub-spaces of `epic` by id or heading, as ids; every one has to be there. */
export function partsNamed(held: readonly { id: string; heading?: string | null }[], epic: string, asked: readonly string[]): string[] | { why: string } {
  const parts: string[] = []
  const unknown: string[] = []
  for (const one of asked) {
    const found = held.find((part) => part.id === one) ?? held.find((part) => part.heading && same(part.heading, one))
    if (found) parts.push(found.id)
    else unknown.push(one)
  }
  if (unknown.length) {
    return { why: `${epic} has no sub-space ${unknown.join(', ')}. Its direct sub-spaces: ${listWords(held.map((part) => (part.heading ? `${part.heading} (${part.id})` : part.id)))}.` }
  }
  return parts
}

/**
 * A step of `epic` by its 1-based number, with its title. `steps` null is steps kept where this host
 * cannot read them — a paper's sections: walked anyway, and the containers say (`unchecked`).
 */
export function stepNamed(steps: readonly { title?: unknown }[] | null, epic: string, step: number): { title: string | undefined; unchecked: boolean } | { why: string } {
  if (!steps) return { title: undefined, unchecked: true }
  if (!steps.length) return { why: `Nobody has written steps for ${epic} yet, so there is no step ${step}.` }
  if (step > steps.length) {
    const listed = steps.map((one, i) => `${i + 1} ${typeof one.title === 'string' ? one.title : ''}`.trim())
    return { why: `${epic} has ${steps.length} step${steps.length === 1 ? '' : 's'}, so there is no step ${step}. Its steps: ${listWords(listed)}.` }
  }
  const found = steps[step - 1]?.title
  return { title: typeof found === 'string' && found.trim() ? found.trim().slice(0, LIMITS.TITLE) : undefined, unchecked: false }
}

/**
 * `jump`: the person's view moved where an agent asked — another project,
 * kehikko, epic, parts, a step, or any of them — and marked as the agent's
 * doing with one press back (#208, widened by the person to another epic,
 * part, project or kehikko).
 *
 * The server resolves every name strictly and refuses an unknown one with
 * what exists, then hands the page on screen ids it can check again. The page
 * goes as the person's own pickers go (`planJump` and `goPlace` in
 * `App.tsx`), marks it, and answers who followed a step. Paced here, before
 * any page hears it; a jump to where the person already is is the page's to
 * ignore. Logged in the host log, one line. The conversation's place is not
 * moved: it is what the conversation is ABOUT, and the view is where the
 * person is looking — `set_my_place` moves the first. See `src/host/jump.ts`.
 */
async function jumpOn(args: Record<string, unknown>, door: Door): Promise<{ text: string; failed: boolean }> {
  const refuse = (text: string) => ({ ok: false as const, text: `${text} Nothing moved.`, failed: true as const })
  /* The page on screen, and only it. */
  const which = door.which()
  if (!which.ok) return refuse(`${which.why} jump moves the view of the page on screen.`)
  const screen = listCanvases(door.db).find((c) => c.id === which.id)
  if (!screen || screen.project === null) return refuse('The page on screen has no kehikko in a project open.')
  const target = resolveTarget(
    args,
    door,
    (projects) => projects.find((one) => one.id === screen.project) ?? { why: 'The project on screen is not one this host holds any more.' },
    'jump',
    refuse,
  )
  if (!target.ok) return target
  const { project, away, kehikko, askedEpic, epic, parts, step, title, unchecked, space } = target
  const askedProject = target.askedProject ? project.name : undefined

  /* The paces the server keeps for every request (`paces.ts`); none handed in, none outlives this call. */
  const jumps = door.jumps ?? new Map<number, number>()
  const now = door.now ? door.now() : Date.now()
  const tooSoon = paceRefusal(jumps.get(0), now)
  if (tooSoon) return { text: tooSoon, failed: true }

  if (!door.headers?.jump) return refuse('This host does not jump the view.')
  const order = {
    ...(away ? { project: project.id } : {}),
    ...(kehikko?.key ? { kehikko: kehikko.key } : {}),
    ...(askedEpic !== undefined && epic !== null ? { epic } : {}),
    ...(parts !== undefined ? { parts } : {}),
    ...(space ? { space } : {}),
    ...(step != null ? { step: step as number } : {}),
    ...(title ? { title } : {}),
  }
  const came = await door.headers.jump(screen.id, order)
  if (!came) return refuse('The page on screen is not listening right now. If Kehikot is in front of the person, try again in a moment.')
  if (!came.ok) return { text: `Nothing moved: ${came.why}`, failed: true }
  if (came.ignored) return { text: `Ignored: ${came.why}`, failed: false }
  jumps.set(0, now)

  const where = [
    away || askedProject !== undefined ? `project ${project.name}` : null,
    kehikko ? `kehikko ${kehikko.name}` : null,
    targetSpaceWords(askedEpic, epic, parts, space),
    step != null ? `step ${step}${title ? ` (${title})` : ''}` : null,
  ].filter((one): one is string => one !== null)
  ;(door.log ?? ((line: string) => console.info(line)))(`jump: an agent jumped the view to ${where.join(', ')}`)
  const names = new Map((await door.seen()).map((one) => [one.id, one.name ?? one.id]))
  const placed = door.here ? `${belongsWords(door.here)} It did not follow the jump; set_my_place moves it if this conversation is now about where you went.` : 'This conversation has no recorded place; set_my_place records one.'
  return {
    text:
      `Jumped the view to ${where.join(', ')}.`
      + (step != null ? ` ${toldWords(came.told ?? [], (id) => names.get(id) ?? id)}` : '')
      + (unchecked ? ` ${epic}'s steps are kept where this host cannot read them, so step ${step} was not checked here; the containers said whether they have it.` : '')
      + ` The page says "${step != null && where.length === 1 ? `Moved to step ${step}` : 'Jumped here'} by ${JUMP_SIGNED}" with Go back, which restores where the person was. Tell the person where you took them and that Go back undoes it.`
      + ` ${placed}`
      + ' No data and no arrangement changed.',
    failed: false,
  }
}

/** How long `why` may be before it is refused rather than clipped: far past the label, a paste, not a sentence. */
const OFFER_WHY_MAX = 2000

/**
 * `offer_jump`: an agent's offer to take the person somewhere, filed in their Inbox instead of moving
 * the view (protocol 2.87.0, `go`). The target is resolved exactly as `jump`'s (`resolveTarget`), from
 * this conversation's project when it names none. ONE open item per session — by the session's agent
 * module's registered name, its label the agent's `why` — that the person takes with "Take me there"
 * (`inbox.open`: the page goes as the jump would, with Go back, and closes it) or dismisses. Never
 * moves the view, and is not paced: a new offer replaces the session's last. Refused while the person
 * turned that module's inbox off or muted its messages in the project. See `Inbox.offer`.
 */
async function offerJumpOn(args: Record<string, unknown>, door: Door): Promise<{ text: string; failed: boolean }> {
  const refuse = (text: string) => ({ ok: false as const, text: `${text} Nothing was offered.`, failed: true as const })
  if (!door.inbox) return refuse('This host does not hold an inbox.')
  const why = typeof args.why === 'string' ? args.why.replace(/\s+/g, ' ').trim() : ''
  if (!why) return refuse('why is what you want to show the person and why, in one sentence, e.g. "The failing test is in the space Auth › Login."')
  if (why.length > OFFER_WHY_MAX) return refuse(`why is one sentence, at most ${OFFER_WHY_MAX} characters; the Inbox shows ${LIMITS.ACTIVITY_LABEL}.`)
  const here = door.here
  const module = here && here.via === 'token' && here.module ? here.module : null
  if (!here || !module) {
    return refuse(
      'An offer is filed for the session of an agent module, and this call carries none (it came from a connection no agent module started). Tell the person where to look instead, or use jump if they asked to be taken there.',
    )
  }
  const target = resolveTarget(
    args,
    door,
    (projects) => projects.find((one) => one.id === here.project.id) ?? { why: 'This conversation’s project is not one this host holds any more.' },
    'offer_jump',
    refuse,
  )
  if (!target.ok) return target
  const { project, kehikko, askedEpic, epic, parts, step, title, unchecked, space } = target

  const name = (await door.seen()).find((one) => one.id === module)?.name ?? module
  if (door.inbox.muted().includes(module)) {
    return refuse(`The person turned off "Use inbox" for ${name}, so nothing of its shows in the Inbox. Tell them in this conversation instead.`)
  }
  if (mutedIn(door.db, project.id).includes(module)) {
    return refuse(`The person muted ${name}’s messages in ${project.name}. Tell them in this conversation instead.`)
  }

  const place = {
    ...(kehikko?.key ? { kehikko: kehikko.key } : {}),
    ...(askedEpic !== undefined && epic !== null ? { epic } : {}),
    ...(parts !== undefined ? { parts } : {}),
    ...(space ? { space } : {}),
  }
  /* One per session: the conversation the record names, else its token — hashed, so neither is shown. */
  const session = createHash('sha256').update(`${module}\u0000${here.conversation ?? here.token ?? ''}`).digest('hex').slice(0, 24)
  const filed = door.inbox.offer(project.id, module, name, session, why, Object.keys(place).length ? place : undefined, {
    ...(step !== null ? { step } : {}),
    ...(title ? { title } : {}),
  })
  door.inboxChanged?.(project.id, filed.rev)
  for (const other of filed.others) door.inboxChanged?.(other.project, other.rev)

  const where = [
    `project ${project.name}`,
    kehikko ? `kehikko ${kehikko.name}` : null,
    targetSpaceWords(askedEpic, epic, parts, space),
    step !== null ? `step ${step}${title ? ` (${title})` : ''}` : null,
  ].filter((one): one is string => one !== null)
  ;(door.log ?? ((line: string) => console.info(line)))(`offer_jump: an agent offered to take the person to ${where.join(', ')}`)
  return {
    text:
      'Offered; the person can go there from the Inbox.'
      + ` The item says "${why.length > LIMITS.ACTIVITY_LABEL ? `${why.slice(0, LIMITS.ACTIVITY_LABEL - 1)}…` : why}" by ${name}, and takes them to ${where.join(', ')}${
        step !== null && unchecked ? ` (${epic}'s steps are kept where this host cannot read them, so step ${step} was not checked here)` : ''
      }.`
      + (filed.replaced ? ' It replaced your earlier open offer.' : '')
      + ' Nothing moved: the person decides whether to go. What they leave out stays where they are when they take it.',
    failed: false,
  }
}
