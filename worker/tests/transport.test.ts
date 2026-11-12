import { describe, expect, it } from 'vitest';
import { httpsRedirect, untransformed, withHsts } from '../runtime/http/transport.js';

const redirect = (method: string, address: string) => httpsRedirect(new Request(address, { method }), new URL(address));

describe('the one address a deployment answers on', () => {
  it('leaves https at the default port alone', () => {
    expect(redirect('GET', 'https://id.example/.well-known/openid-configuration')).toBeNull();
    expect(redirect('GET', 'https://id.example:443/x')).toBeNull();
  });

  it('sends plain http to https, keeping path and query', () => {
    const response = redirect('GET', 'http://id.example/authorize?client_id=a&state=b');
    expect(response?.status).toBe(301);
    expect(response?.headers.get('Location')).toBe('https://id.example/authorize?client_id=a&state=b');
  });

  it('sends another port to the default one', () => {
    const response = redirect('HEAD', 'https://abcd1234.pods.example:8443/profile/card');
    expect(response?.status).toBe(301);
    expect(response?.headers.get('Location')).toBe('https://abcd1234.pods.example/profile/card');
  });

  it('keeps the method of a write with 308', () => {
    for (const method of ['PUT', 'POST', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(redirect(method, 'http://abcd1234.pods.example/notes/a.ttl')?.status, method).toBe(308);
    }
  });

  it('adds HSTS without disturbing the response', async () => {
    const response = withHsts(new Response('body', { status: 404, headers: { ETag: '"1"' } }));
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect(response.status).toBe(404);
    expect(response.headers.get('ETag')).toBe('"1"');
    expect(await response.text()).toBe('body');
  });
});

describe('bodies no proxy may rewrite', () => {
  const cache = (headers: Record<string, string>) => untransformed(new Response('body', { headers })).headers.get('Cache-Control');

  it('says so on every response, beside what the response already says about caching', () => {
    expect(cache({})).toBe('no-transform');
    expect(cache({ 'Cache-Control': 'no-store' })).toBe('no-store, no-transform');
    expect(cache({ 'Cache-Control': 'private, no-cache' })).toBe('private, no-cache, no-transform');
    expect(cache({ 'Cache-Control': 'public, No-Transform' })).toBe('public, No-Transform');
  });

  it('keeps the status, the other headers and the body', async () => {
    const response = untransformed(new Response('body', { status: 404, headers: { ETag: '"1"' } }));
    expect([response.status, response.headers.get('ETag'), await response.text()]).toEqual([404, '"1"', 'body']);
  });
});
