import { contextSchema, type ModuleContext } from 'roadmap-module-protocol'

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
 * A person may genuinely want two panes on two different epics: last quarter's
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
  project: string | null
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
): ModuleContext {
  const parsed = contextSchema.safeParse({
    epic: subject.epic,
    project: subject.project,
    theme,
    selection,
  })
  if (parsed.success) return parsed.data

  /* An epic slug the person typed that the schema will not take. The context
     still goes out — a module that is told nothing shows the last epic it heard
     about forever, which is a page quietly describing the wrong work — and it
     goes out empty, which is a state a module is required to be able to move
     into. The selection goes with it: it was picked out of an epic that this
     context no longer names, so keeping it would point every module at
     something in a place they are no longer looking. */
  return contextSchema.parse({ epic: null, project: null, theme, selection: [] })
}
