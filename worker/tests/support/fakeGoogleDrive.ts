// An in-memory stand-in for the Google Drive API v3 calls the adapter makes,
// with the behaviors that matter: files by id, same-named siblings, versions,
// the trash, the queries the adapter sends, multipart and resumable uploads,
// Range downloads, the change feed, short-lived tokens and rate limiting.

const FOLDER = 'application/vnd.google-apps.folder';

interface File {
  id: string;
  name: string;
  mimeType: string;
  parent: string | null;
  trashed: boolean;
  version: number;
  bytes: Uint8Array;
  created: number;
  modified: string;
  appProperties: Record<string, string>;
}

export class FakeGoogleDrive {
  private readonly byId = new Map<string, File>();
  private readonly sessions = new Map<string, { target: { id: string | null; name?: string; parent?: string }; parts: Uint8Array[] }>();
  /** File ids in the order they changed; a change token is an index here. */
  private readonly log: string[] = [];
  private counter = 0;
  validToken = 'tok1';
  /** Remaining calls to answer with 403 userRateLimitExceeded. */
  rateLimited = 0;
  /** Bytes the account may still store. */
  freeSpace = Infinity;
  readonly calls: string[] = [];

  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    this.calls.push(`${method} ${url.pathname}`);
    const headers = new Headers(init.headers);
    if (headers.get('Authorization') !== `Bearer ${this.validToken}`) return error(401, 'authError', 'Invalid Credentials');
    if (this.rateLimited > 0) {
      this.rateLimited--;
      return error(403, 'userRateLimitExceeded', 'User rate limit exceeded.');
    }
    const body = init.body instanceof Uint8Array ? init.body : typeof init.body === 'string' ? new TextEncoder().encode(init.body) : new Uint8Array();
    const p = url.pathname;

