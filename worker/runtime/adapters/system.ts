// The platform's clock and randomness behind the app's ports.

import type { Clock, Secrets } from '../../app/identity/ports.js';

/** 32 random hex digits: ids, nonces, account keys. */
export const randomHex = (): string => crypto.randomUUID().replaceAll('-', '');

export const systemClock: Clock = { now: () => Math.floor(Date.now() / 1000) };

export const webCryptoSecrets: Secrets = {
  random: randomHex,
  async hash(secret) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
    return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
  },
};
