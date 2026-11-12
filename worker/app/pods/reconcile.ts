// Bringing the index in line with what the folder actually holds: a full
// rebuild when a pod adopts an existing folder, and incremental changes when
// the provider reports edits made outside this server.
//
// The folder is the truth. A file the layout cannot map is reported and left
// alone, never deleted.

import {
  type MappedFile,
  UNKNOWN_EXTENSION,
  UnmappablePath,
  containerOfFolder,
  isMetaFile,
  metaFileOf,
  resourceOfFile,
} from '../../domain/pods/layout.js';
import { bareType } from '../../domain/shared/mediaTypes.js';
import { type PodPath, ancestorsOf, foldKey, isContainer, parentOf } from '../../domain/pods/paths.js';
import { parseRdf } from '../../domain/shared/rdf.js';
import { MA } from '../../domain/shared/vocab.js';
import type { DocumentRow, PodIndex, ResourceRow } from './ports.js';
import { newContainerRow, touch } from './rows.js';
import { StorageUnavailable } from '../shared/errors.js';
import type { FileEntry, FileStore, ListedEntry } from '../storage/ports.js';

export interface ReconcileDeps {
  index: PodIndex;
  files: FileStore;
  base: string;
  now: () => Date;
  newId: () => string;
}

export interface ReconcileReport {
  /** Resources added or changed in the index. */
  updated: number;
  removed: number;
  /** Files left out of the pod, with the reason. */
  skipped: { file: string; reason: string }[];
}

/** Folders that belong to another server sharing the folder, not to the pod. */
const FOREIGN = ['.internal/'];

/** Replaces the index with the folder's contents, keeping ETags and caches of
 * files that did not change. */
export async function rebuildIndex(deps: ReconcileDeps, entries: ListedEntry[]): Promise<ReconcileReport> {
  const { index } = deps;
  const report: ReconcileReport = { updated: 0, removed: 0, skipped: [] };
  const wanted = new Map<PodPath, ResourceRow>();
  const folds = new Map<string, PodPath>();
  const want = (row: ResourceRow) => {
    wanted.set(row.path, row);
    folds.set(foldKey(row.path), row.path);
  };
  const held: Held = { get: (path) => wanted.get(path) ?? null, byFold: (fold) => wanted.get(folds.get(fold) ?? '') ?? null };
  const wantContainers = (paths: PodPath[]) => {
    for (const p of paths) if (!wanted.has(p)) want(kept(index.get(p), p, deps));
  };
  want(kept(index.get('/'), '/', deps));

  const live = entries.filter((e) => e.kind !== 'deleted' && !FOREIGN.some((f) => e.path.startsWith(f)));
  const metaFiles = new Set(live.filter((e) => e.kind === 'file' && isMetaFile(e.path)).map((e) => e.path));

  for (const e of live.filter((x) => x.kind === 'folder')) {
    const mapped = mapFolder(e.path, report);
    const path = mapped && settled(deps, held, mapped, e.path, report);
    if (path) wantContainers([...ancestorsOf(path), path]);
  }
  const files = live.filter((x): x is FileEntry => x.kind === 'file' && !isMetaFile(x.path));
  for (const e of files.sort((a, b) => a.path.localeCompare(b.path))) {
    const mapped = mapFile(e.path, report);
    if (!mapped) continue;
    const path = settled(deps, held, mapped.path, e.path, report);
    if (!path) continue;
    if (wanted.has(path)) {
      report.skipped.push({ file: e.path, reason: `another file already holds ${path}` });
      continue;
    }
    wantContainers(ancestorsOf(path));
    want(await documentRow(deps, e, { ...mapped, path }, metaFiles.has(metaFileOf(mapped.path))));
  }

  const current = allRows(index);
  index.atomically(() => {
    for (const row of current) {
      if (!wanted.has(row.path)) {
        index.delete(row.path);
        report.removed++;
      }
    }
    for (const row of wanted.values()) {
      const existing = index.get(row.path);
      if (unchanged(existing, row)) continue;
      index.upsert(row);
      index.setCachedText(row.path, null);
      report.updated++;
    }
    const before = childrenByParent(current.map((r) => r.path));
    const after = childrenByParent([...wanted.keys()]);
    for (const container of [...wanted.values()].filter((r) => r.kind === 'container')) {
      if (before.get(container.path) !== after.get(container.path)) touch(index, container.path, deps);
    }
  });
  return report;
}

