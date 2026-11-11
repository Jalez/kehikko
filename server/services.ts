import { LIMITS, serviceProviderSchema, type ServiceProvider } from 'kehikot-module-protocol'

/**
 * Who provides a service here (protocol 2.81.0, `services.find`).
 *
 * A module says in its manifest which services it provides, each with a descriptor (`services`); a
 * consumer asks the host and never names the provider. This host names no module either: the answer is
 * read off the last sweep's manifests.
 *
 * A provider is IN USE when it is registered here and answering — its presence from the last sweep is
 * `ready`, so its manifest was read. Asked about a kehikko, each provider also says whether it is placed
 * there, and placed ones come first; a machine-wide service is in use whatever is placed.
 */

/** One module from the last sweep, as far as services go. */
export interface ServiceModule {
  id: string
  name: string
  /** Its manifest's `services`, as the sweep carried it; absent when it provides none. */
  services?: Record<string, unknown>
}

export function providersOf(
  service: string,
  modules: Iterable<ServiceModule>,
  /** Whether a module is placed on the kehikko asked about; null when none was asked about. */
  placed: ((module: string) => boolean) | null,
): ServiceProvider[] {
  const out: ServiceProvider[] = []
  for (const one of modules) {
    const services = one.services
    if (!services || !Object.hasOwn(services, service)) continue
    out.push(serviceProviderSchema.parse({ module: one.id, name: one.name.slice(0, LIMITS.TITLE), descriptor: services[service] ?? null, placed: placed ? placed(one.id) : null }))
  }
  /* Placed first; otherwise by id, so the answer does not depend on the order of a sweep. */
  out.sort((a, b) => Number(b.placed === true) - Number(a.placed === true) || a.module.localeCompare(b.module))
  return out.slice(0, LIMITS.SERVICE_PROVIDERS)
}
