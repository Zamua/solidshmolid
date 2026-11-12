// The service's URLs, on the scheme and port the apex was reached on, so the
// dev server (http, :8787) and deployments derive them the same way.

import { isPodId } from '../domain/accounts/podIds.js';
import { handleFromHost } from '../domain/pods/handles.js';
import { webidAt } from '../domain/pods/profile.js';
import type { Env } from './env.js';

export interface Hosts {
  /** The identity provider, with a trailing slash. */
  issuer: string;
  /** A pod's origin, no trailing slash. */
  podOrigin(handle: string): string;
  webidOf(handle: string): string;
  /** The pod a WebID lives in when this service hosts it, else null. */
  podOfWebid(webid: string): string | null;
}

export function hostsFor(env: Env, apex: URL): Hosts {
  const port = apex.port ? `:${apex.port}` : '';
  const podOrigin = (handle: string) => `${apex.protocol}//${env.POD_HOST_TEMPLATE.replace('{handle}', handle)}${port}`;
  const webidOf = (handle: string) => webidAt(podOrigin(handle));
  return {
    issuer: `${apex.protocol}//${env.APEX_HOST}${port}/`,
    podOrigin,
    webidOf,
    podOfWebid: (webid) => {
      if (!URL.canParse(webid)) return null;
      const handle = handleFromHost(new URL(webid).hostname, env.POD_HOST_TEMPLATE);
      return handle !== null && isPodId(handle) && webidOf(handle) === webid ? handle : null;
    },
  };
}
