// FileStore over a Dropbox App folder (API v2).
//
// Paths are relative to the app folder, which Dropbox maps to
// `Apps/<app name>/` in the user's account; this adapter never sees anything
// outside it. Dropbox serializes writes per account and answers contention
// with 429 `too_many_write_operations`, so writes retry briefly here; the pod's
// own write queue keeps contention from our side to one request at a time.

import { InsufficientStorage, StorageUnavailable } from '../../app/shared/errors.js';
import { type ByteRange, type FileInfo, type FileLister, type FileStore, type ListedEntry, type Listing, RevisionConflict, type StoredFile, type WriteOptions } from '../../app/storage/ports.js';
import { chunked } from './chunks.js';
import { type Fetch, withAccessToken } from './http.js';

const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
/** Bodies up to this size go in one upload call; larger ones in a session. */
export const CHUNK = 8 * 1024 * 1024;
const WRITE_RETRIES = 3;

export interface DropboxDeps {
  fetch: Fetch;
  /** A current access token; `refresh` asks for a new one after a 401. */
  accessToken: (refresh: boolean) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  /** Upload piece size; tests shrink it. */
  chunkSize?: number;
  /** A folder inside the app folder to treat as the pod folder ('' or
   * 'pods/alice'); the app folder itself by default. */
  root?: string;
}

interface Metadata {
  '.tag'?: string;
  path_display?: string;
  rev: string;
  size: number;
  server_modified: string;
}

export class DropboxFileStore implements FileStore, FileLister {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly chunkSize: number;
  private readonly root: string;

  constructor(private readonly deps: DropboxDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.chunkSize = deps.chunkSize ?? CHUNK;
    this.root = (deps.root ?? '').replace(/^\/+|\/+$/gu, '');
  }

  /** A pod-folder path as a Dropbox path. */
  private at(path: string): string {
    return dropboxPath(this.root ? `${this.root}/${path}` : path);
  }

  async read(file: string, range?: ByteRange): Promise<StoredFile | null> {
    const res = await this.call(`${CONTENT}/files/download`, {
      arg: { path: this.at(file) },
      headers: range ? { Range: `bytes=${range.start}-${range.end}` } : {},
    });
    if (res.status === 409) {
      const error = await errorSummary(res);
      if (error.includes('not_found')) return null;
      throw new StorageUnavailable(`Dropbox: ${error}`);
    }
    await this.ensureOk(res, 'download');
    const meta = JSON.parse(res.headers.get('Dropbox-API-Result') ?? '{}') as Metadata;
    return { body: res.body ?? new Response('').body!, size: meta.size, rev: meta.rev };
  }

  async write(file: string, body: ReadableStream<Uint8Array> | Uint8Array, options: WriteOptions = {}): Promise<FileInfo> {
    const mode =
      options.ifRev === undefined ? 'overwrite' : options.ifRev === null ? 'add' : { '.tag': 'update', update: options.ifRev };
    const commit = { path: this.at(file), mode, autorename: false, mute: true, strict_conflict: true };
    const meta = body instanceof Uint8Array ? await this.upload(commit, body) : await this.uploadStream(commit, body);
    return { file, rev: meta.rev, size: meta.size, modified: meta.server_modified };
  }

  async remove(file: string): Promise<void> {
    await this.deletePath(this.at(file));
  }

  async makeFolder(folder: string): Promise<void> {
    const path = this.at(folder);
    if (path === '') return;
    const res = await this.writeCall(`${API}/files/create_folder_v2`, { json: { path, autorename: false } });
    if (res.status === 409 && (await errorSummary(res)).includes('conflict')) return;
    await this.ensureOk(res, 'create_folder');
  }

  async removeFolder(folder: string): Promise<void> {
    const path = this.at(folder);
    if (path === this.at('')) throw new Error('refusing to delete the pod folder');
    await this.deletePath(path);
  }

  async listAll(): Promise<Listing> {
    return this.listPages(`${API}/files/list_folder`, { path: this.at(''), recursive: true, include_deleted: false });
  }

  async changes(cursor: string): Promise<Listing> {
    return this.listPages(`${API}/files/list_folder/continue`, { cursor });
  }

  // ---- internals ------------------------------------------------------------

  private async upload(commit: object, bytes: Uint8Array): Promise<Metadata> {
    const res = await this.writeCall(`${CONTENT}/files/upload`, { arg: commit, body: bytes });
    return this.uploadResult(res);
  }

  /** Streams in CHUNK-sized pieces, so a large body is never held whole. */
  private async uploadStream(commit: object, stream: ReadableStream<Uint8Array>): Promise<Metadata> {
    const chunks = chunked(stream, this.chunkSize);
    const first = await chunks.next();
    const head = first.done ? new Uint8Array() : first.value;
    let next = await chunks.next();
    if (next.done) return this.upload(commit, head);

    const start = await this.writeCall(`${CONTENT}/files/upload_session/start`, { arg: { close: false }, body: head });
    await this.ensureOk(start, 'upload_session/start');
    const { session_id: sessionId } = (await start.json()) as { session_id: string };
    let offset = head.byteLength;
    while (!next.done) {
      const chunk = next.value;
      const res = await this.writeCall(`${CONTENT}/files/upload_session/append_v2`, {
        arg: { cursor: { session_id: sessionId, offset }, close: false },
        body: chunk,
      });
      await this.ensureOk(res, 'upload_session/append');
      offset += chunk.byteLength;
      next = await chunks.next();
    }
    const finish = await this.writeCall(`${CONTENT}/files/upload_session/finish`, {
      arg: { cursor: { session_id: sessionId, offset }, commit },
      body: new Uint8Array(),
    });
    return this.uploadResult(finish);
  }

