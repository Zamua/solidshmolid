// The folder is the pod: a stock Community Solid Server pointed at the folder
// we wrote must serve the same resources, members and access decisions.
//
// Needs CSS installed somewhere; `make compat` sets COMPAT_CSS_BIN to its
// bin/server.js. Skipped otherwise. (Not CSS_*: CSS reads every CSS_* variable
// as a command-line option.)

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PodError } from '../app/shared/errors.js';
import { type Agent, Pod } from '../app/pods/pod.js';
import { NO_CONDITIONS } from '../domain/pods/requests.js';
import { bareType } from '../domain/shared/mediaTypes.js';
import { profileDocument } from '../domain/pods/profile.js';
import { parseRdf, serializeRdf } from '../domain/shared/rdf.js';
import { LDP } from '../domain/shared/vocab.js';
import { DirFileStore } from './support/dirFiles.js';
import { CSS_BIN, type RunningCss, freePort, startCss, startCssOn } from './support/css.js';
import { sqliteIndex, streamOf, textOf } from './support/fakes.js';

const CONFIG = new URL('./compat/css-file-root.json', import.meta.url).pathname;
const BOB = 'https://bob.example/profile/card#me';

const DOCUMENTS: [path: string, type: string, body: string][] = [
  ['/notes/a.ttl', 'text/turtle', '<#a> <http://example.org/p> "café"; <http://example.org/q> <b.txt>.'],
  ['/notes/b.txt', 'text/plain', 'hello\n'],
  ['/data.json', 'application/ld+json', '{"@id":"http://example.org/x","http://example.org/p":"v"}'],
  ['/photo', 'image/png', '\u0089PNG fake'],
  ['/blob', 'application/x-solidshmolid-test', 'opaque'],
  ['/my%20notes/caf%C3%A9.ttl', 'text/turtle', '<#x> <http://example.org/p> 1.'],
  ['/a%3Ab.txt', 'text/plain', 'colon'],
  ['/shared/doc.txt', 'text/plain', 'for bob'],
];

const CONTAINERS = ['/', '/notes/', '/shared/', '/my%20notes/', '/profile/'];

function status(e: unknown): number {
  const name = e instanceof PodError ? e.name : '';
  return { Unauthenticated: 401, Forbidden: 403, NotFound: 404 }[name] ?? 500;
}

describe.skipIf(!CSS_BIN)('a stock CSS serves the folder we wrote', () => {
  let dir: string;
  let base: string;
  let css: RunningCss;
  let pod: Pod;
  let alice: Agent;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'solidshmolid-compat-'));
    const port = await freePort();
    base = `http://localhost:${port}`;
    alice = { webid: `${base}/profile/card#me` };
    let id = 0;
    pod = new Pod({ index: sqliteIndex(), files: new DirFileStore(dir), base, now: () => new Date(), newId: () => `n${++id}` });
    await pod.provision(alice.webid!, profileDocument(`${base}/`, null));
    for (const [path, type, body] of DOCUMENTS) await pod.put(path, alice, { stream: streamOf(body) }, type, NO_CONDITIONS);
    await pod.put(
      '/shared/.acl',
      alice,
      {
        stream: streamOf(`@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#owner> a acl:Authorization; acl:agent <${alice.webid}>; acl:accessTo <./>; acl:default <./>; acl:mode acl:Read, acl:Write, acl:Control.
<#bob> a acl:Authorization; acl:agent <${BOB}>; acl:accessTo <./>; acl:default <./>; acl:mode acl:Read.`),
      },
      'text/turtle',
      NO_CONDITIONS,
    );

    css = await startCssOn(port, ['-c', CONFIG, '-f', dir], 'profile/card');
  }, 90_000);

  afterAll(async () => {
    css?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const theirs = (path: string, agent: Agent | null, accept?: string) =>
    fetch(`${base}${path}`, {
      headers: { ...(agent?.webid ? { Authorization: `WebID ${agent.webid}` } : {}), ...(accept ? { Accept: accept } : {}) },
    });

  const triples = async (text: string, type: string, at: string) =>
    (await serializeRdf(await parseRdf(text, type, at), 'application/n-triples')).trim().split('\n').sort();

  it('serves every document with our type and content', async () => {
    for (const [path, type] of [...DOCUMENTS.map(([p, t]) => [p, t] as const), ['/profile/card', 'text/turtle'] as const]) {
      const ours = await pod.read(path, alice, { accept: type, range: null, head: false });
      const ourText = await textOf(ours.body);
      const res = await theirs(path, alice, type);
      expect(res.status, path).toBe(200);
      expect(bareType(res.headers.get('Content-Type') ?? ''), path).toBe(bareType(ours.contentType));
      const theirText = await res.text();
      if (type === 'text/turtle') expect(await triples(theirText, type, `${base}${path}`), path).toEqual(await triples(ourText, type, `${base}${path}`));
      else if (type === 'application/ld+json') expect(JSON.parse(theirText), path).toEqual(JSON.parse(ourText));
      else expect(theirText, path).toBe(ourText);
    }
  });

  it('lists the same container members', async () => {
    const members = async (text: string, at: string) =>
      (await parseRdf(text, 'text/turtle', at))
        .filter((q) => q.predicate.value === LDP('contains'))
        .map((q) => q.object.value)
        .sort();
    for (const path of CONTAINERS) {
      const ours = await pod.read(path, alice, { accept: 'text/turtle', range: null, head: false });
      const res = await theirs(path, alice, 'text/turtle');
      expect(res.status, path).toBe(200);
      // CSS lists a file whose name holds an escaped character (`a%3Ab.txt`)
      // with the escape encoded again (`a%253Ab.txt`), though it serves the
      // canonical URL; undo that one step before comparing.
      const listed = (await members(await res.text(), `${base}${path}`)).map((u) => u.replace(/%25(3A|3C|3E|22|7C|3F|2A|25)/giu, '%$1'));
      expect(listed, path).toEqual(await members(await textOf(ours.body), `${base}${path}`));
    }
  });

  it('makes the same access decisions', async () => {
    const bob: Agent = { webid: BOB };
    const cases: [Agent | null, string][] = [
      [null, '/profile/card'],
      [null, '/'],
      [null, '/notes/a.ttl'],
      [bob, '/shared/doc.txt'],
      [bob, '/shared/'],
      [bob, '/notes/a.ttl'],
      [bob, '/shared/.acl'],
      [alice, '/shared/.acl'],
    ];
    for (const [agent, path] of cases) {
      const ourStatus = await pod.read(path, agent ?? { webid: null }, { accept: null, range: null, head: false }).then(
        () => 200,
        status,
      );
      const res = await theirs(path, agent);
      expect(res.status, `${agent?.webid ?? 'anonymous'} ${path}`).toBe(ourStatus);
    }
  });
});

