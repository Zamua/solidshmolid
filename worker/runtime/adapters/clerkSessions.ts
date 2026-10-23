// Clerk behind the Sessions port: verifies the session token (cookie or
// bearer) against the instance's keys, and on a page load whose short-lived
// token has expired answers with Clerk's handshake redirect to refresh it.

import { type ClerkClient, createClerkClient } from '@clerk/backend';
import { SIGNED_OUT, type SessionCheck, type Sessions } from './sessions.js';

export interface ClerkKeys {
  publishableKey: string;
  secretKey: string;
}

export class ClerkSessions implements Sessions {
  private readonly clerk: ClerkClient;

  constructor(
    keys: ClerkKeys,
    /** Origins whose pages may present a session (the apex). */
    private readonly authorizedParties: string[],
  ) {
    this.clerk = createClerkClient(keys);
  }

  async check(request: Request): Promise<SessionCheck> {
    const state = await this.clerk.authenticateRequest(request, { authorizedParties: this.authorizedParties });
    const headers = [...state.headers.keys()].length > 0 ? state.headers : null;
    if (state.status === 'handshake' || state.headers.get('Location')) {
      return { person: null, redirect: new Response(null, { status: 307, headers: state.headers }), headers: null };
    }
    if (state.isAuthenticated) return { person: state.toAuth().userId, redirect: null, headers };
    return { ...SIGNED_OUT, headers };
  }
}

/** The instance's Frontend API host, which a publishable key encodes
 * (`pk_test_<base64 of "host$">`). */
export function frontendApiOf(publishableKey: string): string {
  const encoded = publishableKey.split('_')[2] ?? '';
  const host = atob(encoded).replace(/\$$/u, '');
  if (!/^[a-z0-9.-]+$/u.test(host)) throw new Error('not a Clerk publishable key');
  return host;
}