  private async uploadResult(res: Response): Promise<Metadata> {
    if (res.status === 409) {
      const error = await errorSummary(res);
      if (error.includes('conflict')) throw new RevisionConflict(error);
      if (error.includes('insufficient_space')) throw new InsufficientStorage('the Dropbox account is full');
      throw new StorageUnavailable(`Dropbox: ${error}`);
    }
    await this.ensureOk(res, 'upload');
    return (await res.json()) as Metadata;
  }

  private async deletePath(path: string): Promise<void> {
    const res = await this.writeCall(`${API}/files/delete_v2`, { json: { path } });
    if (res.status === 409 && (await errorSummary(res)).includes('not_found')) return;
    await this.ensureOk(res, 'delete');
  }

  private async listPages(url: string, body: object): Promise<Listing> {
    const entries: ListedEntry[] = [];
    let page = await this.json(url, body);
    for (;;) {
      for (const e of page.entries as (Metadata & { '.tag': string; path_display: string })[]) {
        const full = e.path_display.replace(/^\//u, '');
        // Dropbox matches paths case-insensitively, and so must the prefix.
        const prefix = this.root ? `${this.root}/` : '';
        if (prefix && !full.toLowerCase().startsWith(prefix.toLowerCase())) continue;
        const path = full.slice(prefix.length);
        if (path === '') continue;
        if (e['.tag'] === 'folder') entries.push({ kind: 'folder', path: `${path}/` });
        else if (e['.tag'] === 'deleted') entries.push({ kind: 'deleted', path });
        else entries.push({ kind: 'file', path, rev: e.rev ?? '', size: e.size ?? 0, modified: e.server_modified ?? null });
      }
      if (!page.has_more) return { entries, cursor: page.cursor as string };
      page = await this.json(`${API}/files/list_folder/continue`, { cursor: page.cursor });
    }
  }

  private async json(url: string, body: object): Promise<Record<string, unknown>> {
    const res = await this.call(url, { json: body });
    await this.ensureOk(res, url.slice(url.lastIndexOf('/2/') + 3));
    return (await res.json()) as Record<string, unknown>;
  }

  /** A write, retried on Dropbox's per-account write contention. */
  private async writeCall(url: string, request: CallRequest): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.call(url, request);
      if (res.status !== 429 || attempt >= WRITE_RETRIES) return res;
      const wait = Number(res.headers.get('Retry-After') ?? '1');
      await this.sleep(Math.min(Number.isFinite(wait) ? wait : 1, 5) * 1000 * (attempt + 1));
    }
  }

  private async call(url: string, request: CallRequest): Promise<Response> {
    return withAccessToken(this.deps.accessToken, async (token) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...(request.headers ?? {}) };
      let body: BodyInit | undefined;
      if (request.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(request.json);
      } else {
        if (request.arg !== undefined) headers['Dropbox-API-Arg'] = headerJson(request.arg);
        if (request.body !== undefined) {
          headers['Content-Type'] = 'application/octet-stream';
          body = request.body;
        }
      }
      return this.deps.fetch(url, { method: 'POST', headers, body });
    });
  }

  private async ensureOk(res: Response, what: string): Promise<void> {
    if (res.ok) return;
    const detail = await errorSummary(res);
    if (res.status === 401) {
      if (detail.includes('missing_scope')) throw new StorageUnavailable(`the Dropbox app lacks a permission (${detail})`);
      throw new StorageUnavailable('the Dropbox link was revoked or expired; reconnect Dropbox');
    }
    if (res.status === 429 || res.status >= 500) {
      const retry = Number(res.headers.get('Retry-After'));
      throw new StorageUnavailable(`Dropbox ${what}: ${detail}`, Number.isFinite(retry) ? retry : null);
    }
    throw new StorageUnavailable(`Dropbox ${what} failed (${res.status}): ${detail}`);
  }
}

interface CallRequest {
  json?: unknown;
  arg?: unknown;
  body?: Uint8Array;
  headers?: Record<string, string>;
}

/** Our folder-relative paths ('a/b.ttl', 'a/') to Dropbox's ('/a/b.ttl', '/a'). */
export function dropboxPath(path: string): string {
  const trimmed = path.replace(/\/$/u, '');
  return trimmed === '' ? '' : `/${trimmed}`;
}

/** JSON for the Dropbox-API-Arg header, which must be ASCII. */
export function headerJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

async function errorSummary(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { error_summary?: string };
    return parsed.error_summary ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}
