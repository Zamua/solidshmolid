// Pod handles and the hostnames that carry them.

const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;

/** Names that stay free for the service itself. `stg-` belongs to staging,
 * whose pod hosts share the production domain. */
const RESERVED = new Set(['www', 'api', 'id', 'idp', 'auth', 'login', 'admin', 'mail', 'stg', 'staging', 'status', 'static', 'app']);

export function isValidHandle(handle: string): boolean {
  return HANDLE.test(handle) && !handle.includes('--') && !RESERVED.has(handle) && !handle.startsWith('stg-');
}

/** The handle a pod hostname carries under `template` ('{handle}.example.com',
 * 'stg-{handle}.example.com'), or null when the host is not a pod host. */
export function handleFromHost(hostname: string, template: string): string | null {
  const at = template.indexOf('{handle}');
  if (at < 0) throw new Error('POD_HOST_TEMPLATE must contain {handle}');
  const prefix = template.slice(0, at).toLowerCase();
  const suffix = template.slice(at + '{handle}'.length).toLowerCase();
  const host = hostname.toLowerCase();
  if (!host.startsWith(prefix) || !host.endsWith(suffix) || host.length <= prefix.length + suffix.length) return null;
  const handle = host.slice(prefix.length, host.length - suffix.length);
  return isValidHandle(handle) ? handle : null;
}
