// Putting a pod into its folder of the user's storage. An empty folder gets a
// new pod; one that already holds files is adopted as the pod, so a folder
// the person used before (or one another Solid server wrote) comes back as it
// was. Either way the folder is the truth afterwards.
//
// The lifecycle is `nextPlacement`; `placePod` and FolderSync only run the
// steps it returns and store the states it moves to.

import type { Pod } from '../pods/pod.js';
import { Conflict } from '../shared/errors.js';
import type { FileLister, FileStore, ListedEntry, Listing, Placement, PlacementOutcome, PlacementStore, PodPlacement } from './ports.js';

export interface Starter {
  owner: string;
  /** The WebID profile, for the pod that holds the owner's WebID. */
  profile: string | null;
}

/** The stored states, plus writing: listed, the pod's files going in. It is
 * stored as placing, so an interrupted placement lists the folder again. */
export type PlacementState = PodPlacement | { state: 'writing'; target: Placement; cursor: string; outcome: PlacementOutcome };

export type PlacementEvent =
  | { kind: 'place'; target: Placement }
  /** The folder as it stood before the pod wrote to it. */
  | { kind: 'listed'; listing: Listing }
  /** The pod is provisioned or adopted. */
  | { kind: 'ready' }
  /** The change feed was read up to `cursor`. */
  | { kind: 'synced'; cursor: string };

export type PlacementStep =
  | { kind: 'list' }
  | { kind: 'adopt'; entries: ListedEntry[] }
  | { kind: 'provision' }
  | { kind: 'done'; outcome: PlacementOutcome }
  | { kind: 'none' };

/** The one place a pod's placement changes. Placing again where it finished
 * is a no-op; placing a pod that lives elsewhere is refused, since moving it is
 * not placing it. The cursor comes from the listing taken before any write, so
 * the pod's own writes come back as changes it already holds. */
export function nextPlacement(current: PlacementState, event: PlacementEvent): { state: PlacementState; step: PlacementStep } {
  switch (current.state) {
    case 'unplaced':
    case 'placing':
    case 'writing':
      if (event.kind === 'place') return { state: { state: 'placing', target: event.target }, step: { kind: 'list' } };
      if (current.state === 'placing' && event.kind === 'listed') {
        const adopt = event.listing.entries.some((e) => e.kind === 'file');
        return {
          state: { state: 'writing', target: current.target, cursor: event.listing.cursor, outcome: adopt ? 'adopted' : 'created' },
          step: adopt ? { kind: 'adopt', entries: event.listing.entries } : { kind: 'provision' },
        };
      }
      if (current.state === 'writing' && event.kind === 'ready') {
        return { state: { state: 'placed', target: current.target, cursor: current.cursor }, step: { kind: 'done', outcome: current.outcome } };
      }
      break;
    case 'placed':
      if (event.kind === 'place') {
        if (event.target.linkId !== current.target.linkId || event.target.folder !== current.target.folder) {
          throw new Conflict('the pod already lives in other storage');
        }
        return { state: current, step: { kind: 'done', outcome: 'adopted' } };
      }
      if (event.kind === 'synced') return { state: { ...current, cursor: event.cursor }, step: { kind: 'none' } };
      break;
    default:
      return current satisfies never;
  }
  throw new Error(`placement: no ${event.kind} while ${current.state}`);
}

/** What the pod stores of a state. */
export function stored(state: PlacementState): PodPlacement {
  return state.state === 'writing' ? { state: 'placing', target: state.target } : state;
}

/** Places the pod in `target`, running the steps `nextPlacement` asks for. */
export async function placePod(pod: Pod, storage: FileStore & FileLister, store: PlacementStore, target: Placement, starter: Starter): Promise<PlacementOutcome> {
  let { state, step } = nextPlacement(store.current(), { kind: 'place', target });
  for (;;) {
    store.save(stored(state));
    let event: PlacementEvent;
    switch (step.kind) {
      case 'done':
        return step.outcome;
      case 'list':
        await storage.makeFolder('');
        event = { kind: 'listed', listing: await storage.listAll() };
        break;
      case 'adopt':
        await pod.adopt(starter.owner, step.entries);
        event = { kind: 'ready' };
        break;
      case 'provision':
        await pod.provision(starter.owner, starter.profile);
        event = { kind: 'ready' };
        break;
      case 'none':
        throw new Error(`placement stopped while ${state.state}`);
    }
    ({ state, step } = nextPlacement(state, event));
  }
}
