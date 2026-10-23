import { describe, expect, it } from 'vitest';
import {
  clientSite,
  OidcError,
  PUBLIC_CLIENT,
  accessTokenClaims,
  clientFromDocument,
  discovery,
  idTokenClaims,
  parseAuthorizeRequest,
  pkceMatches,
  publicClient,
  redirectAllowed,
} from '../domain/identity/oidc.js';

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

const params = (over: Record<string, string | null> = {}) => {
  const base: Record<string, string | null> = {
    response_type: 'code',
    client_id: 'https://app.example/id',
    redirect_uri: 'https://app.example/cb',
    scope: 'openid webid offline_access',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 's1',
    ...over,
  };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) if (v !== null) q.set(k, v);
  return q;
};

describe('discovery', () => {
  it('advertises Solid-OIDC and PKCE-only code flow', () => {
    const d = discovery('https://pods.example');
    expect(d.issuer).toBe('https://pods.example/');
    expect(d.solid_oidc_supported).toBe('https://solidproject.org/TR/solid-oidc');
    expect(d.code_challenge_methods_supported).toEqual(['S256']);
    expect(d.token_endpoint).toBe('https://pods.example/.oidc/token');
  });
});

describe('authorize requests', () => {
  it('accepts a proper request', () => {
    expect(parseAuthorizeRequest(params())).toMatchObject({ clientId: 'https://app.example/id', scopes: ['openid', 'webid', 'offline_access'] });
  });

  it.each([
    ['plain PKCE', { code_challenge_method: 'plain' }, 'invalid_request'],
    ['no PKCE', { code_challenge: null }, 'invalid_request'],
    ['implicit flow', { response_type: 'token' }, 'unsupported_response_type'],
    ['no webid scope', { scope: 'openid' }, 'invalid_scope'],
    ['no client', { client_id: null }, 'invalid_request'],
  ])('refuses %s', (_l, over, code) => {
    try {
      parseAuthorizeRequest(params(over));
      expect.unreachable();
    } catch (e) {
      expect((e as OidcError).code).toBe(code);
    }
  });
});

describe('clients and redirects', () => {
  const doc = { client_id: 'https://app.example/id', client_name: 'Sketchpad', redirect_uris: ['https://app.example/cb'] };

  it('reads a Client ID Document that names itself', () => {
    expect(clientFromDocument('https://app.example/id', doc)).toMatchObject({ name: 'Sketchpad', redirectUris: ['https://app.example/cb'] });
    expect(() => clientFromDocument('https://other.example/id', doc)).toThrow(OidcError);
    expect(() => clientFromDocument('https://app.example/id', { ...doc, redirect_uris: [] })).toThrow(OidcError);
  });

  it('matches registered redirects exactly', () => {
    const c = clientFromDocument('https://app.example/id', doc);
    expect(redirectAllowed(c, 'https://app.example/cb')).toBe(true);
    expect(redirectAllowed(c, 'https://app.example/cb/')).toBe(false);
    expect(redirectAllowed(c, 'https://app.example/cb?x=1')).toBe(false);
  });

  it('lets the public client use https or loopback only', () => {
    const c = publicClient();
    expect(c.clientId).toBe(PUBLIC_CLIENT);
    expect(redirectAllowed(c, 'https://any.example/cb')).toBe(true);
    expect(redirectAllowed(c, 'http://localhost:3000/cb')).toBe(true);
    expect(redirectAllowed(c, 'http://evil.example/cb')).toBe(false);
    expect(redirectAllowed(c, 'https://any.example/cb#frag')).toBe(false);
    expect(redirectAllowed(c, 'javascript:alert(1)')).toBe(false);
  });
});

describe('client sites', () => {
  it('names the host people know an app by', () => {
    expect(clientSite({ clientId: 'https://app.example/id', name: 'App', redirectUris: ['https://cb.example/'], isPublic: false })).toBe('app.example');
    expect(clientSite({ clientId: 'reg_abc', name: 'Notes', redirectUris: ['https://notes.example/_solid/cb'], isPublic: false })).toBe('notes.example');
    expect(clientSite({ clientId: 'reg_abc', name: null, redirectUris: [], isPublic: false })).toBeNull();
    expect(clientSite(publicClient())).toBeNull();
  });
});

describe('PKCE', () => {
  it('matches the RFC 7636 example and nothing else', async () => {
    expect(await pkceMatches(VERIFIER, CHALLENGE)).toBe(true);
    expect(await pkceMatches(`${VERIFIER.slice(0, -1)}x`, CHALLENGE)).toBe(false);
    expect(await pkceMatches('short', CHALLENGE)).toBe(false);
  });
});

describe('token claims', () => {
  const ctx = { issuer: 'https://pods.example/', webid: 'https://sam.pods.example/profile/card#me', clientId: 'https://app.example/id', now: 1000 };

  it('binds the access token to the DPoP key and to Solid', () => {
    expect(accessTokenClaims({ ...ctx, jkt: 'thumb', jti: 'j' })).toMatchObject({
      aud: ['solid', 'https://app.example/id'],
      webid: ctx.webid,
      sub: ctx.webid,
      cnf: { jkt: 'thumb' },
      exp: 1000 + 3600,
    });
  });

  it('carries the nonce into the ID token only when given', () => {
    expect(idTokenClaims({ ...ctx, nonce: 'n' })).toMatchObject({ aud: ctx.clientId, nonce: 'n', azp: ctx.clientId });
    expect(idTokenClaims({ ...ctx, nonce: null })).not.toHaveProperty('nonce');
  });
});
