import { CircleHelp } from 'lucide-react'
import type { Help } from 'kehikot-module-protocol'

import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { helpTitle } from '@/host/moduleHelp.ts'
import { introTitle } from '@/host/moduleIntro.ts'
import { Hint } from './Hint.tsx'

/**
 * A module's "How to use" (protocol 2.52.0): what its manifest's `help` says, drawn by the host.
 *
 * The host's because a module's page is in a frame: a dialog inside it is clipped to the container,
 * and the help is most wanted exactly when the container is small or folded. So the module only
 * WRITES it, as plain text in its manifest, and the host draws it here — a heading per section and a
 * bullet list of its points.
 *
 * Every string is a module's words and drawn as TEXT: never markup, never a link, never an address
 * the host opens. `helpOf` has already flattened each to one line. A dialog (Radix): `role="dialog"`,
 * focus kept inside while open and given back to what opened it, Escape and the close button close it.
 * At most the width and height of the window less a margin, scrolling inside, in the theme's colours.
 */
export function ModuleHelpDialog({
  open,
  onOpenChange,
  name,
  help,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  /** The module's registered name, the dialog's title. */
  name: string
  help: Help
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-module-help=""
        className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg flex-col gap-3 overflow-hidden p-4 sm:p-5"
      >
        <DialogHeader className="pr-6 text-left">
          <DialogTitle className="text-base [overflow-wrap:anywhere]">{helpTitle(name)}</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed [overflow-wrap:anywhere]">{help.summary}</DialogDescription>
        </DialogHeader>
        {help.sections.length ? (
          <div className="-mr-2 min-h-0 flex-1 space-y-4 overflow-y-auto pr-2" data-help-sections="">
            {help.sections.map((section, at) => (
              <section key={at} aria-labelledby={`module-help-${at}`}>
                <h3 id={`module-help-${at}`} className="text-foreground mb-1.5 text-sm font-semibold [overflow-wrap:anywhere]">
                  {section.title}
                </h3>
                <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm leading-relaxed">
                  {section.points.map((point, one) => (
                    <li key={one} className="[overflow-wrap:anywhere]">
                      {point}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The "?" beside a module in the modules list: opens its introduction (protocol 2.57.0) in the app's
 * introduction dialog — or its "How to use" there when it has none (`ModuleIntro.tsx`).
 */
export function IntroButton({ name, onIntro }: { name: string; onIntro(): void }) {
  return (
    <Hint label={`what ${name} is for, and how to start`} side="left">
      <Button
        variant="ghost"
        size="icon"
        aria-label={introTitle(name)}
        data-module-help-button=""
        className="text-muted-foreground hover:text-foreground size-6 shrink-0"
        onClick={onIntro}
      >
        <CircleHelp className="size-3.5" aria-hidden />
      </Button>
    </Hint>
  )
}
