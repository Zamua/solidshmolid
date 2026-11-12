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

describe('the storage description', () => {
  const LINK = `<${BASE}/.well-known/solid>; rel="http://www.w3.org/ns/solid/terms#storageDescription"`;

  it('is linked from every GET, HEAD and OPTIONS answer', async () => {
    const { pod } = await newPod();
    await send(pod, 'PUT', '/c/a.txt', { body: 'x', headers: { 'Content-Type': 'text/plain' } });
    for (const path of ['/', '/c/', '/c/a.txt', '/.acl', '/.well-known/solid']) {
      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        const res = await send(pod, method, path);
        expect([path, method, res.headers.get('Link')?.includes(LINK)]).toEqual([path, method, true]);
      }
    }
  });

  it('says the root is a storage, to anyone, in each RDF type', async () => {
    const { pod } = await newPod();
    const get = (accept?: string) => handleSolid(pod, new Request(`${BASE}/.well-known/solid`, { headers: accept ? { Accept: accept } : {} }), { webid: null });
    const turtle = await get();
    expect([turtle.status, turtle.headers.get('Content-Type')]).toEqual([200, 'text/turtle']);
    const triples = await get('application/n-triples');
    expect((await triples.text()).trim()).toBe(`<${BASE}/> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/ns/pim/space#Storage> .`);
    expect(JSON.stringify(await (await get('application/ld+json')).json())).toContain('http://www.w3.org/ns/pim/space#Storage');
    expect((await get('image/png')).status).toBe(406);
    const head = await handleSolid(pod, new Request(`${BASE}/.well-known/solid`, { method: 'HEAD' }), { webid: null });
    expect([head.status, await head.text(), Number(head.headers.get('Content-Length')) > 0]).toEqual([200, '', true]);
  });

  it('is written by the server alone, and keeps its name', async () => {
    const { pod, files } = await newPod();
    for (const method of ['PUT', 'POST', 'PATCH', 'DELETE']) {
      const res = await send(pod, method, '/.well-known/solid', { body: 'x', headers: { 'Content-Type': 'text/turtle' } });
      expect([method, res.status, res.headers.get('Allow')]).toEqual([method, 405, 'OPTIONS, HEAD, GET']);
    }
    await send(pod, 'PUT', '/.well-known/', {});
    const posted = await send(pod, 'POST', '/.well-known/', { body: 'x', headers: { 'Content-Type': 'text/plain', Slug: 'solid' } });
    expect(posted.status).toBe(201);
    expect(posted.headers.get('Location')).not.toBe(`${BASE}/.well-known/solid`);
    expect([...files.files.keys()].some((f) => f === '.well-known/solid')).toBe(false);
  });
});
