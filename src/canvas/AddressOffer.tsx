import { ExternalLink, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { offerWords, type Offer } from '@/host/address.ts'

/**
 * A module asked to show a web page (`address.open`, protocol 2.16.0) and
 * nothing on the open kehikko shows pages. Nothing has been opened: the person
 * chooses here.
 *
 * - "Open in your browser": only for an `https:` address, through
 *   `openExternal` (the desktop shell hands a new window to the default
 *   browser). An address on this machine is not opened outside from here.
 * - "Add <module> to this kehikko": a registered module that shows pages, put
 *   on the kehikko as a new container. It opens the address when it arrives.
 *
 * The address and its title are the module's words: drawn as text, never as a
 * link or markup.
 */
export function AddressOffer({
  offer,
  askerName,
  addable,
  onOpenOutside,
  onAdd,
  onDismiss,
}: {
  /** The offer, or null when the dialog is closed. */
  offer: Offer | null
  /** The registered name of the module that asked. */
  askerName: string
  /** Registered modules that show pages and are not on this kehikko. */
  addable: readonly { id: string; name: string }[]
  onOpenOutside(offer: Offer): void
  onAdd(offer: Offer, module: string): void
  onDismiss(): void
}) {
  const words = offer ? offerWords(offer, askerName, addable) : null
  return (
    <Dialog
      open={offer !== null}
      onOpenChange={(open) => {
        if (!open) onDismiss()
      }}
    >
      <DialogContent data-address-offer="" className="sm:max-w-md">
        {offer && words ? (
          <>
            <DialogHeader>
              <DialogTitle>{words.title}</DialogTitle>
              <DialogDescription>{words.lede}</DialogDescription>
            </DialogHeader>
            <div className="bg-muted/40 rounded-md border px-3 py-2 text-xs">
              {offer.title ? <p className="text-foreground font-medium break-words">{offer.title}</p> : null}
              <p className="text-muted-foreground font-mono text-[11px] break-all" data-address-url="">
                {offer.url}
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onDismiss}>
                Not now
              </Button>
              {words.outside ? (
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => onOpenOutside(offer)}>
                  <ExternalLink className="size-3.5" aria-hidden />
                  Open in your browser
                </Button>
              ) : null}
              {addable.map((one) => (
                <Button key={one.id} size="sm" className="gap-1.5" onClick={() => onAdd(offer, one.id)}>
                  <Plus className="size-3.5" aria-hidden />
                  Add {one.name} to this kehikko
                </Button>
              ))}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
