// The HTTP methods a resource answers, by what kind of resource it is. Both
// `Allow` on responses and the list a 405 carries come from here.

import { type PodPath, isContainer, isMetaPath } from './paths.js';

export const METHODS = ['OPTIONS', 'HEAD', 'GET', 'PUT', 'POST', 'PATCH', 'DELETE'] as const;
export type Method = (typeof METHODS)[number];

const ANY: Method[] = ['OPTIONS', 'HEAD', 'GET', 'PUT'];

/** Containers take POST and documents PATCH; the root is never deleted, and
 * metadata files are written by the server alone. */
export function allowedMethods(path: PodPath): Method[] {
  if (isMetaPath(path)) return ['OPTIONS'];
  if (path === '/') return [...ANY, 'POST'];
  if (isContainer(path)) return [...ANY, 'POST', 'DELETE'];
  return [...ANY, 'PATCH', 'DELETE'];
}
