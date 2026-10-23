// Request rules that need no storage: version-tag preconditions, byte
// ranges, entity tags and names from a Slug.

import { bareType } from '../shared/mediaTypes.js';

export type EtagList = string[] | '*' | null;

export interface Conditions {
  ifMatch: EtagList;
  ifNoneMatch: EtagList;
}

export const NO_CONDITIONS: Conditions = { ifMatch: null, ifNoneMatch: null };

/** The ETag of a stored revision. `+` separates a representation suffix,
 * so it cannot appear in a revision's tag. */
export function etagOfRev(rev: string): string {
  return rev.replace(/["+\\]/gu, '');
}

/** The ETag of a converted representation of the state `etag`. */
export function representationEtag(etag: string, type: string): string {
  return `${etag}+${bareType(type).replace(/[^a-z0-9]+/gu, '-')}`;
}

/** The state a precondition names, without its representation suffix: one
 * resource state has one tag whichever representation the client saw. */
function stateTag(etag: string): string {
  return etag.replace(/^W\//u, '').replace(/^"|"$/gu, '').split('+')[0]!;
}

/** Why the conditions fail for a resource with `etag` (null: absent), or
 * null when they hold. */
export function preconditionFailure(etag: string | null, c: Conditions): string | null {
  if (c.ifMatch === '*' && etag === null) return 'If-Match: * but the resource does not exist';
  if (Array.isArray(c.ifMatch) && (etag === null || !c.ifMatch.some((t) => stateTag(t) === etag))) return 'If-Match does not match';
  if (c.ifNoneMatch === '*' && etag !== null) return 'If-None-Match: * but the resource exists';
  if (Array.isArray(c.ifNoneMatch) && etag !== null && c.ifNoneMatch.some((t) => stateTag(t) === etag)) return 'If-None-Match matches';
  return null;
}

export type RangeRequest = { start: number; end: number | null } | { suffix: number };

/** Inclusive byte offsets. */
export interface ByteSpan {
  start: number;
  end: number;
}

/** The span a range request covers in a body of `size` bytes, or null when
 * it is unsatisfiable. */
export function resolveRange(r: RangeRequest, size: number): ByteSpan | null {
  if ('suffix' in r) {
    if (r.suffix <= 0 || size === 0) return null;
    return { start: Math.max(0, size - r.suffix), end: size - 1 };
  }
  if (r.start >= size) return null;
  return { start: r.start, end: Math.min(r.end ?? size - 1, size - 1) };
}

/** A Slug reduced to one safe path segment (decoded; the caller encodes). */
export function slugName(slug: string): string {
  let name: string;
  try {
    name = decodeURIComponent(slug);
  } catch {
    name = slug;
  }
  name = name.replace(/[\u0000-\u001f\u007f/\\]/gu, '-').replace(/\$\.\w+$/u, '');
  if (name === '.' || name === '..') name = '';
  if (/\.(acl|meta)$/u.test(name)) name = `${name}-`;
  return name.slice(0, 200);
}
