// The folder layout: where a resource lives inside the pod folder.
//
// It is Community Solid Server's file-backend layout (ExtensionBasedMapper),
// so a stock CSS pointed at a copy of the folder serves the same pod. A
// document's content type is carried by its file extension; when the name's
// own extension implies a different type, the canonical extension for the real
// type is appended after `$`. Only a type with no known extension needs a
// metadata file to remember it.

import mime from 'mime-types';
import { type PodPath, isContainer } from './paths.js';

export const OCTET_STREAM = 'application/octet-stream';
export const UNKNOWN_EXTENSION = 'unknown';

const CUSTOM_TYPES: Record<string, string> = {
  acl: 'text/turtle',
  acr: 'text/turtle',
  meta: 'text/turtle',
};

// Characters CSS keeps percent-encoded in file names because Windows cannot
// store them, plus '%' itself so decoding a file name is unambiguous.
const FILE_ESCAPES: Record<string, string> = {
  '%': '%25',
  '<': '%3C',
  '>': '%3E',
  ':': '%3A',
  '"': '%22',
  '|': '%7C',
  '?': '%3F',
  '*': '%2A',
};
const FILE_ESCAPE_RE = /[%<>:"|?*]/gu;

export class UnmappablePath extends Error {}

/** A media type without parameters, lowercased. */
export function bareType(contentType: string): string {
  return contentType.split(';')[0]!.trim().toLowerCase();
}

export function extensionOf(name: string): string {
  return /\.([^./]+)$/u.exec(name)?.[1] ?? '';
}

/** The type a file name implies, as CSS reads it. */
export function typeOfFileName(name: string): string {
  const ext = extensionOf(name).toLowerCase();
  return mime.lookup(ext) || CUSTOM_TYPES[ext] || OCTET_STREAM;
}

function canonicalExtension(contentType: string): string | null {
  const ext = mime.extension(contentType);
  if (ext) return ext;
  for (const [e, t] of Object.entries(CUSTOM_TYPES)) if (t === contentType) return e;
  return null;
}

function fileSegment(encoded: string): string {
  return decodeURIComponent(encoded).replace(FILE_ESCAPE_RE, (c) => FILE_ESCAPES[c]!);
}

function urlSegment(file: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(file);
  } catch {
    throw new UnmappablePath(`file name ${file} has malformed escapes`);
  }
  return encodeURIComponent(decoded);
}

/** The folder-relative path for a resource path, without any `$` suffix:
 * '/a/b c.ttl' -> 'a/b c.ttl', '/a/' -> 'a/', '/' -> ''. */
export function basePathOf(path: PodPath): string {
  if (path === '/') return '';
  const container = isContainer(path);
  const segments = (container ? path.slice(1, -1) : path.slice(1)).split('/').map(fileSegment);
  return segments.join('/') + (container ? '/' : '');
}

export interface DocumentFile {
  file: string;
  /** True when the extension cannot carry the type and the metadata file must. */
  typeInMeta: boolean;
}

/** Where a document of this type is stored. */
export function documentFile(path: PodPath, contentType: string): DocumentFile {
  if (isContainer(path)) throw new Error(`${path} is a container`);
  if (/\$\.\w+$/u.test(path)) throw new UnmappablePath('a document name may not end in $.<extension>');
  const base = basePathOf(path);
  const type = bareType(contentType);
  if (type === typeOfFileName(base)) return { file: base, typeInMeta: false };
  const ext = canonicalExtension(type);
  if (ext === null) return { file: `${base}$.${UNKNOWN_EXTENSION}`, typeInMeta: true };
  return { file: `${base}$.${ext}`, typeInMeta: false };
}

/** The metadata file of a resource ('a/b.ttl.meta', 'a/.meta'). Keyed by the
 * resource path, not its stored file name, as in CSS. */
export function metaFileOf(path: PodPath): string {
  return `${basePathOf(path)}.meta`;
}

export interface MappedFile {
  path: PodPath;
  /** The type the file name implies; for a `$.unknown` file the real type is
   * in its metadata file. */
  contentType: string;
}

/** The resource a stored document file represents. */
export function resourceOfFile(file: string): MappedFile {
  const contentType = typeOfFileName(file);
  const ext = extensionOf(file);
  const stripped = ext && file.endsWith(`$.${ext}`) ? file.slice(0, -(ext.length + 2)) : file;
  return { path: `/${stripped.split('/').map(urlSegment).join('/')}`, contentType };
}

/** The container a stored folder represents ('a/b/' -> '/a/b/'). */
export function containerOfFolder(folder: string): PodPath {
  const trimmed = folder.replace(/\/$/u, '');
  if (trimmed === '') return '/';
  return `/${trimmed.split('/').map(urlSegment).join('/')}/`;
}

/** Files that hold metadata rather than a resource of their own. */
export function isMetaFile(file: string): boolean {
  return file.endsWith('.meta');
}
