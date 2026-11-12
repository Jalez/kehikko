import { HostLog } from './hostLog.ts'

/**
 * The host's log, open before anything else in `server.ts` runs: imported
 * first there, so a line printed while the other modules load, or an error
 * thrown while they do, is in `host.log` too. See `hostLog.ts`.
 */
export const hostLog = new HostLog()
hostLog.captureConsole()
hostLog.captureCrashes()
