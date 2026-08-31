import { contextSchema, passageSchema, type ModuleContext, type Passage } from 'roadmap-module-protocol'

import type { Project } from './projects.ts'

/**
 * What the canvas is about, and why that is a harder question here than the
 * protocol expects.
 *
 * ## The problem
 *
 * `roadmap.context` exists to tell a framed module what the person is currently
 * looking at. That question has an obvious answer in a host that is a page with
 * one panel on it: the panel shows one epic, so the epic that is open is the
 * context, and when the reader switches epics every panel is told.
 *
 * A canvas has no open document. There are five modules side by side, all
 * visible at once, none of them "open" in the sense the other host meant. The
 * naive translation — "the module the person last clicked in" — is worse than
 * having no context at all: it would change the context of four other modules
 * every time somebody's cursor landed somewhere, and each of those four would
 * re-render, re-fetch, and lose whatever the person had half-typed in it. A
 * context that changes when you look at something is a context that punishes
 * looking.
 *
 * ## What this host does instead
 *
 * The canvas has a SUBJECT: one epic and one project, set by the person, in the
 * host's own bar, and by nothing else. Every epic-scoped mode on the canvas is
 * told the same one.
 *
 * The two halves of it are not the same kind of fact any more, and the
 * difference is worth being precise about. The PROJECT is where the whole
 * kehikko is — a folder on disk, the same for every container, and the thing modules
 * will eventually take their root from. The EPIC is one of the things inside
 * it. So the project is picked first and the epic is picked from the project's
 * own list, which is why they are two selects in that order rather than a field
 * you type into.
 *
 * The move is to stop reading `context` as "the document you have open" and
 * start reading it as "what this workspace is about". Under that reading the
 * canvas is not an awkward fit for the message; it is the case that makes the
 * message make sense. Six modules arranged around one epic are six views of one
 * thing, and the arrangement is the person saying so. Six modules each on a
 * different epic would not be a workspace — it would be six windows that happen
 * to share a screen, and nothing about the layout would mean anything.
 *
 * So: **one context, every module, changed only when the person changes it.**
 * It is stored with the layout, because it is the same kind of thing — a
 * property of this person's view rather than of anybody's data — and it
 * survives a reload for the same reason the layout does.
 *
 * ## The one thing that changes it besides the person
 *
 * `view.goto` naming an epic. A module that shows every epic on the machine and
 * offers "open that one" is asking the canvas to change its subject, and the
 * canvas is exactly the thing that can honour it. That is answered in the
 * browser rather than on the server — see `ask.ts` — because it acts on the
 * view and the view is here.
 *
 * ## What this host cannot express, and it is a real want
 *
 * A person may genuinely want two containers on two different epics: last quarter's
 * beside this one, to compare. The canvas can do that — nothing stops the host
 * sending a different `roadmap.context` to a different frame, and it is two
 * lines. What is missing is on the other side. A module has no way to say "I am
 * pinned, stop re-pointing me", no way to ask which epic it is on beyond the
 * last one it was told, and no way to tell a person's pin from the canvas
 * having moved. Pinning would therefore be a host-only convention that modules
 * cannot see they are subject to, and a module written against it would behave
 * differently on this host in a way its author could not discover. So the host
 * does not do it, and the gap is reported rather than papered over.
 */

export interface Subject {
  epic: string | null
  /**
   * The project this kehikko is in, whole, or null when there is none open.
   *
   * The project OBJECT rather than its id, because both of its fields go out on
   * the wire and they must go out together. A subject holding an id would make
   * `toWireContext` look one up, which means it could fail to, which means a
   * context could go out naming a project and not saying where it is — the
   * exact disagreement `projectPath`'s own comment in the protocol says a host
   * should make impossible by composing both in one place. This is that place.
   */
  project: Project | null
}

export const NO_SUBJECT: Subject = { epic: null, project: null }

/**
 * The subject, as the wire spells it.
 *
 * Built in one place and validated with the protocol's own schema before it
 * goes out, so that a rename in the package fails here — loudly, in one
 * function — rather than as a module quietly never hearing which epic it is on.
 * The host is not obliged to use `contextSchema` (it is a convenience, and the
 * host stays responsible for having run it); using it is how the host finds out
 * it has drifted.
 */
