// Putting a pod into its folder of the user's storage. An empty folder gets a
// new pod; one that already holds files is adopted as the pod, so a folder
// the person used before (or one another Solid server wrote) comes back as it
// was. Either way the folder is the truth afterwards.

import type { Pod } from '../pods/pod.js';
import { Conflict } from '../shared/errors.js';
import type { FileLister, FileStore, PlacementOutcome, SyncCursor } from './ports.js';

interface Folder {
  linkId: string;
  folder: string;
}

/** Whether the pod already sits in `wanted`. Placing it again there is a
 * no-op; a pod placed elsewhere is refused, since moving it is not placing. */
export function alreadyPlaced(current: (Folder & { cursor: string | null }) | null, wanted: Folder): boolean {
  if (!current?.cursor) return false;
  if (current.linkId === wanted.linkId && current.folder === wanted.folder) return true;
  throw new Conflict('the pod already lives in other storage');
}

export interface Starter {
  owner: string;
  /** The WebID profile, for the pod that holds the owner's WebID. */
  profile: string | null;
}

export async function placePod(pod: Pod, storage: FileStore & FileLister, cursor: SyncCursor, starter: Starter): Promise<PlacementOutcome> {
  await storage.makeFolder('');
  const listing = await storage.listAll();
  if (listing.entries.some((e) => e.kind === 'file')) {
    await pod.adopt(starter.owner, listing.entries);
    await cursor.setCursor(listing.cursor);
    return 'adopted';
  }
  await pod.provision(starter.owner, starter.profile);
  await cursor.setCursor((await storage.listAll()).cursor);
  return 'created';
}
