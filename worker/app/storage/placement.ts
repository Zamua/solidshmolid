// Putting a pod into its folder of the user's storage. An empty folder gets a
// new pod; one that already holds files is adopted as the pod, so a folder
// the person used before (or one another Solid server wrote) comes back as it
// was. Either way the folder is the truth afterwards.

import type { Pod } from '../pods/pod.js';
import type { FileLister, FileStore, PlacementOutcome, SyncCursor } from './ports.js';

export interface Starter {
  owner: string;
  profile: string;
  /** Full access besides the owner's (a household's managers). */
  controllers: string[];
}

export async function placePod(pod: Pod, storage: FileStore & FileLister, cursor: SyncCursor, starter: Starter): Promise<PlacementOutcome> {
  await storage.makeFolder('');
  const listing = await storage.listAll();
  if (listing.entries.some((e) => e.kind === 'file')) {
    await pod.adopt(starter.owner, listing.entries);
    await cursor.setCursor(listing.cursor);
    return 'adopted';
  }
  await pod.provision(starter.owner, starter.profile, starter.controllers);
  await cursor.setCursor((await storage.listAll()).cursor);
  return 'created';
}