export function toWireContext(
  subject: Subject,
  theme: 'light' | 'dark',
  /**
   * What has been picked out, as refs.
   *
   * A separate argument rather than a third field on `Subject`, because it is
   * not one. A subject is what the canvas is ABOUT and survives being looked
   * away from; a selection is what somebody currently has their finger on. They
   * change on different gestures and at different rates, and the canvas clears
   * the second whenever the first moves.
   */
  selection: readonly string[] = [],
  /**
   * Which canvas this is, or null when there is not one open yet.
   *
   * The host has to fill this in and no module can work it out for itself: a
   * module's page is loaded ONCE and shown on whichever canvas asks for it — see
   * `Frames.tsx` on why the iframes outlive the containers — so a module genuinely
   * cannot tell where it is standing. It only starts to matter now that
   * something else on the wire says where IT came from: a `roadmap.event`
   * carries the kehikko it happened on, this says the one being looked at, and
   * near-or-far becomes a comparison the module makes rather than a rule the
   * host imposes.
   *
   * Nullable rather than absent, and the null is honest rather than tidy. A
   * module handed null cannot sort near from far, and the protocol says that is
   * a smaller loss than being handed a wrong answer — so the right thing for a
   * module to do with it is to say the filter cannot be honest, not to draw an
   * empty list.
   *
   * Note what this is NOT: a per-frame fact. Every frame on this canvas is told
   * the same one, because the canvas is one place and they are all standing in
   * it. The subject is per-canvas for the same reason.
   */
  kehikko: { id: number; name: string } | null = null,
  /**
   * Where somebody is pointing inside a document, or null.
   *
   * A fourth argument rather than a third field on `Subject`, and for a sharper
   * version of the reason the selection is one. A subject is what the canvas is
   * ABOUT; a selection is what somebody has their finger on; a passage is where
   * inside a document that finger is. Each is narrower than the one before it
   * and each changes on a different gesture — the subject when a person picks
   * from the bar, the selection when they click a ref, the passage when they
   * drag over a paragraph — and folding the fastest of the three into the
   * slowest would make every highlight look like a change of subject.
   *
   * Passed through unchanged, deliberately. The host did not open the file and
   * cannot say the path exists, that the offsets are inside it, or that the
   * quote is what is there now. See `point` on `CanvasControls` in `ask.ts`.
   */
  passage: Passage | null = null,
): ModuleContext {
  /**
   * The passage, checked on its own before anything else is composed.
   *
   * The fallbacks below exist for ONE bad field — an epic slug the schema will
   * not take — and they work by rebuilding the context without it. A second
   * field that can fail breaks that: a passage past `LIMITS.QUOTE` would make
   * the first parse fail, then make the fallback fail for the same reason, and
   * the last resort would blank the project as well. One module sending a
   * chapter as a quote would cost every container on the canvas the folder it works
   * in, and nothing anywhere would say why.
   *
   * So each doubtful thing is failed separately, close to itself. A passage
   * that will not parse becomes no passage — which is a state every consumer
   * already handles, and the true one: nothing the host can vouch for is being
   * pointed at.
   */
  const pointing = passage === null || passageSchema.safeParse(passage).success ? passage : null

  const parsed = contextSchema.safeParse({
    epic: subject.epic,
    /* Name and path, filled in from one project in one expression. Two nullable
       fields on the wire that can disagree — see `projectPath` in the
       protocol's `wire.ts` — and the way a host stops them disagreeing is to
       have exactly one place that writes them. */
    project: subject.project?.name ?? null,
    projectPath: subject.project?.path ?? null,
    theme,
    selection,
    kehikko,
    passage: pointing,
  })
  if (parsed.success) return parsed.data

  /* An epic slug the schema will not take.
   *
   * It used to be a slug the person had TYPED — the bar had a free-text field —
   * and it is not any more: the epic is picked from a list the host read off
   * the project's own disk. That does not retire this branch, it changes what
   * it guards. Two things still reach here:
   *
   *   - A slug persisted in the database from before the picker existed, or
   *     from a hand-edited row, which no list ever vetted.
   *   - A kehikko whose remembered epic is no longer in its project. The file
   *     was renamed or deleted, or the kehikko was moved to another project,
   *     and the stored slug is now a name for nothing.
   *
   * The context still goes out — a module that is told nothing shows the last
   * epic it heard about forever, which is a page quietly describing the wrong
   * work — and it goes out empty, which is a state a module is required to be
   * able to move into. The selection goes with it: it was picked out of an epic
   * that this context no longer names, so keeping it would point every module
   * at something in a place they are no longer looking.
   *
   * The PROJECT survives, for the reason the kehikko does. Where the canvas is
   * standing has nothing to do with whether an epic slug parses, and blanking
   * it would turn one bad slug into every module losing the folder it works in.
   */
  /* The kehikko survives the fallback, and the selection does not. They fail
     for different reasons: a selection is refs picked out of an epic this
     context no longer names, so keeping it would point every module at
     something that is not in front of them. Where the canvas IS has nothing to
     do with what the person typed into the epic box, and blanking it would turn
     a bad slug into every module losing its ability to tell near from far. */
  /* The passage survives the fallback, and it is the third answer in a row
     where the reason is "what did this actually depend on".
     A selection is refs picked out of an epic this context no longer names, so
     it goes. A passage names a FILE and a byte range in it. A person reading
     chapter three of a paper is still reading chapter three when the epic slug
     stored against this canvas turns out not to parse, and dropping it would
     make one bad row in a table close somebody's document. */
  const bare = contextSchema.safeParse({
    epic: null,
    project: subject.project?.name ?? null,
    projectPath: subject.project?.path ?? null,
    theme,
    selection: [],
    kehikko,
    passage: pointing,
  })
  if (bare.success) return bare.data
  /* Belt and braces: this function must not throw. It is called during render,
     and a host that white-screens because somebody named a canvas something the
     schema dislikes would be a host taking every module down with it. */
  return contextSchema.parse({
    epic: null,
    project: null,
    projectPath: null,
    theme,
    selection: [],
    kehikko: null,
    /* Not here, and it cannot be needed: a passage that would not parse was
       already turned into null at the top of this function. This branch must
       not throw — it is called during render — so it names only fields that
       cannot fail. */
  })
}
