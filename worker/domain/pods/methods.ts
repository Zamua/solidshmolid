// The HTTP methods a resource answers, by what kind of resource it is. Both
// `Allow` on responses and the list a 405 carries come from here.

import { type PodPath, aclPathOf, isContainer, isMetaPath } from './paths.js';

export const METHODS = ['OPTIONS', 'HEAD', 'GET', 'PUT', 'POST', 'PATCH', 'DELETE'] as const;
export type Method = (typeof METHODS)[number];

/** The ACL every resource falls back to: without it nobody holds any access. */
export const ROOT_ACL = aclPathOf('/');

/** The storage description: what the pod says about itself as a storage.
 * The server writes it; it is not a file in the folder. */
export const STORAGE_DESCRIPTION: PodPath = '/.well-known/solid';

const ANY: Method[] = ['OPTIONS', 'HEAD', 'GET', 'PUT'];

/** Containers take POST and documents PATCH; the root and its ACL are never
 * deleted, and metadata files and the storage description are written by the
 * server alone. */
export function allowedMethods(path: PodPath): Method[] {
  if (isMetaPath(path)) return ['OPTIONS'];
  if (path === STORAGE_DESCRIPTION) return ['OPTIONS', 'HEAD', 'GET'];
  if (path === '/') return [...ANY, 'POST'];
  if (path === ROOT_ACL) return [...ANY, 'PATCH'];
  if (isContainer(path)) return [...ANY, 'POST', 'DELETE'];
  return [...ANY, 'PATCH', 'DELETE'];
}
