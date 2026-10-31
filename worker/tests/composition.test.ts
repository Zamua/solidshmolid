import { describe, expect, it } from 'vitest';
import { storageAuthorizations, storageGrants } from '../runtime/composition.js';
import type { Env } from '../runtime/env.js';

const keys = { DROPBOX_APP_KEY: 'k', GOOGLE_CLIENT_ID: 'i', GOOGLE_CLIENT_SECRET: 's' };
const env = (over: Record<string, string>) => ({ STORAGE: '', ...over }) as unknown as Env;

describe('storage providers', () => {
  it('connects each provider STORAGE names under that same name', () => {
    const auths = storageAuthorizations(env({ ...keys, STORAGE: 'dropbox, google-drive' }));
    expect(Object.keys(auths)).toEqual(['dropbox', 'google-drive']);
    for (const [name, auth] of Object.entries(auths)) expect(auth.provider).toBe(name);
  });

  it('refuses a provider the deployment cannot serve', () => {
    expect(() => storageAuthorizations(env({ STORAGE: 'dev' }))).toThrow(/cannot connect/u);
    expect(() => storageAuthorizations(env({ STORAGE: 'onedrive' }))).toThrow(/cannot connect/u);
    expect(() => storageAuthorizations(env({ STORAGE: 'dropbox' }))).toThrow(/DROPBOX_APP_KEY/u);
  });

  it('keeps grants only for providers whose keys are configured', () => {
    expect(Object.keys(storageGrants(env({ DROPBOX_APP_KEY: 'k' })))).toEqual(['dropbox']);
    expect(Object.keys(storageGrants(env({ ...keys, DEV_MODE: '1' }))).sort()).toEqual(['dev', 'dropbox', 'google-drive']);
  });
});
