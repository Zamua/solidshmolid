// An in-memory stand-in for the Dropbox API v2 endpoints the adapter uses,
// with the behaviors that matter: case-insensitive paths, revisions, strict
// conflicts, Range downloads, upload sessions, list cursors, short-lived
// access tokens and write contention.

interface Node {
  display: string;
  folder: boolean;
  bytes: Uint8Array;
  rev: string;
}

export class FakeDropbox {
  private readonly nodes = new Map<string, Node>();
  private readonly sessions = new Map<string, Uint8Array[]>();
  private readonly log: { path: string; deleted: boolean }[] = [];
  private counter = 0;
  validToken = 'tok1';
  /** Remaining calls to answer with 429 too_many_write_operations. */
  contention = 0;
  /** Bytes the account may still store. */
  freeSpace = Infinity;
  readonly calls: string[] = [];

  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const endpoint = url.pathname.replace(/^\/2\//u, '');
    this.calls.push(endpoint);
    const headers = new Headers(init.headers);
    if (headers.get('Authorization') !== `Bearer ${this.validToken}`) {
      return json({ error_summary: 'expired_access_token/' }, 401);
    }
    const arg = headers.get('Dropbox-API-Arg');
    if (arg && /[^\u0000-\u007f]/u.test(arg)) return json({ error_summary: 'non-ASCII header' }, 400);
    const params = arg ? JSON.parse(arg) : init.body && headers.get('Content-Type') === 'application/json' ? JSON.parse(String(init.body)) : {};
    const body = init.body instanceof Uint8Array ? init.body : new Uint8Array();

    const writes = ['files/upload', 'files/delete_v2', 'files/create_folder_v2', 'files/upload_session/finish'];
    if (writes.includes(endpoint) && this.contention > 0) {
      this.contention--;
      return json({ error_summary: 'too_many_write_operations/' }, 429, { 'Retry-After': '0' });
    }

    switch (endpoint) {
      case 'files/download':
        return this.download(params.path, headers.get('Range'));
      case 'files/upload':
        return this.commit(params, body);
      case 'files/upload_session/start': {
        const id = `s${++this.counter}`;
        this.sessions.set(id, [body]);
        return json({ session_id: id });
      }
      case 'files/upload_session/append_v2': {
        const parts = this.sessions.get(params.cursor.session_id)!;
        if (total(parts) !== params.cursor.offset) return json({ error_summary: 'incorrect_offset/' }, 409);
        parts.push(body);
        return json(null);
      }
      case 'files/upload_session/finish': {
        const parts = this.sessions.get(params.cursor.session_id)!;
        parts.push(body);
        if (total(parts) !== params.cursor.offset) return json({ error_summary: 'incorrect_offset/' }, 409);
        this.sessions.delete(params.cursor.session_id);
        return this.commit(params.commit, concat(parts));
      }
      case 'files/delete_v2':
        return this.remove(params.path);
      case 'files/create_folder_v2':
        return this.mkdir(params.path);
      case 'files/list_folder':
        return json({ entries: [...this.nodes.values()].map(entry), cursor: String(this.log.length), has_more: false });
      case 'files/list_folder/continue': {
        const changed = this.log.slice(Number(params.cursor));
        const entries = changed.map((c) =>
          c.deleted ? { '.tag': 'deleted', path_display: c.path } : entry(this.nodes.get(c.path.toLowerCase())!),
        );
        return json({ entries, cursor: String(this.log.length), has_more: false });
      }
      default:
        return json({ error_summary: `unknown endpoint ${endpoint}` }, 400);
    }
  };

  /** What the user would see in their Dropbox, keyed by display path. */
  files(): Record<string, string> {
    return Object.fromEntries(
      [...this.nodes.values()].filter((n) => !n.folder).map((n) => [n.display, new TextDecoder().decode(n.bytes)]),
    );
  }

  /** An edit made outside our server, e.g. in the Dropbox app. */
  editOutOfBand(path: string, text: string): void {
    this.put(path, new TextEncoder().encode(text));
  }

  private download(path: string, range: string | null): Response {
    const node = this.nodes.get(path.toLowerCase());
    if (!node || node.folder) return json({ error_summary: 'path/not_found/' }, 409);
    let bytes = node.bytes;
    let status = 200;
    const m = range && /^bytes=(\d+)-(\d+)$/u.exec(range);
    if (m) {
      bytes = node.bytes.slice(Number(m[1]), Number(m[2]) + 1);
      status = 206;
    }
    return new Response(bytes, {
      status,
      headers: { 'Dropbox-API-Result': JSON.stringify(entry(node)) },
    });
  }

  private commit(params: { path: string; mode: unknown }, bytes: Uint8Array): Response {
    const existing = this.nodes.get(params.path.toLowerCase());
    const mode = params.mode as string | { '.tag': string; update: string };
    if (mode === 'add' && existing) return json({ error_summary: 'path/conflict/file/' }, 409);
    if (typeof mode === 'object' && existing?.rev !== mode.update) return json({ error_summary: 'path/conflict/file/' }, 409);
    if (bytes.byteLength > this.freeSpace) return json({ error_summary: 'path/insufficient_space/' }, 409);
    return json(entry(this.put(params.path, bytes)));
  }

  private put(path: string, bytes: Uint8Array): Node {
    const key = path.toLowerCase();
    const display = this.nodes.get(key)?.display ?? path;
    this.ensureParents(display);
    const node = { display, folder: false, bytes, rev: `0${(++this.counter).toString(16)}` };
    this.nodes.set(key, node);
    this.log.push({ path: display, deleted: false });
    return node;
  }

  private mkdir(path: string): Response {
    if (this.nodes.has(path.toLowerCase())) return json({ error_summary: 'path/conflict/folder/' }, 409);
    this.ensureParents(path);
    this.nodes.set(path.toLowerCase(), { display: path, folder: true, bytes: new Uint8Array(), rev: '' });
    this.log.push({ path, deleted: false });
    return json({ metadata: { path_display: path } });
  }

  private ensureParents(path: string): void {
    const parts = path.split('/').slice(1, -1);
    for (let i = 1; i <= parts.length; i++) {
      const p = `/${parts.slice(0, i).join('/')}`;
      if (!this.nodes.has(p.toLowerCase())) this.nodes.set(p.toLowerCase(), { display: p, folder: true, bytes: new Uint8Array(), rev: '' });
    }
  }

  private remove(path: string): Response {
    const key = path.toLowerCase();
    if (!this.nodes.has(key)) return json({ error_summary: 'path_lookup/not_found/' }, 409);
    for (const k of [...this.nodes.keys()]) {
      if (k === key || k.startsWith(`${key}/`)) {
        this.log.push({ path: this.nodes.get(k)!.display, deleted: true });
        this.nodes.delete(k);
      }
    }
    return json({ metadata: {} });
  }
}

function entry(n: Node) {
  return n.folder
    ? { '.tag': 'folder', path_display: n.display }
    : { '.tag': 'file', path_display: n.display, rev: n.rev, size: n.bytes.byteLength, server_modified: '2026-10-22T12:00:00Z' };
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function total(parts: Uint8Array[]): number {
  return parts.reduce((n, p) => n + p.byteLength, 0);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(total(parts));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}
