// The write queue is held for what the storage does, never for a sender: a
// body arrives before the queue is taken, and a long one goes to the storage
// between two short turns in it.

import { describe, expect, it, vi } from 'vitest';
import { Conflict, RequestTimeout, StorageUnavailable } from '../app/shared/errors.js';
import { paced, readAhead, readAll } from '../app/shared/streams.js';
import type { Agent, ReadOptions } from '../app/pods/pod.js';
import { RevisionConflict } from '../app/storage/ports.js';
import { NO_CONDITIONS } from '../domain/pods/requests.js';
import { MemoryDriveNodes } from '../runtime/adapters/driveNodes.js';
import { DropboxFileStore } from '../runtime/adapters/dropbox.js';
import { DriveFileStore } from '../runtime/adapters/googleDrive.js';
import { deadlined } from '../runtime/adapters/http.js';
import { handleSolid } from '../runtime/http/solid.js';
import { FakeDropbox } from './support/fakeDropbox.js';
import { FakeGoogleDrive } from './support/fakeGoogleDrive.js';
import { ALICE, BASE, newPod, streamOf, textOf } from './support/fakes.js';

const alice: Agent = { webid: ALICE };
const GET: ReadOptions = { accept: null, range: null, head: false };
const body = (s: string) => ({ stream: streamOf(s) });
const LONG = 'L'.repeat(1024 * 1024 + 10);

/** A body whose bytes arrive when the test says so. */
function gated() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  return {
    stream,
    send: (s: string) => controller.enqueue(new TextEncoder().encode(s)),
    end: () => controller.close(),
  };
}
const settle = () => new Promise((r) => setTimeout(r, 5));
const read = async (pod: Awaited<ReturnType<typeof newPod>>['pod'], path: string) => textOf((await pod.read(path, alice, GET)).body);

describe('a body that is slow to arrive', () => {
  it('does not keep other writes waiting, RDF or not', async () => {
    const { pod } = await newPod();
    for (const type of ['text/turtle', 'text/plain']) {
      const slow = gated();
      const first = pod.put('/slow', alice, { stream: slow.stream }, type, NO_CONDITIONS);
      await pod.put('/quick.txt', alice, body('quick'), 'text/plain', NO_CONDITIONS);
      expect(await read(pod, '/quick.txt')).toBe('quick');
      slow.send('<#a> <#b> "c".');
      slow.end();
      await first;
      expect(await read(pod, '/slow')).toContain('<#a>');
    }
  });

  it('is not read at all for a write that is not allowed', async () => {
    const { pod } = await newPod();
    const never = gated();
    await expect(pod.put('/x.txt', { webid: null }, { stream: never.stream }, 'text/plain', NO_CONDITIONS)).rejects.toThrow();
    expect(never.stream.locked).toBe(false);
  });
});

describe('a body too long to hold', () => {
  it('goes to storage outside the queue, and is the document once it has all arrived', async () => {
    const { pod, files } = await newPod();
    const long = gated();
    long.send(LONG);
    const put = pod.put('/deep/er/big.bin', alice, { stream: long.stream }, 'application/octet-stream', NO_CONDITIONS);
    await settle();
    // The queue is free while the rest is on its way, and nothing is served half-written.
    await pod.put('/other.txt', alice, body('other'), 'text/plain', NO_CONDITIONS);
    expect(files.files.has('deep/er/big.bin')).toBe(false);
    await expect(pod.read('/deep/er/big.bin', alice, GET)).rejects.toThrow();
    long.send('tail');
    long.end();
    expect(await put).toEqual({ path: '/deep/er/big.bin', created: true });
    expect(await read(pod, '/deep/er/big.bin')).toBe(`${LONG}tail`);
    expect(await read(pod, '/deep/er/')).toContain('<big.bin>');
  });

  it('replaces a document, and says it did', async () => {
    const { pod } = await newPod();
    await pod.put('/a.bin', alice, body('old'), 'application/octet-stream', NO_CONDITIONS);
    expect(await pod.put('/a.bin', alice, body(LONG), 'application/octet-stream', NO_CONDITIONS)).toEqual({ path: '/a.bin', created: false });
    expect((await read(pod, '/a.bin')).length).toBe(LONG.length);
  });

  it('loses to a write that reached the same resource meanwhile', async () => {
    const { pod } = await newPod();
    const long = gated();
    long.send(LONG);
    const put = pod.put('/a.bin', alice, { stream: long.stream }, 'application/octet-stream', NO_CONDITIONS);
    await settle();
    await pod.put('/a.bin', alice, body('short'), 'application/octet-stream', NO_CONDITIONS);
    long.end();
    await expect(put).rejects.toThrow(Conflict);
    expect(await read(pod, '/a.bin')).toBe('short');
  });

  it('is a conflict when its container went away meanwhile', async () => {
    const { pod } = await newPod();
    const long = gated();
    long.send(LONG);
    const put = pod.put('/gone/a.bin', alice, { stream: long.stream }, 'application/octet-stream', NO_CONDITIONS);
    await settle();
    await pod.remove('/gone/', alice, NO_CONDITIONS);
    long.end();
    await expect(put).rejects.toThrow(Conflict);
  });

  it('keeps the name a POST chose from another POST', async () => {
    const { pod } = await newPod();
    const long = gated();
    long.send(LONG);
    const first = pod.post('/', alice, { stream: long.stream }, 'application/octet-stream', 'report', false);
    await settle();
    const second = await pod.post('/', alice, body('second'), 'text/plain', 'report', false);
    long.end();
    const done = await first;
    expect(done.path).not.toBe(second.path);
    expect((await read(pod, done.path)).length).toBe(LONG.length);
    expect(await read(pod, second.path)).toBe('second');
  });

  it('leaves the queue and the name free when the body fails', async () => {
    const { pod } = await newPod();
    const broken = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(LONG));
      },
      pull() {
        throw new RequestTimeout('the request body stopped arriving');
      },
    });
    await expect(pod.post('/', alice, { stream: broken }, 'application/octet-stream', 'report', false)).rejects.toThrow(RequestTimeout);
    expect((await pod.post('/', alice, body('x'), 'text/plain', 'report', false)).path).toBe('/report');
  });
});

