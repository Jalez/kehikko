import type { ComponentProps } from 'react'
import { ToolsDialog } from '@/canvas/Tools.tsx'
import { SkillsDialog } from '@/canvas/Skills.tsx'
import { ModuleAboutDialog, ModuleHelpDialog } from '@/canvas/ModuleHelp.tsx'
import { ModuleIntroDialog } from '@/canvas/ModuleIntro.tsx'
import { ModuleSettingsDialog } from '@/canvas/ModuleSettings.tsx'
import { helpFor as helpOfModule } from '@/host/moduleHelp.ts'
import { introFor as introOfModule } from '@/host/moduleIntro.ts'
import { openWhatsNew } from '@/host/whatsNew.ts'
import { builtFrom, worksWithOf } from '@/host/moduleMenu.ts'
import { settingsOf } from '@/host/moduleSettings.ts'
import type { Presence } from '@/host/registry.ts'
import type { DialogKind, Dialogs } from './useDialogs.ts'

type Kehikko = Parameters<typeof worksWithOf>[2][number]
type SettingsProps = ComponentProps<typeof ModuleSettingsDialog>

/**
 * The host's windows about one module — its tools, its agent skills, its "How
 * to use", its introduction and its settings — drawn from `useDialogs`' state.
 * Moved out of `App.tsx` as they were drawn there, in the same order and the
 * same place among the page's dialogs. The prompt dialog stays in `App.tsx`,
 * where it always stood, between the canvas's other marks.
 */
export function ModuleDialogs({
  dialogs,
  close,
  hostId,
  byId,
  presences,
  kehikot,
  open,
  project,
  connections,
  scope,
  onLookAgain,
  onPlace,
}: {
  dialogs: Dialogs
  close: (kind: DialogKind) => void
  /* The host's own id: the host is not in `byId`. */
  hostId: string | undefined
  byId: ReadonlyMap<string, Presence>
  presences: readonly Presence[]
  kehikot: readonly Kehikko[]
  open: Kehikko | null
  project: SettingsProps['project']
  connections: SettingsProps['connections']
  scope: SettingsProps['scope']
  /* A sweep with every manifest asked again (`look(true)`). */
  onLookAgain: () => void
  onPlace: (id: string) => void
}) {
  const { toolsFor, skillsFor, helpFor, introOpen, settingsFor, settingsTarget } = dialogs
  return (
    <>
      {/* The tools window, owned by the host for the same reason. It asks the
          host's server what the module's door offers at the moment it opens —
          never on a sweep; see the essay in `server/tools.ts`. `onChanged` is a
          sweep, so the mark on the container catches up with a connect or a
          disconnect without anybody pressing "look again". */}
      {toolsFor ? (
        <ToolsDialog
          open
          onOpenChange={(isOpen) => {
            if (!isOpen) close('tools')
          }}
          module={toolsFor}
          /* The host is not in `byId` and must not be looked up as if it were;
             what it is called in this window is what the strip calls it. */
          name={
            toolsFor === hostId ? 'this host' : (byId.get(toolsFor)?.name ?? toolsFor)
          }
          onChanged={onLookAgain}
        />
      ) : null}

      {/* A module's agent skills, read and installed on the person's press. Asked when it opens. */}
      {skillsFor ? (
        <SkillsDialog
          open
          onOpenChange={(isOpen) => {
            if (!isOpen) close('skills')
          }}
          module={skillsFor}
          name={byId.get(skillsFor)?.name ?? skillsFor}
        />
      ) : null}

      {/* A module's "How to use": its manifest's own words, drawn as text. "About <name>" in the same
          dialog when it wrote none, from its summary and its list entry: help is never missing. */}
      {helpFor && helpOfModule(byId.get(helpFor)?.module) ? (
        <ModuleHelpDialog
          open
          onOpenChange={(isOpen) => {
            if (!isOpen) close('help')
          }}
          name={byId.get(helpFor)?.name ?? helpFor}
          help={helpOfModule(byId.get(helpFor)?.module)!}
        />
      ) : helpFor ? (
        <ModuleAboutDialog
          open
          onOpenChange={(isOpen) => {
            if (!isOpen) close('help')
          }}
          id={helpFor}
          name={byId.get(helpFor)?.name ?? helpFor}
          summary={byId.get(helpFor)?.module?.summary ?? byId.get(helpFor)?.summary ?? null}
          says={byId.get(helpFor)?.module?.agentSays ?? null}
        />
      ) : null}

      {/* A module's introduction (protocol 2.57.0), in the app's introduction dialog. */}
      {introOpen ? (
        <ModuleIntroDialog
          open
          onOpenChange={(isOpen) => {
            if (!isOpen) close('intro')
          }}
          id={introOpen.id}
          name={byId.get(introOpen.id)?.name ?? introOpen.about.name}
          icon={introOpen.about.icon ?? null}
          summary={byId.get(introOpen.id)?.summary ?? introOpen.about.summary ?? null}
          intro={introOfModule(byId.get(introOpen.id)?.module)}
          help={helpOfModule(byId.get(introOpen.id)?.module)}
          works={worksWithOf(introOpen.id, presences, kehikot, open)}
          version={(() => {
            const built = byId.get(introOpen.id) ? builtFrom(byId.get(introOpen.id)!) : null
            return built ? [`Version ${built.version}`] : []
          })()}
          releases={byId.has(introOpen.id)}
          onNotes={byId.has(introOpen.id) ? () => openWhatsNew({ item: introOpen.id }) : undefined}
          addable={
            introOpen.add
              ? {
                  open: open !== null,
                  placed: (open?.placements ?? []).some((one) => one.i === introOpen.id),
                  registered: byId.has(introOpen.id),
                  onPlace: () => onPlace(introOpen.id),
                  onLookAgain,
                }
              : undefined
          }
        />
      ) : null}

      {/* A module's settings window: what it declared, saved by the module (protocol 2.15.0), and its
          Providers & Consumers on the open kehikko (`host/connections.ts`). */}
      {settingsFor ? (
        <ModuleSettingsDialog
          open
          onOpenChange={(isOpen) => {
            if (!isOpen) close('settings')
          }}
          module={settingsFor}
          target={settingsTarget}
          name={byId.get(settingsFor)?.name ?? settingsFor}
          project={project}
          hasSettings={settingsOf(byId.get(settingsFor)?.module).length > 0}
          connections={connections}
          scope={scope}
        />
      ) : null}
    </>
  )
}
