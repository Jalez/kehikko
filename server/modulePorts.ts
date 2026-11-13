import { MODULE_PORTS } from 'kehikot-module-protocol/serve'

/**
 * The port this host hands a module it starts on any port (protocol 2.65.0 reads `PORT=0` so).
 *
 * Not port 0. The system fills port 0 from its temporary range (49152–65535 on macOS), the range it
 * also hands another program that asks for "any port" — a test runner's server, bound to `[::]`.
 * macOS lets that wildcard bind share the module's `127.0.0.1` port, and the other program's own
 * requests to `127.0.0.1` then reach the module. So the host hands a port of the protocol's
 * `MODULE_PORTS` (20000–21999, below every system's temporary range), one no registration names.
 * The module takes it through `claim`, which binds it only when nothing holds it on any address
 * (protocol 2.96.0; before, `127.0.0.1`) and drifts, said and registered, when something does. So
 * a module built against any protocol from 2.65.0 on is kept out of the temporary range, without
 * a release of its own.
 *
 * Pure: `random` decides where in the band the search starts, so two modules started together
 * rarely ask for the same port. Null only when every port of the band is named.
 */
export function portToHand(taken: ReadonlySet<number>, random: () => number = Math.random): number | null {
  const size = MODULE_PORTS.to - MODULE_PORTS.from + 1
  const first = Math.min(size - 1, Math.floor(random() * size))
  for (let i = 0; i < size; i++) {
    const port = MODULE_PORTS.from + ((first + i) % size)
    if (!taken.has(port)) return port
  }
  return null
}