describe.skipIf(!CSS_BIN)('we adopt a folder a stock CSS wrote', () => {
  const INIT_CONFIG = new URL('./compat/css-file-root-init.json', import.meta.url).pathname;
  const WRITES: [path: string, type: string, body: string][] = [
    ['/notes/a.ttl', 'text/turtle', '<#a> <http://example.org/p> "café".'],
    ['/notes/b.txt', 'text/plain', 'hello\n'],
    ['/data.json', 'application/ld+json', '{"@id":"http://example.org/x","http://example.org/p":"v"}'],
    ['/odd', 'application/x-solidshmolid-test', 'opaque'],
    ['/my%20notes/caf%C3%A9.ttl', 'text/turtle', '<#x> <http://example.org/p> 1.'],
  ];
  const READS = [...WRITES.map(([p]) => p), '/', '/notes/', '/my%20notes/'];
  let dir: string;
  let base: string;
  const seen = new Map<string, { type: string; body: string }>();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'solidshmolid-adopt-'));
    const css = await startCss(['-c', INIT_CONFIG, '-f', dir], '');
    base = css.base.replace(/\/$/u, '');
    try {
      for (const [path, type, text] of WRITES) {
        const res = await fetch(`${base}${path}`, { method: 'PUT', headers: { 'Content-Type': type }, body: text });
        expect(res.status, path).toBeLessThan(300);
      }
      for (const path of READS) {
        const res = await fetch(`${base}${path}`, { headers: { Accept: path.endsWith('/') ? 'text/turtle' : '*/*' } });
        seen.set(path, { type: bareType(res.headers.get('Content-Type') ?? ''), body: await res.text() });
      }
    } finally {
      css.stop();
    }
  }, 90_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('serves every resource CSS held, with the same type, content and members', async () => {
    const files = new DirFileStore(dir);
    let id = 0;
    const pod = new Pod({ index: sqliteIndex(), files, base, now: () => new Date(), newId: () => `a${++id}` });
    const report = await pod.adopt('https://owner.example/#me', await files.listing());
    expect(report.skipped).toEqual([]);
    const contains = async (text: string, at: string) =>
      (await parseRdf(text, 'text/turtle', at)).filter((q) => q.predicate.value === LDP('contains')).map((q) => q.object.value).sort();
    for (const path of READS) {
      const ours = await pod.read(path, { webid: null }, { accept: path.endsWith('/') ? 'text/turtle' : null, range: null, head: false });
      const theirs = seen.get(path)!;
      expect(bareType(ours.contentType), path).toBe(theirs.type);
      const text = await textOf(ours.body);
      if (path.endsWith('/')) expect(await contains(text, `${base}${path}`), path).toEqual(await contains(theirs.body, `${base}${path}`));
      else expect(text, path).toBe(theirs.body);
    }
  });
});
