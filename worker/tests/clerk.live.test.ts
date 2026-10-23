// Against a running dev server and the real Clerk dev instance: a throwaway
// Clerk user signs in with a sign-in token (as a device-setup QR code would),
// and the Worker accepts the resulting session token for signup and storage.
// `make clerk-live` runs it; it needs the dev instance's keys.

import { afterAll, describe, expect, it } from 'vitest';
import { frontendApiOf } from '../runtime/adapters/clerkSessions.js';

const APEX = process.env.CLERK_LIVE_APEX?.replace(/\/$/u, '');
const SECRET = process.env.CLERK_SECRET_KEY;
const PUBLISHABLE = process.env.CLERK_PUBLISHABLE_KEY;
const live = Boolean(APEX && SECRET && PUBLISHABLE);

async function bapi(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.clerk.com/v1${path}`, { ...init, headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' } });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${path}: ${JSON.stringify(body)}`);
  return body;
}

/** Signs in with a ticket through the Frontend API, as clerk-js on our pages
 * would; the Origin becomes the token's authorized party (`azp`). */
async function sessionToken(ticket: string, origin = APEX!): Promise<string> {
  const fapi = `https://${frontendApiOf(PUBLISHABLE!)}`;
  const dev = (await (await fetch(`${fapi}/v1/dev_browser`, { method: 'POST', headers: { origin } })).json()) as { token: string };
  const res = await fetch(`${fapi}/v1/client/sign_ins?__clerk_db_jwt=${dev.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', origin },
    body: new URLSearchParams({ strategy: 'ticket', ticket }),
  });
  const body = (await res.json()) as { client?: { sessions?: { last_active_token?: { jwt?: string } }[] } };
  const jwt = body.client?.sessions?.[0]?.last_active_token?.jwt;
  if (!jwt) throw new Error(`no session from ticket sign-in: ${res.status}`);
  return jwt;
}

describe.skipIf(!live)('Clerk sign-in', () => {
  const made: string[] = [];
  afterAll(async () => {
    for (const id of made) await bapi(`/users/${id}`, { method: 'DELETE' });
  });

  it('accepts a Clerk session for signup, and only once per ticket', async () => {
    const user = await bapi('/users', { method: 'POST', body: JSON.stringify({ username: `live${Date.now()}`, skip_password_requirement: true }) });
    made.push(String(user.id));
    const { token: ticket } = (await bapi('/sign_in_tokens', { method: 'POST', body: JSON.stringify({ user_id: user.id, expires_in_seconds: 300 }) })) as { token: string };
    const jwt = await sessionToken(ticket);
    await expect(sessionToken(ticket)).rejects.toThrow();

    const auth = { authorization: `Bearer ${jwt}` };
    expect((await fetch(`${APEX}/api/me`)).status).toBe(401);
    expect((await fetch(`${APEX}/api/me`, { headers: { authorization: 'Bearer not-a-token' } })).status).toBe(401);
    const signup = await fetch(`${APEX}/api/signup`, { method: 'POST', headers: { ...auth, origin: APEX! } });
    expect(signup.status).toBe(201);
    const me = (await (await fetch(`${APEX}/api/me`, { headers: auth })).json()) as { person: string; household: { pods: unknown[] } };
    expect(me.person).toBe(user.id);
    expect(me.household.pods).toHaveLength(1);
  });

  it('refuses a session minted for another site, such as a pod', async () => {
    const user = await bapi('/users', { method: 'POST', body: JSON.stringify({ username: `live${Date.now()}x`, skip_password_requirement: true }) });
    made.push(String(user.id));
    const { token: ticket } = (await bapi('/sign_in_tokens', { method: 'POST', body: JSON.stringify({ user_id: user.id, expires_in_seconds: 300 }) })) as { token: string };
    const jwt = await sessionToken(ticket, 'http://abcdefgh.localhost:8787');
    expect((await fetch(`${APEX}/api/me`, { headers: { authorization: `Bearer ${jwt}` } })).status).toBe(401);
  });
});
