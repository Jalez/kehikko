import { useMemo, useReducer } from 'react'
import type { IntroAbout } from '@/canvas/Modules.tsx'

/**
 * Which of the host's windows about one module are open, and for whom.
 *
 * Each is owned by the host rather than by the module: a module's page is in
 * an iframe, so a modal it rendered would be clipped to its container — see
 * `Prompts.tsx`. They are independent of each other, as the seven pieces of
 * state in `App.tsx` they were moved out of were: opening one closes no other.
 */
export interface Dialogs {
  /* Which container's prompts are being written, if any. The dialog belongs to the
     host rather than to a module — see `Prompts.tsx` for why a modal inside an
     iframe is not a modal. */
  prompting: string | null
  /* Which module's tools are being looked at, if any. The host's window for the
     same reason the prompt one is: a module cannot open a modal bigger than its
     own container, and what this window shows is not the module's material anyway —
     it is what the AGENT has been told. See `Tools.tsx`. */
  toolsFor: string | null
  /* Whose agent skills are open (protocol 2.5.0). See `Skills.tsx`. */
  skillsFor: string | null
  /* Whose "How to use" is open (protocol 2.52.0): drawn from its manifest's `help`, by the host. */
  helpFor: string | null
  /* A module's introduction (protocol 2.57.0) in the app's introduction dialog: from the modules
     list's "?" with "Add to this kehikko" (`add`), from the container's Help menu
     without it. */
  introOpen: { id: string; about: IntroAbout; add: boolean } | null
  /** Whose settings are open in the modal (protocol 2.15.0), from a container's gear or Container menu. */
  settingsFor: string | null
  /* The setting the dialog opens at, when a module's page asked for one (`settings.open`). */
  settingsTarget: string | null
}

export type DialogKind = 'prompts' | 'tools' | 'skills' | 'help' | 'intro' | 'settings'

export type DialogAct =
  | { open: 'prompts' | 'tools' | 'skills' | 'help'; id: string }
  | { open: 'intro'; id: string; about: IntroAbout; add: boolean }
  | { open: 'settings'; id: string; target: string | null }
  | { close: DialogKind }

export const NO_DIALOGS: Dialogs = {
  prompting: null,
  toolsFor: null,
  skillsFor: null,
  helpFor: null,
  introOpen: null,
  settingsFor: null,
  settingsTarget: null,
}

const FIELD = { prompts: 'prompting', tools: 'toolsFor', skills: 'skillsFor', help: 'helpFor' } as const

/**
 * The one way the windows change. A close of a window that is not open, or an
 * open of one already open for the same module, is the state it was — what the
 * separate `useState` setters gave, which skip a render for an unchanged value.
 * Closing the settings window forgets the setting it was opened at.
 */
export function dialogsAfter(was: Dialogs, act: DialogAct): Dialogs {
  if ('close' in act) {
    if (act.close === 'intro') return was.introOpen === null ? was : { ...was, introOpen: null }
    if (act.close === 'settings') return was.settingsFor === null && was.settingsTarget === null ? was : { ...was, settingsFor: null, settingsTarget: null }
    const field = FIELD[act.close]
    return was[field] === null ? was : { ...was, [field]: null }
  }
  if (act.open === 'intro') return { ...was, introOpen: { id: act.id, about: act.about, add: act.add } }
  if (act.open === 'settings') {
    return was.settingsFor === act.id && was.settingsTarget === act.target ? was : { ...was, settingsFor: act.id, settingsTarget: act.target }
  }
  const field = FIELD[act.open]
  return was[field] === act.id ? was : { ...was, [field]: act.id }
}

/** The windows' state, and a stable function per act. */
export function useDialogs() {
  const [dialogs, dispatch] = useReducer(dialogsAfter, NO_DIALOGS)
  const acts = useMemo(
    () => ({
      openPrompts: (id: string) => dispatch({ open: 'prompts', id }),
      openTools: (id: string) => dispatch({ open: 'tools', id }),
      openSkills: (id: string) => dispatch({ open: 'skills', id }),
      openHelp: (id: string) => dispatch({ open: 'help', id }),
      openIntro: (id: string, about: IntroAbout, add: boolean) => dispatch({ open: 'intro', id, about, add }),
      openSettings: (id: string, target: string | null) => dispatch({ open: 'settings', id, target }),
      close: (kind: DialogKind) => dispatch({ close: kind }),
    }),
    [],
  )
  return { dialogs, ...acts }
}
