import { describe, expect, it } from 'vitest';
import { frontendApiOf } from '../runtime/adapters/clerkSessions.js';
import { SIGNED_OUT, type Sessions, devSessions, firstOf } from '../runtime/adapters/sessions.js';

const withCookie = (cookie: string) => new Request('http://localhost/', { headers: { cookie } });

describe('sessions', () => {
  it('reads the dev sign-in cookie, and nothing else', async () => {
    expect((await devSessions.check(withCookie('a=1; dev_person=dana'))).person).toBe('dana');
    expect((await devSessions.check(withCookie('dev_person=da;na'))).person).toBe('da');
    expect(await devSessions.check(withCookie('xdev_person=dana'))).toEqual(SIGNED_OUT);
  });

  it('asks each source in turn until one knows the person or must redirect', async () => {
    const redirect = new Response(null, { status: 307 });
    const fixed = (answer: Partial<typeof SIGNED_OUT>): Sessions => ({ check: async () => ({ ...SIGNED_OUT, ...answer }) });
    expect((await firstOf(fixed({}), fixed({ person: 'p2' })).check(withCookie(''))).person).toBe('p2');
    expect((await firstOf(fixed({ person: 'p1' }), fixed({ person: 'p2' })).check(withCookie(''))).person).toBe('p1');
    expect((await firstOf(fixed({ redirect }), fixed({ person: 'p2' })).check(withCookie(''))).redirect).toBe(redirect);
    const headers = new Headers({ 'set-cookie': 'x=1' });
    expect((await firstOf(fixed({}), fixed({ headers })).check(withCookie(''))).headers).toBe(headers);
  });

  it('finds the Frontend API host inside a publishable key', () => {
    expect(frontendApiOf(`pk_test_${btoa('quiet-otter-12.clerk.accounts.dev$')}`)).toBe('quiet-otter-12.clerk.accounts.dev');
    expect(frontendApiOf(`pk_live_${btoa('clerk.example.com$')}`)).toBe('clerk.example.com');
    expect(() => frontendApiOf(`pk_test_${btoa('evil.com/"><script>$')}`)).toThrow();
  });
});
