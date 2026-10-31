// FileStore over Google Drive (API v3) with the drive.file scope.
//
// That scope shows the app only the files it created, so every pod lives in
// a "solidshmolid" folder of My Drive that this adapter makes, and a file put
// there by hand stays invisible. Drive addresses files by id and lets a folder
// hold several files of one name: paths resolve through a map of the pod
// folder's tree (DriveNodes), and of same-named files the oldest wins. Drive
// has no conditional upload, so a revision precondition is checked just
// before writing; the pod's write queue makes that exact for its own writes.

import { InsufficientStorage, StorageUnavailable } from '../../app/shared/errors.js';
import { type ByteRange, type FileInfo, type FileLister, type FileStore, type ListedEntry, type Listing, RevisionConflict, type StoredFile, type WriteOptions } from '../../app/storage/ports.js';
import { chunked } from './chunks.js';
import { type Fetch, withAccessToken } from './http.js';
import { randomHex } from './system.js';
import { type DriveNode, type DriveNodes, descendants, placedPathOf } from './driveNodes.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,mimeType,parents,trashed,version,size,modifiedTime';
/** Upload piece size; resumable uploads take multiples of 256 KiB. */
export const DRIVE_CHUNK = 8 * 1024 * 1024;
/** The My Drive folder holding every pod, found by this app property. */
export const APP_FOLDER = { name: 'solidshmolid', key: 'solidshmolid', value: 'pods' };
const RETRIES = 3;

export interface DriveDeps {
  fetch: Fetch;
  /** A current access token; `refresh` asks for a new one after a 401. */
  accessToken: (refresh: boolean) => Promise<string>;
  nodes: DriveNodes;
  /** The pod's folder inside the app folder; '' for the app folder itself. */
  root?: string;
  sleep?: (ms: number) => Promise<void>;
  /** Upload piece size; tests shrink it. */
  chunkSize?: number;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  trashed?: boolean;
  version?: string;
  size?: string;
  modifiedTime?: string;
}

interface Change {
  fileId: string;
  removed?: boolean;
  file?: DriveFile;
}

export class DriveFileStore implements FileStore, FileLister {
  private readonly nodes: DriveNodes;
  private readonly root: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly chunkSize: number;

  constructor(private readonly deps: DriveDeps) {
    this.nodes = deps.nodes;
    this.root = (deps.root ?? '').replace(/^\/+|\/+$/gu, '');
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.chunkSize = deps.chunkSize ?? DRIVE_CHUNK;
  }

  async read(file: string, range?: ByteRange): Promise<StoredFile | null> {
    const found = await this.find(file);
    if (!found || found.mimeType === FOLDER) return null;
    const res = await this.call(`${API}/files/${found.id}?alt=media`, { headers: range ? { Range: `bytes=${range.start}-${range.end}` } : {} });
    if (res.status === 404) {
      this.nodes.forget(found.id);
      return null;
    }
    await ensureOk(res, 'download');
    return { body: res.body ?? new Response('').body!, size: Number(found.size ?? 0), rev: found.version ?? '' };
  }

  async write(file: string, body: ReadableStream<Uint8Array> | Uint8Array, options: WriteOptions = {}): Promise<FileInfo> {
    const segments = segmentsOf(file);
    const name = segments.pop()!;
    const parent = await this.folderAt(segments, true);
    const current = await this.lookup(parent!, name);
    if (current?.mimeType === FOLDER) throw new RevisionConflict(`${file} is a folder`);
    if (options.ifRev === null && current) throw new RevisionConflict(`${file} exists`);
    if (typeof options.ifRev === 'string' && current?.version !== options.ifRev) throw new RevisionConflict(`${file} changed`);
    const target = { id: current?.id ?? null, parent: parent!, name };
    const saved = body instanceof Uint8Array ? await this.upload(target, body) : await this.uploadStream(target, body);
    this.remember(saved, parent!);
    return { file, rev: saved.version ?? '', size: Number(saved.size ?? 0), modified: saved.modifiedTime ?? new Date().toISOString() };
  }

  async remove(file: string): Promise<void> {
    const found = await this.find(file);
    if (found && found.mimeType !== FOLDER) await this.trash(found.id);
  }

  async makeFolder(folder: string): Promise<void> {
    await this.folderAt(segmentsOf(folder), true);
  }

  async removeFolder(folder: string): Promise<void> {
    const segments = segmentsOf(folder);
    if (segments.length === 0) throw new Error('refusing to delete the pod folder');
    const found = await this.find(folder);
    if (found?.mimeType === FOLDER) await this.trash(found.id);
  }

