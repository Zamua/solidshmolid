// The pod index in the Durable Object's SQLite database.

import type { PodIndex, PodState, ResourceRow } from '../app/ports.js';
import { foldKey, parentOf } from '../domain/paths.js';

/** The slice of Durable Object storage the index uses. */
export interface SqlRunner {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export type Transactor = <T>(fn: () => T) => T;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pod_state(
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  owner   TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS resource(
  path         TEXT PRIMARY KEY,
  parent       TEXT,
  fold         TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL,
  content_type TEXT,
  file         TEXT NOT NULL,
  rev          TEXT,
  etag         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  modified     TEXT NOT NULL,
  has_meta     INTEGER NOT NULL,
  cached       TEXT
);
CREATE INDEX IF NOT EXISTS resource_parent ON resource(parent);
`;

const COLUMNS = 'path, kind, content_type, file, rev, etag, size, modified, has_meta';

export class SqlIndex implements PodIndex {
  constructor(
    private readonly sql: SqlRunner,
    private readonly transaction: Transactor,
  ) {
    // Idempotent, so it runs on every construction rather than behind a flag
    // that could be wrong after an eviction.
    this.sql.exec(SCHEMA);
  }

  state(): PodState | null {
    const row = this.sql.exec('SELECT owner, created FROM pod_state WHERE id = 1').toArray()[0];
    return row ? { owner: String(row.owner), created: String(row.created) } : null;
  }

  setState(state: PodState): void {
    this.sql.exec(
      'INSERT INTO pod_state(id, owner, created) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, created = excluded.created',
      state.owner,
      state.created,
    );
  }

  get(path: string): ResourceRow | null {
    return this.one(`SELECT ${COLUMNS} FROM resource WHERE path = ?`, path);
  }

  byFold(fold: string): ResourceRow | null {
    return this.one(`SELECT ${COLUMNS} FROM resource WHERE fold = ?`, fold);
  }

  children(container: string): ResourceRow[] {
    return this.sql
      .exec(`SELECT ${COLUMNS} FROM resource WHERE parent = ? ORDER BY path`, container)
      .toArray()
      .map(toRow);
  }

  upsert(row: ResourceRow): void {
    this.sql.exec(
      `INSERT INTO resource(path, parent, fold, kind, content_type, file, rev, etag, size, modified, has_meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         kind = excluded.kind, content_type = excluded.content_type, file = excluded.file,
         rev = excluded.rev, etag = excluded.etag, size = excluded.size,
         modified = excluded.modified, has_meta = excluded.has_meta`,
      row.path,
      parentOf(row.path),
      foldKey(row.path),
      row.kind,
      row.contentType,
      row.file,
      row.rev,
      row.etag,
      row.size,
      row.modified,
      row.hasMeta ? 1 : 0,
    );
  }

  delete(path: string): void {
    this.sql.exec('DELETE FROM resource WHERE path = ?', path);
  }

  cachedText(path: string): string | null {
    const row = this.sql.exec('SELECT cached FROM resource WHERE path = ?', path).toArray()[0];
    return typeof row?.cached === 'string' ? row.cached : null;
  }

  setCachedText(path: string, text: string | null): void {
    this.sql.exec('UPDATE resource SET cached = ? WHERE path = ?', text, path);
  }

  atomically<T>(fn: () => T): T {
    return this.transaction(fn);
  }

  private one(query: string, ...bindings: unknown[]): ResourceRow | null {
    const row = this.sql.exec(query, ...bindings).toArray()[0];
    return row ? toRow(row) : null;
  }
}

function toRow(r: Record<string, unknown>): ResourceRow {
  return {
    path: String(r.path),
    kind: r.kind === 'container' ? 'container' : 'document',
    contentType: r.content_type === null ? null : String(r.content_type),
    file: String(r.file),
    rev: r.rev === null ? null : String(r.rev),
    etag: String(r.etag),
    size: Number(r.size),
    modified: String(r.modified),
    hasMeta: Number(r.has_meta) === 1,
  };
}