describe('a body that stops arriving', () => {
  it('is given up after the wait, and read through when it keeps coming', async () => {
    vi.useFakeTimers();
    try {
      const stalled = gated();
      stalled.send('some');
      const reading = readAll(paced(stalled.stream, 1000, () => new RequestTimeout('stopped')), 100).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await reading).toBeInstanceOf(RequestTimeout);

      const steady = gated();
      const whole = readAll(paced(steady.stream, 1000, () => new RequestTimeout('stopped')), 100);
      for (const part of ['a', 'b', 'c']) {
        await vi.advanceTimersByTimeAsync(900);
        steady.send(part);
      }
      steady.end();
      expect(new TextDecoder().decode(await whole)).toBe('abc');
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers 408', async () => {
    const { pod } = await newPod();
    const failing = { ...pod, put: async () => Promise.reject(new RequestTimeout('the request body stopped arriving')) } as unknown as typeof pod;
    Object.setPrototypeOf(failing, Object.getPrototypeOf(pod));
    const res = await handleSolid(failing, new Request(`${BASE}/a.txt`, { method: 'PUT', body: 'x', headers: { 'Content-Type': 'text/plain' } }), alice);
    expect(res.status).toBe(408);
  });
});

describe('readAhead', () => {
  it('gives a short body whole and a long one as a stream of all of it', async () => {
    expect(await readAhead(streamOf('short'), 10)).toEqual({ head: new TextEncoder().encode('short'), rest: null });
    const { rest } = await readAhead(streamOf('0123456789abcdef'), 10);
    expect(await textOf(rest)).toBe('0123456789abcdef');
  });
});

describe('a storage call that does not answer', () => {
  const hung = (_: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));

  it('is given up as unavailable storage', async () => {
    const fetcher = deadlined(hung, 10, () => new StorageUnavailable('the storage did not answer in time'));
    await expect(fetcher('https://storage.example/')).rejects.toThrow(StorageUnavailable);
  });

  it('is left alone when it answers, and its own failure is passed on', async () => {
    const answered = deadlined(async () => new Response('ok'), 10, () => new Error('late'));
    const res = await answered('https://storage.example/');
    await settle();
    await settle();
    expect(await res.text()).toBe('ok');
    const failing = deadlined(async () => Promise.reject(new TypeError('network')), 10, () => new Error('late'));
    await expect(failing('https://storage.example/')).rejects.toThrow(TypeError);
  });
});

describe('an upload in three steps', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  const dropbox = (chunkSize: number) => {
    const fake = new FakeDropbox();
    return { fake, files: new DropboxFileStore({ fetch: fake.fetch, accessToken: async () => fake.validToken, sleep: async () => {}, chunkSize }) };
  };
  const drive = (chunkSize: number) => {
    const fake = new FakeGoogleDrive();
    return { fake, files: new DriveFileStore({ fetch: fake.fetch, accessToken: async () => fake.validToken, nodes: new MemoryDriveNodes(), root: 'pod1', sleep: async () => {}, chunkSize }) };
  };

  it.each([
    ['Dropbox, in pieces', () => dropbox(4), '/big.bin'],
    ['Dropbox, in one call', () => dropbox(64), '/big.bin'],
    ['Google Drive, in pieces', () => drive(4), 'solidshmolid/pod1/big.bin'],
    ['Google Drive, in one call', () => drive(64), 'solidshmolid/pod1/big.bin'],
  ] as const)('%s: shows nothing until it is finished', async (_name, make, stored) => {
    const { fake, files } = make();
    const upload = await files.begin('big.bin', { ifRev: null });
    await upload.send(streamOf('abcdefghijklmnopqrstuvwxyz'));
    expect(fake.files()[stored]).toBeUndefined();
    const info = await upload.finish();
    expect(fake.files()[stored]).toBe('abcdefghijklmnopqrstuvwxyz');
    expect(info.size).toBe(26);
    expect((await files.read('big.bin'))?.rev).toBe(info.rev);
  });

  it.each([
    ['Dropbox', () => dropbox(4)],
    ['Google Drive', () => drive(4)],
  ] as const)('%s: does not finish over a file written meanwhile', async (_name, make) => {
    const { files } = make();
    const first = await files.write('a.bin', bytes('one'), { ifRev: null });
    const replacing = await files.begin('a.bin', { ifRev: first.rev });
    await replacing.send(streamOf('abcdefghij'));
    await files.write('a.bin', bytes('two'));
    await expect(replacing.finish()).rejects.toThrow(RevisionConflict);
    expect(await textOf((await files.read('a.bin'))!.body)).toBe('two');

    const creating = await files.begin('new.bin', { ifRev: null });
    await creating.send(streamOf('abcdefghij'));
    await files.write('new.bin', bytes('theirs'));
    await expect(creating.finish()).rejects.toThrow(RevisionConflict);
    expect(await textOf((await files.read('new.bin'))!.body)).toBe('theirs');
  });
});
