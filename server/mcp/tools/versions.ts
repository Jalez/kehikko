import { PACKAGE_VERSION } from 'kehikot-module-protocol'

import { releaseForAgents } from '../../../src/host/moduleReleases.ts'
import type { Canvas } from '../../canvases.ts'
import type { VersionListing } from '../../pins.ts'
import { MAX_ID } from '../bounds.ts'
import type { Door } from '../door.ts'
import { KEHIKKO_PROPERTY } from '../params.ts'
import { kehikkoTool } from '../tool.ts'

export const moduleVersions = kehikkoTool({
  name: 'module_versions',
  schema: {
    description:
      'The versions a module on a kehikko can run: "latest" — the module’s own checkout, which is what every '
      + 'container runs unless pinned; for a module the app installed that is its newest release (or main, when '
      + 'its repository has no release yet), and this says which release it runs and the newest it can, and which '
      + 'Kehikot app versions each works with (or the protocol it needs, when the app versions cannot be read) — and '
      + 'the semver tags on its repository, newest first. Each tag says '
      + 'whether this host can speak to it (known once it has been prepared once), whether the data guard '
      + 'refuses it for this kehikko’s project (a version whose data format is older than the one the project’s '
      + 'data is already in), and whether it is already prepared or running. Also says which version this '
      + 'container is pinned to. Reads the tags from the repository, without a token.',
    inputSchema: {
      type: 'object',
      properties: {
        ...KEHIKKO_PROPERTY,
        module: { type: 'string', description: 'The module id, as read_canvas prints it, e.g. "kehikot.<name>".' },
      },
      required: ['module'],
    },
  },
  run: ({ door, canvas, how }, args) => versionsOn('module_versions', canvas, how, args, door),
})

export const pinVersion = kehikkoTool({
  name: 'pin_version',
  schema: {
    description:
      'Make one container run a given version of its module, or go back to latest. The same choice a person '
      + 'makes from the version in the container’s header, and they see it change. Per container: other '
      + 'kehikot holding the same module keep their own version, and containers pinned to the same version share '
      + 'one process. The first time a version is used it is fetched, checked out and installed, which takes a '
      + 'minute; the container says so while it happens. Refused, with the reason, for a tag that is not one of '
      + 'the module’s versions, one this host cannot speak to, and one the data guard blocks. The module’s own '
      + 'checkout is never switched.',
    inputSchema: {
      type: 'object',
      properties: {
        ...KEHIKKO_PROPERTY,
        module: { type: 'string', description: 'The module id of a container on this kehikko.' },
        version: {
          type: ['string', 'null'],
          description: 'A release tag module_versions lists, e.g. "v1.2.0" — or null (or "latest") to unpin.',
        },
      },
      required: ['module', 'version'],
    },
  },
  run: ({ door, canvas, how }, args) => versionsOn('pin_version', canvas, how, args, door),
})

/** `module_versions` and `pin_version`: a module's versions on a kehikko, and one container's pin. */
async function versionsOn(
  name: 'module_versions' | 'pin_version',
  canvas: Canvas,
  how: string,
  args: Record<string, unknown>,
  door: Door,
): Promise<{ text: string; failed: boolean }> {
  if (!door.versions) return { text: 'This host does not run module versions.', failed: true }
  const module = typeof args.module === 'string' && args.module.length <= MAX_ID ? args.module : null
  if (!module) return { text: `${name} needs module: a module id as read_canvas prints it, e.g. "kehikot.<name>".`, failed: true }
  if (name === 'module_versions') {
    const listed = await door.versions.list(module, canvas.id)
    if ('why' in listed) return { text: listed.why, failed: true }
    return { text: versionsText(listed, canvas, how), failed: false }
  }
  const raw = args.version
  if (raw !== null && raw !== 'latest' && (typeof raw !== 'string' || raw.length > 64)) {
    return { text: 'pin_version needs version: a tag module_versions lists, e.g. "v1.2.0", or null for latest.', failed: true }
  }
  const pinned = await door.versions.pin(canvas.id, module, raw === null || raw === 'latest' ? null : raw)
  if (!pinned.ok) return { text: `${pinned.why} Nothing was changed.`, failed: true }
  return { text: pinned.text, failed: false }
}

/** One listing, written out for an agent. */
function versionsText(listing: VersionListing, canvas: Canvas, how: string): string {
  const lines = [
    `${listing.name} (${listing.module}) on kehikko ${canvas.id} (${canvas.name}), ${how}.`,
    `This container runs: ${listing.pinned ? `${listing.pinned} (pinned)` : 'latest'}.`,
    `latest — the module's own checkout${listing.latest.version ? `, which calls itself ${listing.latest.version}` : ''}${
      listing.latest.commit ? ` at ${listing.latest.commit}` : ''
    }${listing.latest.dataVersion !== null ? `, data format ${listing.latest.dataVersion}` : ''}.`,
  ]
  if (listing.release) lines.push(releaseForAgents(listing.release, { protocol: PACKAGE_VERSION }))
  if (listing.recorded !== null) lines.push(`This project's data is in format ${listing.recorded}.`)
  if (listing.error) lines.push(listing.error)
  if (listing.hint) lines.push(listing.hint)
  for (const one of listing.versions) {
    const marks = [
      one.tag === listing.pinned ? 'PINNED HERE' : null,
      one.running ? 'running' : one.prepared ? 'prepared' : null,
      one.dataVersion !== null ? `data format ${one.dataVersion}` : null,
      one.compatible === false ? `INCOMPATIBLE: ${one.incompatible ?? 'speaks another protocol'}` : one.compatible === null ? 'protocol checked when first prepared' : null,
      one.blocked ? `BLOCKED: ${one.blocked}` : null,
    ].filter((mark): mark is string => mark !== null)
    lines.push(`  ${one.tag}${marks.length ? ` — ${marks.join('; ')}` : ''}`)
  }
  return lines.join('\n')
}
