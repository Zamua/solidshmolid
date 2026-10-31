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
import { type PodPath, ancestorsOf, parentOf } from '../../domain/pods/paths.js';
import { parseRdf } from '../../domain/shared/rdf.js';
import { MA } from '../../domain/shared/vocab.js';
import type { DocumentRow, PodIndex, ResourceRow } from './ports.js';
import { newContainerRow, touch } from './rows.js';
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
  wanted.set('/', kept(index.get('/'), '/', deps));

  const live = entries.filter((e) => e.kind !== 'deleted' && !FOREIGN.some((f) => e.path.startsWith(f)));
  const metaFiles = new Set(live.filter((e) => e.kind === 'file' && isMetaFile(e.path)).map((e) => e.path));

  for (const e of live.filter((x) => x.kind === 'folder')) {
    const path = mapFolder(e.path, report);
    if (path) wanted.set(path, kept(index.get(path), path, deps));
  }
  const files = live.filter((x): x is FileEntry => x.kind === 'file' && !isMetaFile(x.path));
  for (const e of files.sort((a, b) => a.path.localeCompare(b.path))) {
    const mapped = mapFile(e.path, report);
    if (!mapped) continue;
    if (wanted.has(mapped.path)) {
      report.skipped.push({ file: e.path, reason: `another file already holds ${mapped.path}` });
      continue;
    }
    const row = await documentRow(deps, e, mapped, metaFiles.has(metaFileOf(mapped.path)));
    wanted.set(mapped.path, row);
    for (const a of ancestorsOf(mapped.path)) if (!wanted.has(a)) wanted.set(a, kept(index.get(a), a, deps));
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
    for (const container of [...wanted.values()].filter((r) => r.kind === 'container')) {
      const before = current.filter((r) => parentOf(r.path) === container.path).map((r) => r.path).sort();
      const after = [...wanted.keys()].filter((p) => parentOf(p) === container.path).sort();
      if (before.join('\n') !== after.join('\n')) touch(index, container.path, deps);
    }
  });
  return report;
}

/** Applies a provider change listing on top of the current index. */
export async function applyChanges(deps: ReconcileDeps, entries: ListedEntry[]): Promise<ReconcileReport> {
  const { index } = deps;
  const report: ReconcileReport = { updated: 0, removed: 0, skipped: [] };
  for (const e of entries.filter((x) => !FOREIGN.some((f) => x.path.startsWith(f)))) {
    if (e.kind === 'deleted') {
      for (const row of rowsForDeleted(index, e.path)) {
        index.atomically(() => {
          index.delete(row.path);
          touch(index, parentOf(row.path), deps);
        });
        report.removed++;
      }
      continue;
    }
    if (e.kind === 'folder') {
      const path = mapFolder(e.path, report);
      if (path && !index.get(path)) {
        index.atomically(() => ensureContainers(deps, [...ancestorsOf(path), path]));
        report.updated++;
      }
      continue;
    }
    if (isMetaFile(e.path)) {
      // A changed metadata file can change its resource's type: re-read it.
      const owner = rowForMeta(index, e.path);
      if (owner?.file.endsWith(`$.${UNKNOWN_EXTENSION}`)) {
        const row = await documentRow(deps, { ...e, path: owner.file, rev: owner.rev, size: owner.size }, { path: owner.path, contentType: owner.contentType }, true);
        index.atomically(() => index.upsert({ ...row, etag: deps.newId() }));
        report.updated++;
      }
      continue;
    }
    const mapped = mapFile(e.path, report);
    if (!mapped) continue;
    const existing = index.get(mapped.path);
    if (existing && existing.file !== e.path) {
      report.skipped.push({ file: e.path, reason: `${mapped.path} is held by ${existing.file}` });
      continue;
    }
    if (existing?.kind === 'document' && existing.rev === e.rev) continue;
    const row = await documentRow(deps, e, mapped, existing?.kind === 'document' && existing.hasMeta);
    index.atomically(() => {
      ensureContainers(deps, ancestorsOf(mapped.path));
      index.upsert(row);
      index.setCachedText(mapped.path, null);
      if (!existing) touch(index, parentOf(mapped.path), deps);
    });
    report.updated++;
  }
  return report;
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

function ensureContainers(deps: ReconcileDeps, paths: PodPath[]): void {
  for (const p of paths) {
    if (deps.index.get(p)) continue;
    deps.index.upsert(newContainerRow(p, deps));
    touch(deps.index, parentOf(p), deps);
  }
}

/** Rows a deleted file or folder took with it. */
function rowsForDeleted(index: PodIndex, file: string): ResourceRow[] {
  const all = allRows(index);
  const asFolder = `${file.replace(/\/$/u, '')}/`;
  return all.filter((r) => r.file === file || r.file === asFolder || r.file.startsWith(asFolder)).sort((a, b) => b.path.length - a.path.length);
}

function rowForMeta(index: PodIndex, metaFile: string): DocumentRow | null {
  return allRows(index).find((r): r is DocumentRow => r.kind === 'document' && metaFileOf(r.path) === metaFile) ?? null;
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