    if (url.host === 'upload.fake') return this.resume(p.split('/').pop()!, headers.get('Content-Range')!, body);
    if (p === '/drive/v3/changes/startPageToken') return json({ startPageToken: String(this.log.length) });
    if (p === '/drive/v3/changes') return this.changes(url.searchParams);
    if (p === '/drive/v3/files' && method === 'GET') return this.list(url.searchParams);
    if (p === '/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(new TextDecoder().decode(body)) as Meta;
      return json(this.view(this.create(meta, new Uint8Array())));
    }
    const fileId = /^\/drive\/v3\/files\/([^/]+)$/u.exec(p)?.[1];
    if (fileId) {
      const f = this.byId.get(fileId);
      if (!f) return error(404, 'notFound', `File not found: ${fileId}.`);
      if (method === 'PATCH') {
        const meta = JSON.parse(new TextDecoder().decode(body)) as { trashed?: boolean };
        if (meta.trashed) this.trashTree(f);
        return json(this.view(f));
      }
      if (url.searchParams.get('alt') === 'media') return this.download(f, headers.get('Range'));
      return json(this.view(f));
    }
    if (p === '/upload/drive/v3/files' && method === 'POST') {
      const type = url.searchParams.get('uploadType');
      if (type === 'multipart') {
        const { meta, bytes } = multipart(body, headers.get('Content-Type')!);
        if (!this.fits(bytes.byteLength)) return error(403, 'storageQuotaExceeded', 'The user has exceeded their Drive storage quota');
        return json(this.view(this.create(meta, bytes)));
      }
      const meta = JSON.parse(new TextDecoder().decode(body)) as Meta;
      return this.openSession({ id: null, name: meta.name, parent: meta.parents?.[0] });
    }
    const uploadId = /^\/upload\/drive\/v3\/files\/([^/]+)$/u.exec(p)?.[1];
    if (uploadId && method === 'PATCH') {
      const f = this.byId.get(uploadId);
      if (!f) return error(404, 'notFound', `File not found: ${uploadId}.`);
      if (url.searchParams.get('uploadType') === 'resumable') return this.openSession({ id: uploadId });
      if (!this.fits(body.byteLength)) return error(403, 'storageQuotaExceeded', 'The user has exceeded their Drive storage quota');
      this.setBytes(f, body);
      return json(this.view(f));
    }
    return error(400, 'badRequest', `unexpected ${method} ${p}`);
  };

  // ---- out-of-band edits, as the person in Drive's own UI would make ------------

  /** The id at `path`, a '/'-joined path from My Drive ('solidshmolid/p1/a.txt'). */
  idAt(path: string): string | null {
    let parent: string | null = null;
    let found: File | undefined;
    for (const name of path.split('/').filter(Boolean)) {
      found = this.siblings(parent).find((f) => f.name === name);
      if (!found) return null;
      parent = found.id;
    }
    return found?.id ?? null;
  }

  editOutOfBand(path: string, text: string): void {
    this.setBytes(this.byId.get(this.idAt(path)!)!, new TextEncoder().encode(text));
  }

  trashOutOfBand(path: string): void {
    this.trashTree(this.byId.get(this.idAt(path)!)!);
  }

  renameOutOfBand(path: string, name: string): void {
    const f = this.byId.get(this.idAt(path)!)!;
    f.name = name;
    this.touch(f);
  }

  /** A file this app made at `parentPath`, regardless of names already there. */
  createOutOfBand(parentPath: string, name: string, text: string, mimeType = 'text/plain'): string {
    const parent = parentPath ? this.idAt(parentPath) : null;
    return this.create({ name, mimeType, parents: parent ? [parent] : undefined }, new TextEncoder().encode(text)).id;
  }

  /** Every live file's text by path from My Drive. */
  files(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of this.byId.values()) {
      if (f.trashed || f.mimeType === FOLDER) continue;
      out[this.pathOf(f)] = new TextDecoder().decode(f.bytes);
    }
    return out;
  }

  // ---- internals ------------------------------------------------------------------

  private list(params: URLSearchParams): Response {
    const q = params.get('q') ?? '';
    const parent = /'([^']+)' in parents/u.exec(q)?.[1];
    const name = /name = '((?:[^'\\]|\\.)*)'/u.exec(q)?.[1]?.replace(/\\(.)/gu, '$1');
    const mime = /mimeType = '([^']+)'/u.exec(q)?.[1];
    const prop = /appProperties has \{ key='([^']+)' and value='([^']+)' \}/u.exec(q);
    const matches = [...this.byId.values()]
      .filter((f) => !/trashed = false/u.test(q) || !f.trashed)
      .filter((f) => parent === undefined || f.parent === parent)
      .filter((f) => name === undefined || f.name === name)
      .filter((f) => mime === undefined || f.mimeType === mime)
      .filter((f) => !prop || f.appProperties[prop[1]!] === prop[2])
      .sort((a, b) => a.created - b.created);
    const size = Number(params.get('pageSize') ?? '100');
    const start = Number(params.get('pageToken') ?? '0');
    const page = matches.slice(start, start + size);
    return json({ files: page.map((f) => this.view(f)), ...(start + size < matches.length ? { nextPageToken: String(start + size) } : {}) });
  }

  private changes(params: URLSearchParams): Response {
    const start = Number(params.get('pageToken'));
    const size = Number(params.get('pageSize') ?? '100');
    const slice = this.log.slice(start, start + size);
    // Each file once per page, at its latest state.
    const ids = slice.filter((id, i) => slice.lastIndexOf(id) === i);
    const changes = ids.map((id) => {
      const f = this.byId.get(id);
      return f ? { fileId: id, removed: false, file: this.view(f) } : { fileId: id, removed: true };
    });
    const end = start + slice.length;
    return json({ changes, ...(end < this.log.length ? { nextPageToken: String(end) } : { newStartPageToken: String(end) }) });
  }

  private download(f: File, range: string | null): Response {
    if (f.mimeType === FOLDER) return error(403, 'fileNotDownloadable', 'Only files with binary content can be downloaded.');
    const m = range ? /^bytes=(\d+)-(\d+)$/u.exec(range) : null;
    if (!m) return new Response(f.bytes.slice(), { status: 200 });
    return new Response(f.bytes.slice(Number(m[1]), Number(m[2]) + 1), { status: 206 });
  }

  private openSession(target: { id: string | null; name?: string; parent?: string }): Response {
    const id = `s${++this.counter}`;
    this.sessions.set(id, { target, parts: [] });
    return new Response(null, { status: 200, headers: { Location: `https://upload.fake/session/${id}` } });
  }

  private resume(sessionId: string, range: string, body: Uint8Array): Response {
    const session = this.sessions.get(sessionId)!;
    const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(range)!;
    if (Number(m[1]) !== total(session.parts)) return error(400, 'badRequest', 'out of order');
    session.parts.push(body);
    if (m[3] === '*') return new Response(null, { status: 308 });
    const bytes = concat(session.parts);
    if (bytes.byteLength !== Number(m[3])) return error(400, 'badRequest', 'size mismatch');
    if (!this.fits(bytes.byteLength)) return error(403, 'storageQuotaExceeded', 'The user has exceeded their Drive storage quota');
    const { target } = session;
    if (target.id) {
      const f = this.byId.get(target.id)!;
      this.setBytes(f, bytes);
      return json(this.view(f));
    }
    return json(this.view(this.create({ name: target.name!, parents: target.parent ? [target.parent] : undefined }, bytes)));
  }

  private create(meta: Meta, bytes: Uint8Array): File {
    const f: File = {
      id: `f${++this.counter}`,
      name: meta.name,
      mimeType: meta.mimeType ?? 'application/octet-stream',
      parent: meta.parents?.[0] ?? null,
      trashed: false,
      version: 1,
      bytes,
      created: this.counter,
      modified: new Date(Date.UTC(2026, 9, 23, 0, 0, this.counter)).toISOString(),
      appProperties: meta.appProperties ?? {},
    };
    this.byId.set(f.id, f);
    this.log.push(f.id);
    return f;
  }

  private setBytes(f: File, bytes: Uint8Array): void {
    f.bytes = bytes;
    this.touch(f);
  }

  private touch(f: File): void {
    f.version++;
    f.modified = new Date(Date.UTC(2026, 9, 23, 0, 0, ++this.counter)).toISOString();
    this.log.push(f.id);
  }

  private trashTree(f: File): void {
    f.trashed = true;
    this.touch(f);
    for (const child of this.siblings(f.id)) if (!child.trashed) this.trashTree(child);
  }

  private siblings(parent: string | null): File[] {
    return [...this.byId.values()].filter((f) => f.parent === parent && !f.trashed).sort((a, b) => a.created - b.created);
  }

  private pathOf(f: File): string {
    const names = [f.name];
    for (let p = f.parent; p; p = this.byId.get(p)!.parent) names.unshift(this.byId.get(p)!.name);
    return names.join('/');
  }

  private fits(size: number): boolean {
    if (size > this.freeSpace) return false;
    this.freeSpace -= size;
    return true;
  }

  private view(f: File) {
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      parents: f.parent ? [f.parent] : ['myDriveRoot'],
      trashed: f.trashed,
      version: String(f.version),
      ...(f.mimeType === FOLDER ? {} : { size: String(f.bytes.byteLength) }),
      modifiedTime: f.modified,
    };
  }
}

interface Meta {
  name: string;
  mimeType?: string;
  parents?: string[];
  appProperties?: Record<string, string>;
}

function multipart(body: Uint8Array, contentType: string): { meta: Meta; bytes: Uint8Array } {
  const boundary = /boundary=(\S+)/u.exec(contentType)![1]!;
  const text = new TextDecoder('latin1').decode(body);
  const parts = text.split(`--${boundary}`).slice(1, -1);
  // latin1 keeps one character per byte, so text offsets are byte offsets.
  const [metaPart, dataPart] = parts.map((part) => part.slice(part.indexOf('\r\n\r\n') + 4, -2));
  const metaStart = text.indexOf(metaPart!);
  const start = text.indexOf(dataPart!, metaStart + metaPart!.length);
  const meta = JSON.parse(new TextDecoder().decode(body.slice(metaStart, metaStart + metaPart!.length))) as Meta;
  return { meta, bytes: body.slice(start, start + dataPart!.length) };
}

function total(parts: Uint8Array[]): number {
  return parts.reduce((n, p) => n + p.byteLength, 0);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(total(parts));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function error(status: number, reason: string, message: string): Response {
  return json({ error: { code: status, message, errors: [{ reason, message }] } }, status);
}