/** Applies a provider change listing on top of the current index. */
export async function applyChanges(deps: ReconcileDeps, entries: ListedEntry[]): Promise<ReconcileReport> {
  const { index } = deps;
  const report: ReconcileReport = { updated: 0, removed: 0, skipped: [] };
  // The whole index is read once for a run of deletions, not once per entry
  // (a deleted folder is reported file by file). Anything else that changes
  // rows drops the snapshot.
  let snapshot: ResourceRow[] | null = null;
  const rows = () => (snapshot ??= allRows(index));
  const held: Held = { get: (path) => index.get(path), byFold: (fold) => index.byFold(fold) };
  for (const e of entries.filter((x) => !FOREIGN.some((f) => x.path.startsWith(f)))) {
    try {
      await applyOne(e);
    } catch (error) {
      // Storage that cannot answer is asked again; anything else would fail
      // the same way every time, and one entry must not hold up the rest.
      if (error instanceof StorageUnavailable) throw error;
      snapshot = null;
      report.skipped.push({ file: e.path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;

  async function applyOne(e: ListedEntry): Promise<void> {
    if (e.kind === 'deleted') {
      const gone = rowsForDeleted(rows(), e.path, deps.files.mergesCase);
      for (const row of gone) {
        index.atomically(() => {
          index.delete(row.path);
          touch(index, parentOf(row.path), deps);
        });
        report.removed++;
      }
      // `touch` changes only a container's validators, which nothing here reads.
      if (gone.length > 0) snapshot = rows().filter((r) => !gone.includes(r));
      return;
    }
    snapshot = null;
    if (e.kind === 'folder') {
      const mapped = mapFolder(e.path, report);
      const path = mapped && settled(deps, held, mapped, e.path, report);
      if (path && !index.get(path)) {
        index.atomically(() => ensureContainers(deps, [...ancestorsOf(path), path]));
        report.updated++;
      }
      return;
    }
    if (isMetaFile(e.path)) {
      // A changed metadata file can change its resource's type: re-read it.
      const owner = rowForMeta(index, e.path, deps.files.mergesCase);
      if (owner?.file.endsWith(`$.${UNKNOWN_EXTENSION}`)) {
        const row = await documentRow(deps, { ...e, path: owner.file, rev: owner.rev, size: owner.size }, { path: owner.path, contentType: owner.contentType }, true);
        index.atomically(() => index.upsert({ ...row, etag: deps.newId() }));
        report.updated++;
      }
      return;
    }
    const mapped = mapFile(e.path, report);
    if (!mapped) return;
    // A file the storage renamed only in case is the same resource under a
    // new spelling: its row moves with it.
    const renamed = renamedFrom(deps, held, mapped.path, e.path);
    const path = settled(deps, held, mapped.path, e.path, report, renamed);
    if (!path) return;
    const existing = renamed ?? index.get(path);
    if (!renamed && existing && !sameFile(existing.file, e.path, deps.files.mergesCase)) {
      report.skipped.push({ file: e.path, reason: `${path} is held by ${existing.file}` });
      return;
    }
    if (!renamed && existing?.kind === 'document' && existing.rev === e.rev && existing.file === e.path) return;
    const row = await documentRow(deps, e, { ...mapped, path }, existing?.kind === 'document' && existing.hasMeta);
    index.atomically(() => {
      if (renamed) {
        index.delete(renamed.path);
        touch(index, parentOf(renamed.path), deps);
      }
      ensureContainers(deps, ancestorsOf(path));
      index.upsert(row);
      index.setCachedText(path, null);
      if (!existing || renamed) touch(index, parentOf(path), deps);
    });
    report.updated++;
  }
}

/** What already holds a path, in the index or in a listing being taken in. */
interface Held {
  get(path: PodPath): ResourceRow | null;
  byFold(fold: string): ResourceRow | null;
}

/** The path an entry mapped to `path` takes beside what is already held, or
 * null (reported) when it cannot have one. No two held paths may differ only
 * in case. Storage that merges case means the folder already held by the
 * other spelling, so the entry goes under that one; storage that tells them
 * apart holds two things, and the one seen first keeps the name. `moving` is
 * a row about to give up its path. */
function settled(deps: ReconcileDeps, held: Held, path: PodPath, file: string, report: ReconcileReport, moving: ResourceRow | null = null): PodPath | null {
  let at: PodPath = '/';
  const segments = path.split('/').filter((s) => s !== '');
  for (const [i, segment] of segments.entries()) {
    const last = i === segments.length - 1;
    const next: PodPath = `${at}${segment}${last && !isContainer(path) ? '' : '/'}`;
    const twin = held.get(next) ? null : held.byFold(foldKey(next));
    if (!twin || twin.path === moving?.path) {
      at = next;
    } else if (deps.files.mergesCase && twin.kind === 'container' && isContainer(next)) {
      at = twin.path;
    } else {
      report.skipped.push({ file, reason: `${next} differs only in case from ${twin.path}` });
      return null;
    }
  }
  return at;
}

/** The document `file` was before the storage renamed it only in case. */
function renamedFrom(deps: ReconcileDeps, held: Held, path: PodPath, file: string): DocumentRow | null {
  if (!deps.files.mergesCase || held.get(path)) return null;
  const twin = held.byFold(foldKey(path));
  return twin?.kind === 'document' && twin.file !== file && sameFile(twin.file, file, true) ? twin : null;
}

function sameFile(a: string, b: string, mergesCase: boolean): boolean {
  return a === b || (mergesCase && fileFold(a) === fileFold(b));
}

function fileFold(file: string): string {
  return file.normalize('NFC').toLowerCase();
}

function mapFolder(folder: string, report: ReconcileReport): PodPath | null {
  try {
    return containerOfFolder(folder);
  } catch (e) {
    if (!(e instanceof UnmappablePath)) throw e;
    report.skipped.push({ file: folder, reason: e.message });
    return null;
  }
}

function mapFile(file: string, report: ReconcileReport): MappedFile | null {
  try {
    return resourceOfFile(file);
  } catch (e) {
    if (!(e instanceof UnmappablePath)) throw e;
    report.skipped.push({ file, reason: e.message });
    return null;
  }
}

async function documentRow(deps: ReconcileDeps, e: FileEntry, mapped: MappedFile, hasMeta: boolean): Promise<DocumentRow> {
  let contentType = mapped.contentType;
  if (hasMeta && e.path.endsWith(`$.${UNKNOWN_EXTENSION}`)) contentType = (await storedType(deps, mapped.path)) ?? contentType;
  return {
    path: mapped.path,
    kind: 'document',
    contentType: bareType(contentType),
    file: e.path,
    rev: e.rev,
    etag: e.rev.replace(/["+\\]/gu, ''),
    size: e.size,
    modified: e.modified ?? deps.now().toISOString(),
    hasMeta,
  };
}

/** The content type a metadata file records for its resource. */
async function storedType(deps: ReconcileDeps, path: PodPath): Promise<string | null> {
  const meta = await deps.files.read(metaFileOf(path));
  if (!meta) return null;
  try {
    const text = await new Response(meta.body).text();
    const quads = await parseRdf(text, 'text/turtle', `${deps.base}${path}`);
    return quads.find((q) => q.predicate.value === MA('format'))?.object.value ?? null;
  } catch {
    return null;
  }
}

/** The container row for `path`, keeping its ETag if it is one already. */
function kept(existing: ResourceRow | null, path: PodPath, deps: ReconcileDeps): ResourceRow {
  return existing?.kind === 'container' ? existing : newContainerRow(path, deps);
}

/** Whether the index already holds `row` as the folder has it. */
function unchanged(existing: ResourceRow | null, row: ResourceRow): boolean {
  if (existing?.kind !== row.kind || existing.file !== row.file) return false;
  return existing.kind === 'container' || (row.kind === 'document' && existing.rev === row.rev);
}

/** Each container's member paths as one sorted, comparable string. */
function childrenByParent(paths: PodPath[]): Map<PodPath, string> {
  const members = new Map<PodPath, PodPath[]>();
  for (const path of paths) {
    const parent = parentOf(path);
    if (parent === null) continue;
    const list = members.get(parent);
    if (list) list.push(path);
    else members.set(parent, [path]);
  }
  return new Map([...members].map(([parent, list]) => [parent, list.sort().join('\n')]));
}

function ensureContainers(deps: ReconcileDeps, paths: PodPath[]): void {
  for (const p of paths) {
    if (deps.index.get(p)) continue;
    deps.index.upsert(newContainerRow(p, deps));
    touch(deps.index, parentOf(p), deps);
  }
}

/** Rows a deleted file or folder took with it. */
function rowsForDeleted(all: ResourceRow[], file: string, mergesCase: boolean): ResourceRow[] {
  const spelled = (f: string) => (mergesCase ? fileFold(f) : f);
  const gone = spelled(file);
  const asFolder = `${gone.replace(/\/$/u, '')}/`;
  return all
    .filter((r) => r.path !== '/' && (spelled(r.file) === gone || spelled(r.file).startsWith(asFolder)))
    .sort((a, b) => b.path.length - a.path.length);
}

function rowForMeta(index: PodIndex, metaFile: string, mergesCase: boolean): DocumentRow | null {
  return allRows(index).find((r): r is DocumentRow => r.kind === 'document' && sameFile(metaFileOf(r.path), metaFile, mergesCase)) ?? null;
}

function allRows(index: PodIndex): ResourceRow[] {
  const out: ResourceRow[] = [];
  const walk = (path: PodPath) => {
    const row = index.get(path);
    if (row) out.push(row);
    for (const child of index.children(path)) {
      if (child.kind === 'container') walk(child.path);
      else out.push(child);
    }
  };
  walk('/');
  return out;
}
