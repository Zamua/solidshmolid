// The service's URLs, on the scheme and port the apex was reached on, so the
// dev server (http, :8787) and deployments derive them the same way.

import type { Env } from './env.js';

export interface Hosts {
  /** The identity provider, with a trailing slash. */
  issuer: string;
  /** A pod's origin, no trailing slash. */
  podOrigin(handle: string): string;
  webidOf(handle: string): string;
}

export function hostsFor(env: Env, apex: URL): Hosts {
  const port = apex.port ? `:${apex.port}` : '';
  const podOrigin = (handle: string) => `${apex.protocol}//${env.POD_HOST_TEMPLATE.replace('{handle}', handle)}${port}`;
  return {
    issuer: `${apex.protocol}//${env.APEX_HOST}${port}/`,
    podOrigin,
    webidOf: (handle) => `${podOrigin(handle)}/profile/card#me`,
  };
}
