// Resource paths inside one pod.
//
// A PodPath is the canonical, percent-encoded URL path of a resource relative
// to the pod root: '/' is the root container, every container ends in '/',
// every document does not. One resource has exactly one PodPath, so request
// URLs are validated and canonicalized here before anything else sees them.

export type PodPath = string;

export class InvalidPath extends Error {}

const CONTROL = /[\u0000-\u001f\u007f]/u;

/** Canonicalizes a request pathname. Refuses anything that would make two
 * URLs name one resource or one URL escape its container. */
export function canonicalPath(pathname: string): PodPath {
  if (!pathname.startsWith('/')) throw new InvalidPath('path must start with /');
  const container = pathname.endsWith('/');
  const parts = pathname.split('/').slice(1);
  if (container) parts.pop();
  const segments = parts.map((part) => encodeURIComponent(decodeSegment(part)));
  if (segments.length === 0) return '/';
  return `/${segments.join('/')}${container ? '/' : ''}`;
}

function decodeSegment(part: string): string {
  if (part === '') throw new InvalidPath('empty path segment');
  let decoded: string;
  try {
    decoded = decodeURIComponent(part);
  } catch {
    throw new InvalidPath('malformed percent-encoding');
  }
  if (decoded === '.' || decoded === '..') throw new InvalidPath('dot segment');
  // An encoded slash would either be a second spelling of a nested path or a
  // file name no backend can store.
  if (decoded.includes('/') || decoded.includes('\\')) throw new InvalidPath('encoded path delimiter');
  if (CONTROL.test(decoded)) throw new InvalidPath('control character');
  return decoded;
}

export function isContainer(path: PodPath): boolean {
  return path.endsWith('/');
}

/** The containing container, or null for the root. */
export function parentOf(path: PodPath): PodPath | null {
  if (path === '/') return null;
  const trimmed = isContainer(path) ? path.slice(0, -1) : path;
  return trimmed.slice(0, trimmed.lastIndexOf('/') + 1);
}

/** Every container above `path`, root first. */
export function ancestorsOf(path: PodPath): PodPath[] {
  const out: PodPath[] = [];
  for (let p = parentOf(path); p !== null; p = parentOf(p)) out.unshift(p);
  return out;
}

/** The last segment, still encoded, without a container's trailing slash. */
export function nameOf(path: PodPath): string {
  const trimmed = isContainer(path) ? path.slice(0, -1) : path;
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/** The same resource under the other kind: '/a' <-> '/a/'. Solid forbids both
 * existing at once. */
export function otherKind(path: PodPath): PodPath {
  return isContainer(path) ? path.slice(0, -1) : `${path}/`;
}

export function childPath(container: PodPath, encodedName: string, asContainer: boolean): PodPath {
  return `${container}${encodedName}${asContainer ? '/' : ''}`;
}

/** The collision key for case-insensitive storage: two paths with equal keys
 * cannot both exist. */
export function foldKey(path: PodPath): string {
  return decodeURIComponent(path).normalize('NFC').toLowerCase();
}

export function aclPathOf(path: PodPath): PodPath {
  return `${path}.acl`;
}

export function isAclPath(path: PodPath): boolean {
  return !isContainer(path) && nameOf(path).endsWith('.acl');
}

/** The resource an ACL document governs: '/a/.acl' -> '/a/', '/a/b.acl' -> '/a/b'. */
export function subjectOfAcl(path: PodPath): PodPath {
  return path.slice(0, -'.acl'.length);
}

export function isMetaPath(path: PodPath): boolean {
  return !isContainer(path) && nameOf(path).endsWith('.meta');
}
