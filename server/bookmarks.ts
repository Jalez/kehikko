/**
 * macOS bookmark data for a project's folder: what lets this host find a
 * folder after it was renamed or moved, the way a Mac app finds a document.
 *
 * ## Why here, and why through `bun:ffi`
 *
 * A bookmark is minted and resolved by CoreFoundation
 * (`CFURLCreateBookmarkData`, `CFURLCreateByResolvingBookmarkData`). The host
 * calls it directly through `bun:ffi`, which works the same in a dev host
 * (`bun run server/server.ts`) and in the compiled sidecar the desktop app
 * bundles (`bun build --compile`), so the desktop shell needs no channel of
 * its own for it. The app is not sandboxed, so plain bookmark data (no
 * security scope, creation options 0) is all it takes: it resolves a rename or
 * a move on the same volume by the folder's file id.
 *
 * ## What a bookmark is not
 *
 * It is a hint, never the truth. What it resolves to is a path this host has
 * not checked; `follow.ts` treats it as untrusted until the folder there
 * carries the project's own id. A bookmark to a folder that was deleted and
 * re-made at the same path resolves to that path too (CoreFoundation falls
 * back on the path), which is exactly why the id is checked.
 *
 * Off macOS, or when CoreFoundation cannot be loaded, every call here answers
 * null and nothing else happens; "Locate…" is the way back then.
 */
import { dlopen, FFIType, toArrayBuffer } from 'bun:ffi'
import { platform } from 'node:os'

/** What a bookmark resolved to: an absolute path, and whether CoreFoundation says to mint it again. */
export interface Resolved {
  path: string
  stale: boolean
}

/** The two things this host asks of bookmarks. Swappable, so tests can run with none at all. */
export interface Bookmarks {
  mint(path: string): Uint8Array | null
  resolve(bookmark: Uint8Array): Resolved | null
}

/* `kCFURLBookmarkResolutionWithoutUIMask | kCFURLBookmarkResolutionWithoutMountingMask`:
   never put up a dialog, and never mount a volume to find a folder. */
const RESOLVE_QUIETLY = (1 << 8) | (1 << 9)
const PATH_MAX = 4096

let chosen: Bookmarks | null | undefined

/**
 * The bookmarks of this machine, or null where there are none (not macOS, or
 * CoreFoundation would not load). Loaded once, on first use.
 */
export function bookmarks(): Bookmarks | null {
  if (chosen === undefined) chosen = platform() === 'darwin' ? coreFoundation() : null
  return chosen
}

/** Use these bookmarks instead (a test's), or `null` for none; `undefined` goes back to the machine's. */
export function setBookmarks(next: Bookmarks | null | undefined): void {
  chosen = next
}

/** CoreFoundation's bookmarks, through `bun:ffi`. Null when anything about loading it fails. */
export function coreFoundation(): Bookmarks | null {
  try {
    const { ptr, i64, u64, u8, void: none } = FFIType
    const cf = dlopen('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation', {
      CFURLCreateFromFileSystemRepresentation: { args: [ptr, ptr, i64, u8], returns: ptr },
      CFURLCreateBookmarkData: { args: [ptr, ptr, u64, ptr, ptr, ptr], returns: ptr },
      CFURLCreateByResolvingBookmarkData: { args: [ptr, ptr, u64, ptr, ptr, ptr, ptr], returns: ptr },
      CFURLGetFileSystemRepresentation: { args: [ptr, u8, ptr, i64], returns: u8 },
      CFDataCreate: { args: [ptr, ptr, i64], returns: ptr },
      CFDataGetLength: { args: [ptr], returns: i64 },
      CFDataGetBytePtr: { args: [ptr], returns: ptr },
      CFRelease: { args: [ptr], returns: none },
    }).symbols

    return {
      mint(path) {
        try {
          const bytes = Buffer.from(path, 'utf8')
          if (bytes.length === 0 || bytes.length >= PATH_MAX) return null
          const url = cf.CFURLCreateFromFileSystemRepresentation(null, bytes, bytes.length, 1)
          if (!url) return null
          const data = cf.CFURLCreateBookmarkData(null, url, 0, null, null, null)
          cf.CFRelease(url)
          if (!data) return null
          try {
            const length = Number(cf.CFDataGetLength(data))
            const at = cf.CFDataGetBytePtr(data)
            if (!at || length <= 0) return null
            /* Copied out before the CFData is released. */
            return new Uint8Array(toArrayBuffer(at, 0, length)).slice()
          } finally {
            cf.CFRelease(data)
          }
        } catch {
          return null
        }
      },
      resolve(bookmark) {
        try {
          if (bookmark.length === 0) return null
          const data = cf.CFDataCreate(null, bookmark, bookmark.length)
          if (!data) return null
          const stale = new Uint8Array(1)
          const url = cf.CFURLCreateByResolvingBookmarkData(null, data, RESOLVE_QUIETLY, null, null, stale, null)
          cf.CFRelease(data)
          if (!url) return null
          const buffer = new Uint8Array(PATH_MAX)
          const ok = cf.CFURLGetFileSystemRepresentation(url, 1, buffer, buffer.length)
          cf.CFRelease(url)
          if (!ok) return null
          const end = buffer.indexOf(0)
          const path = Buffer.from(buffer.subarray(0, end < 0 ? buffer.length : end)).toString('utf8')
          return path.startsWith('/') ? { path, stale: stale[0] !== 0 } : null
        } catch {
          return null
        }
      },
    }
  } catch {
    return null
  }
}
