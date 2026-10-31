import { describe, expect, it } from 'vitest';
import { METHODS } from '../domain/pods/methods.js';
import { handleSolid } from '../runtime/http/solid.js';
import { ALICE, BASE, newPod } from './support/fakes.js';

const alice = { webid: ALICE };

async function send(pod: Awaited<ReturnType<typeof newPod>>['pod'], method: string, path: string, init: RequestInit = {}) {
  return handleSolid(pod, new Request(`${BASE}${path}`, { method, ...init }), alice);
}

describe('Allow', () => {
  it('names the same methods on OPTIONS and on every 405', async () => {
    const { pod } = await newPod();
    await send(pod, 'PUT', '/c/');
    await send(pod, 'PUT', '/a.txt', { body: 'x', headers: { 'Content-Type': 'text/plain' } });
    for (const path of ['/', '/c/', '/a.txt']) {
      const allow = (await send(pod, 'OPTIONS', path)).headers.get('Allow')!;
      for (const method of METHODS.filter((m) => !allow.split(', ').includes(m))) {
        const res = await send(pod, method, path, { headers: { 'Content-Type': 'text/n3' } });
        expect([path, method, res.status]).toEqual([path, method, 405]);
        expect(res.headers.get('Allow')).toBe(allow);
      }
    }
  });

  it('never offers DELETE on the root', async () => {
    const { pod } = await newPod();
    for (const method of ['OPTIONS', 'GET', 'PATCH']) {
      expect((await send(pod, method, '/', { headers: { 'Content-Type': 'text/n3' } })).headers.get('Allow')).not.toContain('DELETE');
    }
  });
});
