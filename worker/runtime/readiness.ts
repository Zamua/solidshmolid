// Whether a deployment has what it needs to serve: keys present and well
// formed, and every storage provider it offers connectable. Names what is
// wrong, never a value.

import { isDev, storageAuthorizations, storageProviders, tokenSigner } from './composition.js';
import type { Env } from './env.js';

/** What is missing or malformed, by name; empty when the deployment is ready. */
export async function unready(env: Env): Promise<string[]> {
  const problems: string[] = [];
  if (!isDev(env)) {
    if (!sealingKeyFits(env.TOKEN_KEY)) problems.push('TOKEN_KEY');
    if (!env.CLERK_PUBLISHABLE_KEY || !env.CLERK_SECRET_KEY) problems.push('Clerk keys');
  }
  try {
    await tokenSigner(env);
  } catch {
    problems.push('OIDC_SIGNING_JWK');
  }
  try {
    if (storageProviders(env).length === 0) problems.push('STORAGE');
    storageAuthorizations(env);
  } catch {
    problems.push('STORAGE');
  }
  return problems;
}

/** AES-256-GCM takes 32 bytes, base64 in the variable. */
function sealingKeyFits(key: string | undefined): boolean {
  try {
    return atob(key ?? '').length === 32;
  } catch {
    return false;
  }
}
