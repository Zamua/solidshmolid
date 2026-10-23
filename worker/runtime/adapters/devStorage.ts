// A stand-in storage provider for local development and tests: consent is
// granted on the spot, and a pod's files go to its own SQLite (DevFileStore).
// LOCAL DEVELOPMENT ONLY, like DevFileStore.

import type { Grant, StorageAuthorization } from '../../app/storage/ports.js';
import type { Refresher } from './linkTokens.js';

export const DEV_PROVIDER = 'dev';

export const devAuthorization: StorageAuthorization = {
  provider: DEV_PROVIDER,
  pkce: async () => ({ verifier: 'dev', challenge: 'dev' }),
  authorizeUrl: (redirectUri, state) => `${redirectUri}?${new URLSearchParams({ code: 'dev', state })}`,
  exchange: async (): Promise<Grant> => ({ refreshToken: 'dev', accountId: 'dev', accessToken: 'dev', expiresAt: Number.MAX_SAFE_INTEGER }),
};

export const devRefresher: Refresher = async () => ({ token: 'dev', expiresAt: Number.MAX_SAFE_INTEGER });
