// PKCE (RFC 7636) for the storage providers' OAuth.

import { base64url } from '../../domain/shared/base64url.js';

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export async function pkce(): Promise<PkcePair> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64url(digest) };
}
