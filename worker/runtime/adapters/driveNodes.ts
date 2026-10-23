// The tree of Google Drive files under one folder, by id. Drive addresses
// files by id, not path; this map is how the Drive adapter turns paths into
// ids, and its change feed (which names ids) back into paths.

import type { SqlRunner } from './sql.js';

export interface DriveNode {
  id: string;
  /** Null for the folder the tree hangs from. */
  parent: string | null;
  name: string;
  folder: boolean;
  /** Drive's version, size and modification time; null for folders. */
  version: string | null;
  size: number;
  modified: string | null;
}

export interface DriveNodes {
  root(): string | null;
  /** Makes `id` the root; a different root forgets the old tree. */
  setRoot(id: string): void;
  get(id: string): DriveNode | null;
  child(parent: string, name: string): DriveNode | null;
  children(parent: string): DriveNode[];
  put(node: DriveNode): void;
  /** Forgets the node and everything below it. */
  forget(id: string): void;
}

/** The path of `id` below the root ('a/b.txt', 'a/' for folders), or null
 * when it does not hang from the root. */
export function pathOf(nodes: DriveNodes, id: string): string | null {
  const names: string[] = [];
  let node = nodes.get(id);
  const folder = node?.folder ?? false;
  for (let hops = 0; node && node.parent !== null; hops++) {
    if (hops > 256) return null;
    names.unshift(node.name);
    node = nodes.get(node.parent);
  }
  if (!node || node.id !== nodes.root() || names.length === 0) return null;
  return names.join('/') + (folder ? '/' : '');
}

/** Every node below `id`, parents before children. */
export function descendants(nodes: DriveNodes, id: string): DriveNode[] {
  const out: DriveNode[] = [];
  const walk = (parent: string) => {
    for (const child of nodes.children(parent)) {
      out.push(child);
      if (child.folder) walk(child.id);
    }
  };
  walk(id);
  return out;
}

/** For one request, or where nothing persists. */
export class MemoryDriveNodes implements DriveNodes {
  private readonly byId = new Map<string, DriveNode>();
  private rootId: string | null = null;

  root(): string | null {
    return this.rootId;
  }

  setRoot(id: string): void {
    if (this.rootId === id) return;
    this.byId.clear();
    this.rootId = id;
    this.byId.set(id, rootNode(id));
  }

  get(id: string): DriveNode | null {
    return this.byId.get(id) ?? null;
  }

  child(parent: string, name: string): DriveNode | null {
    return this.children(parent).find((n) => n.name === name) ?? null;
  }

  children(parent: string): DriveNode[] {
    return [...this.byId.values()].filter((n) => n.parent === parent);
  }

  put(node: DriveNode): void {
    this.byId.set(node.id, node);
  }

  forget(id: string): void {
    for (const n of descendants(this, id)) this.byId.delete(n.id);
    this.byId.delete(id);
    if (id === this.rootId) this.rootId = null;
  }
}

/** Kept in the pod's SQLite, so the change feed maps across requests. */
export class SqlDriveNodes implements DriveNodes {
  constructor(private readonly sql: SqlRunner) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS drive_node(id TEXT PRIMARY KEY, parent TEXT, name TEXT NOT NULL, folder INTEGER NOT NULL, version TEXT, size INTEGER NOT NULL, modified TEXT);
      CREATE INDEX IF NOT EXISTS drive_node_parent ON drive_node(parent, name);
    `);
  }

  root(): string | null {
    const row = this.sql.exec('SELECT id FROM drive_node WHERE parent IS NULL').toArray()[0];
    return row ? String(row.id) : null;
  }

  setRoot(id: string): void {
    if (this.root() === id) return;
    this.sql.exec('DELETE FROM drive_node');
    this.put(rootNode(id));
  }

  get(id: string): DriveNode | null {
    const row = this.sql.exec('SELECT * FROM drive_node WHERE id = ?', id).toArray()[0];
    return row ? nodeOf(row) : null;
  }

  child(parent: string, name: string): DriveNode | null {
    const row = this.sql.exec('SELECT * FROM drive_node WHERE parent = ? AND name = ?', parent, name).toArray()[0];
    return row ? nodeOf(row) : null;
  }

  children(parent: string): DriveNode[] {
    return this.sql.exec('SELECT * FROM drive_node WHERE parent = ?', parent).toArray().map(nodeOf);
  }

  put(node: DriveNode): void {
    this.sql.exec(
      'INSERT INTO drive_node(id, parent, name, folder, version, size, modified) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET parent = excluded.parent, name = excluded.name, folder = excluded.folder, version = excluded.version, size = excluded.size, modified = excluded.modified',
      node.id,
      node.parent,
      node.name,
      node.folder ? 1 : 0,
      node.version,
      node.size,
      node.modified,
    );
  }

  forget(id: string): void {
    for (const n of descendants(this, id)) this.sql.exec('DELETE FROM drive_node WHERE id = ?', n.id);
    this.sql.exec('DELETE FROM drive_node WHERE id = ?', id);
  }
}

function rootNode(id: string): DriveNode {
  return { id, parent: null, name: '', folder: true, version: null, size: 0, modified: null };
}

function nodeOf(row: Record<string, unknown>): DriveNode {
  return {
    id: String(row.id),
    parent: row.parent === null ? null : String(row.parent),
    name: String(row.name),
    folder: Number(row.folder) === 1,
    version: row.version === null ? null : String(row.version),
    size: Number(row.size),
    modified: row.modified === null ? null : String(row.modified),
  };
}