  async listAll(): Promise<Listing> {
    // The feed starts before the walk, so nothing done during it is missed.
    const { startPageToken } = (await this.json(`${API}/changes/startPageToken?fields=startPageToken`)) as { startPageToken: string };
    const root = await this.rootId(false);
    if (!root) return { entries: [], cursor: startPageToken };
    for (const child of this.nodes.children(root)) this.nodes.forget(child.id);
    return { entries: await this.walk(root), cursor: startPageToken };
  }

  async changes(cursor: string): Promise<Listing> {
    const changes: Change[] = [];
    let token = cursor;
    for (;;) {
      const q = new URLSearchParams({
        pageToken: token,
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS}))`,
        includeRemoved: 'true',
        spaces: 'drive',
        pageSize: '1000',
      });
      const page = (await this.json(`${API}/changes?${q}`)) as { changes: Change[]; nextPageToken?: string; newStartPageToken?: string };
      changes.push(...page.changes);
      if (page.newStartPageToken) return { entries: await this.fold(changes), cursor: page.newStartPageToken };
      token = page.nextPageToken!;
    }
  }

  // ---- paths and ids ---------------------------------------------------------

  /** The live file at `path`, fetched fresh; null when there is none. */
  private async find(path: string): Promise<DriveFile | null> {
    const segments = segmentsOf(path);
    const name = segments.pop();
    const parent = await this.folderAt(segments, false);
    if (!parent) return null;
    if (name === undefined) return this.metadata(parent);
    return this.lookup(parent, name);
  }

  /** The id of the folder at `segments` below the root; made when `create`. */
  private async folderAt(segments: string[], create: boolean): Promise<string | null> {
    let id = await this.rootId(create);
    for (const name of segments) {
      if (!id) return null;
      const known = this.nodes.child(id, name);
      if (known?.folder) {
        id = known.id;
        continue;
      }
      const found = await this.lookup(id, name);
      if (found?.mimeType === FOLDER) id = found.id;
      else if (found) throw new RevisionConflict(`${name} is a file, not a folder`);
      else id = create ? this.remember(await this.createFolder(id, name), id).id : null;
    }
    return id;
  }

  /** The oldest live file called `name` in `parent`, asked of Drive. */
  private async lookup(parent: string, name: string): Promise<DriveFile | null> {
    const q = `'${parent}' in parents and name = '${quote(name)}' and trashed = false`;
    const [found] = await this.query(q, 1);
    if (found) this.remember(found, parent);
    else {
      const stale = this.nodes.child(parent, name);
      if (stale) this.nodes.forget(stale.id);
    }
    return found ?? null;
  }

  /** The pod folder's id; made (with the app folder) when `create`. */
  private async rootId(create: boolean): Promise<string | null> {
    const known = this.nodes.root();
    if (known) return known;
    const mark = `appProperties has { key='${APP_FOLDER.key}' and value='${APP_FOLDER.value}' }`;
    let [app] = await this.query(`${mark} and mimeType = '${FOLDER}' and trashed = false`, 1);
    if (!app) {
      if (!create) return null;
      app = await this.createFolder(null, APP_FOLDER.name, { [APP_FOLDER.key]: APP_FOLDER.value });
    }
    let root = app.id;
    if (this.root) {
      const [pod] = await this.query(`'${app.id}' in parents and name = '${quote(this.root)}' and mimeType = '${FOLDER}' and trashed = false`, 1);
      if (pod) root = pod.id;
      else if (create) root = (await this.createFolder(app.id, this.root)).id;
      else return null;
    }
    this.nodes.setRoot(root);
    return root;
  }

  private remember(file: DriveFile, parent: string): DriveNode {
    const node = nodeOf(file, parent);
    this.nodes.put(node);
    return node;
  }

  /** Every file and folder below `id`, oldest first among same names. */
  private async walk(id: string): Promise<ListedEntry[]> {
    const entries: ListedEntry[] = [];
    const queue = [id];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      for (const f of await this.query(`'${parent}' in parents and trashed = false`)) {
        if (this.nodes.child(parent, f.name) || !isContent(f)) continue;
        const node = this.remember(f, parent);
        entries.push(entryOf(node, placedPathOf(this.nodes, node.id)));
        if (node.folder) queue.push(node.id);
      }
    }
    return entries;
  }

  /** The change feed as path entries. Parents can arrive after children, so
   * changes that do not place yet wait for a later pass. */
  private async fold(changes: Change[]): Promise<ListedEntry[]> {
    const out: ListedEntry[] = [];
    let pending = changes;
    for (let progress = true; progress && pending.length > 0; ) {
      progress = false;
      const later: Change[] = [];
      for (const change of pending) {
        if (await this.foldOne(change, out)) progress = true;
        else later.push(change);
      }
      pending = later;
    }
    return out;
  }

  /** Applies one change to the tree; false when it cannot be placed yet. */
  private async foldOne(change: Change, out: ListedEntry[]): Promise<boolean> {
    const root = this.nodes.root();
    if (!root) return true;
    const known = this.nodes.get(change.fileId);
    const f = change.file;
    const parent = f?.parents?.[0];
    const live = !change.removed && f !== undefined && !f.trashed && parent !== undefined && isContent(f);
    if (change.fileId === root) {
      if (live) return true;
      for (const child of this.nodes.children(root)) out.push(deletedAt(placedPathOf(this.nodes, child.id)));
      this.nodes.forget(root);
      return true;
    }
    const placed = live && (parent === root || this.nodes.get(parent)?.folder === true);
    if (!placed) {
      if (known && known.parent !== null) {
        out.push(deletedAt(placedPathOf(this.nodes, known.id)));
        this.nodes.forget(known.id);
        return true;
      }
      // Perhaps under a folder a later change brings in; else not this pod's.
      return !live;
    }
    const twin = this.nodes.child(parent, f.name);
    if (twin && twin.id !== change.fileId) {
      // The older same-named file keeps the path.
      if (known) {
        out.push(deletedAt(placedPathOf(this.nodes, known.id)));
        this.nodes.forget(known.id);
      }
      return true;
    }
    const moved = known !== null && (known.parent !== parent || known.name !== f.name);
    // Already known as it is: this adapter's own write, or a walk took it in.
    if (known && !moved && (known.folder || known.version === (f.version ?? null))) return true;
    if (moved) out.push(deletedAt(placedPathOf(this.nodes, known.id)));
    const node = this.remember(f, parent);
    out.push(entryOf(node, placedPathOf(this.nodes, node.id)));
    if (node.folder) {
      if (known) for (const d of descendants(this.nodes, node.id)) out.push(entryOf(d, placedPathOf(this.nodes, d.id)));
      else out.push(...(await this.walk(node.id)));
    }
    return true;
  }

  // ---- Drive calls -------------------------------------------------------------

  private async metadata(id: string): Promise<DriveFile | null> {
    const res = await this.call(`${API}/files/${id}?fields=${FIELDS}`);
    if (res.status === 404) return null;
    await ensureOk(res, 'files.get');
    const f = (await res.json()) as DriveFile;
    return f.trashed ? null : f;
  }

  private async query(q: string, limit = Infinity): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q, fields: `nextPageToken,files(${FIELDS})`, orderBy: 'createdTime', spaces: 'drive', pageSize: String(Math.min(limit, 1000)) });
      if (pageToken) params.set('pageToken', pageToken);
      const page = (await this.json(`${API}/files?${params}`)) as { files: DriveFile[]; nextPageToken?: string };
      out.push(...page.files);
      pageToken = page.nextPageToken;
    } while (pageToken && out.length < limit);
    return out.slice(0, limit);
  }

  private async createFolder(parent: string | null, name: string, appProperties?: Record<string, string>): Promise<DriveFile> {
    const body = { name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}), ...(appProperties ? { appProperties } : {}) };
    const res = await this.call(`${API}/files?fields=${FIELDS}`, { method: 'POST', json: body });
    await ensureOk(res, 'create folder');
    return (await res.json()) as DriveFile;
  }

  /** Moves a file or folder to Drive's trash, where the person can still
   * restore it; a missing one is already gone. */
  private async trash(id: string): Promise<void> {
    const res = await this.call(`${API}/files/${id}?fields=id`, { method: 'PATCH', json: { trashed: true } });
    if (res.status !== 404) await ensureOk(res, 'trash');
    this.nodes.forget(id);
  }

  private async upload(target: UploadTarget, bytes: Uint8Array): Promise<DriveFile> {
    if (target.id) {
      return this.uploadResult(await this.call(`${UPLOAD}/files/${target.id}?uploadType=media&fields=${FIELDS}`, { method: 'PATCH', body: bytes }));
    }
    const boundary = `solidshmolid${randomHex()}`;
    const head = new TextEncoder().encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: target.name, parents: [target.parent] })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.byteLength + bytes.byteLength + tail.byteLength);
    body.set(head);
    body.set(bytes, head.byteLength);
    body.set(tail, head.byteLength + bytes.byteLength);
    return this.uploadResult(
      await this.call(`${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, { method: 'POST', body, contentType: `multipart/related; boundary=${boundary}` }),
    );
  }

  /** Streams in fixed pieces through a resumable session, so a large body is
   * never held whole. */
  private async uploadStream(target: UploadTarget, stream: ReadableStream<Uint8Array>): Promise<DriveFile> {
    const pieces = chunked(stream, this.chunkSize);
    const first = await pieces.next();
    let piece = first.done ? new Uint8Array() : first.value;
    let next = await pieces.next();
    if (next.done) return this.upload(target, piece);

    const start = target.id
      ? await this.call(`${UPLOAD}/files/${target.id}?uploadType=resumable&fields=${FIELDS}`, { method: 'PATCH', json: {} })
      : await this.call(`${UPLOAD}/files?uploadType=resumable&fields=${FIELDS}`, { method: 'POST', json: { name: target.name, parents: [target.parent] } });
    await ensureOk(start, 'start upload');
    const session = start.headers.get('Location');
    if (!session) throw new StorageUnavailable('Google Drive did not open an upload session');
    let offset = 0;
    for (;;) {
      const last = next.done === true;
      const end = offset + piece.byteLength;
      const res = await this.call(session, {
        method: 'PUT',
        body: piece,
        headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${last ? end : '*'}` },
      });
      if (last) return this.uploadResult(res);
      if (res.status !== 308) await ensureOk(res, 'upload');
      offset = end;
      piece = next.value as Uint8Array;
      next = await pieces.next();
    }
  }

  private async uploadResult(res: Response): Promise<DriveFile> {
    await ensureOk(res, 'upload');
    return (await res.json()) as DriveFile;
  }

  private async json(url: string): Promise<unknown> {
    const res = await this.call(url);
    await ensureOk(res, url.slice(API.length).split('?')[0]!);
    return res.json();
  }

  /** One call, retried a few times when Drive asks to slow down (it has not
   * acted on those). */
  private async call(url: string, request: CallRequest = {}): Promise<Response> {
    const send = async (token: string) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...(request.headers ?? {}) };
      let body: BodyInit | undefined;
      if (request.json !== undefined) {
        headers['Content-Type'] = 'application/json; charset=UTF-8';
        body = JSON.stringify(request.json);
      } else if (request.body !== undefined) {
        headers['Content-Type'] = request.contentType ?? 'application/octet-stream';
        body = request.body;
      }
      return this.deps.fetch(url, { method: request.method ?? 'GET', headers, body });
    };
    for (let attempt = 0; ; attempt++) {
      const res = await withAccessToken(this.deps.accessToken, send);
      if (attempt >= RETRIES || !(await isSlowDown(res))) return res;
      const wait = Number(res.headers.get('Retry-After') ?? '1');
      await this.sleep(Math.min(Number.isFinite(wait) ? wait : 1, 5) * 1000 * (attempt + 1));
    }
  }
}

interface UploadTarget {
  /** The file to replace; null makes a new one. */
  id: string | null;
  parent: string;
  name: string;
}

interface CallRequest {
  method?: string;
  json?: unknown;
  body?: Uint8Array;
  contentType?: string;
  headers?: Record<string, string>;
}

/** A folder-relative path ('a/b.ttl', 'a/', '') as its names. */
export function segmentsOf(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}

/** A string literal for Drive's query language. */
export function quote(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

/** Folders and stored bytes; Google's own documents have no bytes to serve. */
function isContent(f: DriveFile): boolean {
  return f.mimeType === FOLDER || !f.mimeType.startsWith('application/vnd.google-apps.');
}

function nodeOf(f: DriveFile, parent: string): DriveNode {
  const folder = f.mimeType === FOLDER;
  return {
    id: f.id,
    parent,
    name: f.name,
    folder,
    version: folder ? null : (f.version ?? null),
    size: folder ? 0 : Number(f.size ?? 0),
    modified: folder ? null : (f.modifiedTime ?? null),
  };
}

function entryOf(node: DriveNode, path: string): ListedEntry {
  return node.folder ? { kind: 'folder', path } : { kind: 'file', path, rev: node.version ?? '', size: node.size, modified: node.modified };
}

function deletedAt(path: string): ListedEntry {
  return { kind: 'deleted', path: path.replace(/\/$/u, '') };
}

async function isSlowDown(res: Response): Promise<boolean> {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  return /rateLimitExceeded|userRateLimitExceeded/u.test(await res.clone().text());
}

async function ensureOk(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  const text = await res.text().catch(() => '');
  let reason = '';
  let message = text.slice(0, 200);
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; errors?: { reason?: string }[] } };
    reason = parsed.error?.errors?.[0]?.reason ?? '';
    message = parsed.error?.message ?? message;
  } catch {
    // not JSON; keep the text
  }
  if (res.status === 401) throw new StorageUnavailable('the Google Drive link was revoked or expired; reconnect Google Drive');
  if (reason === 'storageQuotaExceeded') throw new InsufficientStorage('the Google Drive account is full');
  if (res.status === 429 || res.status >= 500 || /rateLimitExceeded/u.test(reason)) {
    const retry = Number(res.headers.get('Retry-After'));
    throw new StorageUnavailable(`Google Drive ${what}: ${message}`, Number.isFinite(retry) ? retry : null);
  }
  throw new StorageUnavailable(`Google Drive ${what} failed (${res.status}): ${message}`);
}
