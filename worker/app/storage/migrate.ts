// Copies every indexed resource from one store to another, file for file, so
// the destination folder is a complete pod in the same layout.

import { metaFileOf } from '../../domain/pods/layout.js';
import type { PodIndex, ResourceRow } from '../pods/ports.js';
import type { FileStore } from './ports.js';

export async function copyPod(index: PodIndex, from: FileStore, to: FileStore): Promise<number> {
  let copied = 0;
  const visit = async (row: ResourceRow): Promise<void> => {
    if (row.kind === 'container') {
      await to.makeFolder(row.file);
      for (const child of index.children(row.path)) await visit(child);
      return;
    }
    for (const file of row.hasMeta ? [row.file, metaFileOf(row.path)] : [row.file]) {
      const stored = await from.read(file);
      if (!stored) continue;
      await to.write(file, new Uint8Array(await new Response(stored.body).arrayBuffer()));
      copied++;
    }
  };
  const root = index.get('/');
  if (root) await visit(root);
  return copied;
}
