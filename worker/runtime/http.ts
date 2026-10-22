// HTTP <-> pod service translation. Parses a request, calls one service
// method, shapes the result for the wire. No Solid rules live here.

import {
  BadRequest,
  Conflict,
  Forbidden,
  InsufficientStorage,
  MethodNotAllowed,
  NotAcceptable,
  NotFound,
  PayloadTooLarge,
  PodError,
  PreconditionFailed,
  RangeNotSatisfiable,
  StorageUnavailable,
  Unauthenticated,
  Unprocessable,
  UnsupportedMediaType,
} from '../app/errors.js';
import { type Access, type Agent, type Conditions, type EtagList, Pod, type RangeRequest, type ReadResult } from '../app/pod.js';
import { InvalidPath, type PodPath, aclPathOf, canonicalPath, isAclPath, isContainer } from '../domain/paths.js';
import { LDP, PIM } from '../domain/vocab.js';
import { wacAllow } from '../domain/wac.js';

const EXPOSED = [
  'Accept-Patch',
  'Accept-Post',
  'Accept-Put',
  'Accept-Ranges',
  'Allow',
  'Content-Range',
  'ETag',
  'Last-Modified',
  'Link',
  'Location',
  'WAC-Allow',
  'WWW-Authenticate',
].join(', ');

const METHODS = ['OPTIONS', 'HEAD', 'GET', 'PUT', 'POST', 'PATCH', 'DELETE'];

/** Serves one Solid request against `pod` as `agent`. */
export async function handleSolid(pod: Pod, request: Request, agent: Agent): Promise<Response> {
  const origin = request.headers.get('Origin');
  try {
    const url = new URL(request.url);
    let path: PodPath;
    try {
      path = canonicalPath(url.pathname);
    } catch (e) {
      if (e instanceof InvalidPath) throw new BadRequest(e.message);
      throw e;
    }
    const response = await dispatch(pod, request, path, agent);
    return withCors(response, request, origin);
  } catch (e) {
    return withCors(errorResponse(e), request, origin);
  }
}

async function dispatch(pod: Pod, request: Request, path: PodPath, agent: Agent): Promise<Response> {
  const h = request.headers;
  switch (request.method) {
    case 'OPTIONS':
      return new Response(null, { status: 204, headers: { Allow: allowFor(path).join(', '), ...acceptHeaders(path) } });
    case 'GET':
    case 'HEAD': {
      const result = await pod.read(path, agent, {
        accept: h.get('Accept'),
        range: request.method === 'GET' ? parseRange(h.get('Range')) : null,
        head: request.method === 'HEAD',
      });
      return readResponse(pod, result);
    }
    case 'PUT': {
      const r = await pod.put(path, agent, { stream: bodyOf(request) }, h.get('Content-Type'), conditionsOf(h));
      return writeResponse(pod, r.path, r.created, agent);
    }
    case 'POST': {
      const asContainer = linkTypes(h.get('Link')).some((t) => t === LDP('BasicContainer') || t === LDP('Container'));
      const r = await pod.post(path, agent, { stream: bodyOf(request) }, h.get('Content-Type'), h.get('Slug'), asContainer);
      return writeResponse(pod, r.path, true, agent);
    }
    case 'PATCH': {
      const r = await pod.patch(path, agent, await request.text(), h.get('Content-Type'), conditionsOf(h));
      return writeResponse(pod, r.path, r.created, agent);
    }
    case 'DELETE':
      await pod.remove(path, agent, conditionsOf(h));
      return new Response(null, { status: 204 });
    default:
      throw new MethodNotAllowed(`${request.method} is not supported`, METHODS);
  }
}

function readResponse(pod: Pod, r: ReadResult): Response {
  const headers = new Headers({
    'Content-Type': r.contentType,
    ETag: `"${r.etag}"`,
    'Last-Modified': new Date(r.modified).toUTCString(),
    'WAC-Allow': wacAllow(r.access.user, r.access.public),
    Link: linkHeader(pod, r.path),
    Allow: allowFor(r.path).join(', '),
    ...acceptHeaders(r.path),
  });
  if (r.kind === 'document') headers.set('Accept-Ranges', 'bytes');
  if (r.range && r.size !== null) {
    headers.set('Content-Range', `bytes ${r.range.start}-${r.range.end}/${r.size}`);
    headers.set('Content-Length', String(r.range.end - r.range.start + 1));
    return new Response(r.body, { status: 206, headers });
  }
  if (typeof r.body === 'string') headers.set('Content-Length', String(new TextEncoder().encode(r.body).byteLength));
  else if (r.size !== null) headers.set('Content-Length', String(r.size));
  return new Response(r.body, { status: 200, headers });
}

async function writeResponse(pod: Pod, path: PodPath, created: boolean, agent: Agent): Promise<Response> {
  const access: Access = await pod.access(path, agent);
  const headers = new Headers({ 'WAC-Allow': wacAllow(access.user, access.public), Link: linkHeader(pod, path) });
  if (!created) return new Response(null, { status: 204, headers });
  headers.set('Location', pod.url(path));
  return new Response(null, { status: 201, headers });
}

function linkHeader(pod: Pod, path: PodPath): string {
  const links = [`<${LDP('Resource')}>; rel="type"`];
  if (isContainer(path)) links.push(`<${LDP('Container')}>; rel="type"`, `<${LDP('BasicContainer')}>; rel="type"`);
  if (path === '/') links.push(`<${PIM('Storage')}>; rel="type"`);
  if (!isAclPath(path)) links.push(`<${pod.url(aclPathOf(path))}>; rel="acl"`);
  return links.join(', ');
}

function allowFor(path: PodPath): string[] {
  if (path === '/') return ['OPTIONS', 'HEAD', 'GET', 'POST', 'PUT'];
  if (isContainer(path)) return ['OPTIONS', 'HEAD', 'GET', 'POST', 'PUT', 'DELETE'];
  return ['OPTIONS', 'HEAD', 'GET', 'PUT', 'PATCH', 'DELETE'];
}

function acceptHeaders(path: PodPath): Record<string, string> {
  if (isContainer(path)) return { 'Accept-Post': '*/*', 'Accept-Put': '*/*' };
  return { 'Accept-Patch': 'text/n3', 'Accept-Put': '*/*' };
}

function bodyOf(request: Request): ReadableStream<Uint8Array> {
  return request.body ?? new Response('').body!;
}

function etagList(value: string | null): EtagList {
  if (value === null) return null;
  if (value.trim() === '*') return '*';
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function conditionsOf(h: Headers): Conditions {
  return { ifMatch: etagList(h.get('If-Match')), ifNoneMatch: etagList(h.get('If-None-Match')) };
}

/** A single byte range; anything else is ignored and the whole body served. */
export function parseRange(value: string | null): RangeRequest | null {
  const m = value ? /^bytes=(\d*)-(\d*)$/u.exec(value.trim()) : null;
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (a === '') return { suffix: Number(b) };
  const start = Number(a);
  const end = b === '' ? null : Number(b);
  if (end !== null && end < start) return null;
  return { start, end };
}

function linkTypes(value: string | null): string[] {
  if (!value) return [];
  return [...value.matchAll(/<([^>]*)>\s*;\s*rel="?type"?/gu)].map((m) => m[1]!);
}

const STATUS: [new (...args: never[]) => PodError, number][] = [
  [BadRequest, 400],
  [Unauthenticated, 401],
  [Forbidden, 403],
  [NotFound, 404],
  [MethodNotAllowed, 405],
  [NotAcceptable, 406],
  [Conflict, 409],
  [PreconditionFailed, 412],
  [PayloadTooLarge, 413],
  [UnsupportedMediaType, 415],
  [RangeNotSatisfiable, 416],
  [Unprocessable, 422],
  [InsufficientStorage, 507],
  [StorageUnavailable, 503],
];

function errorResponse(e: unknown): Response {
  if (!(e instanceof PodError)) {
    console.error(JSON.stringify({ level: 'error', msg: 'unhandled', error: String((e as Error)?.stack ?? e) }));
    return new Response('internal error\n', { status: 500, headers: { 'Content-Type': 'text/plain' } });
  }
  const status = STATUS.find(([type]) => e instanceof type)?.[1] ?? 500;
  const headers = new Headers({ 'Content-Type': 'text/plain; charset=utf-8' });
  if (e instanceof MethodNotAllowed) headers.set('Allow', e.allow.join(', '));
  if (e instanceof RangeNotSatisfiable) headers.set('Content-Range', `bytes */${e.size}`);
  if (e instanceof StorageUnavailable && e.retryAfter !== null) headers.set('Retry-After', String(e.retryAfter));
  if (e instanceof Unauthenticated) headers.set('WWW-Authenticate', 'DPoP algs="ES256 PS256 RS256"');
  return new Response(`${e.message}\n`, { status, headers });
}

/** Solid apps run in other origins and send credentials, so every response
 * names the caller's origin rather than '*'. */
export function withCors(response: Response, request: Request, origin: string | null): Response {
  const out = new Response(response.body, response);
  const h = out.headers;
  h.set('Access-Control-Allow-Origin', origin ?? '*');
  if (origin) h.set('Access-Control-Allow-Credentials', 'true');
  h.set('Access-Control-Expose-Headers', EXPOSED);
  h.append('Vary', 'Origin');
  if (request.method === 'OPTIONS') {
    h.set('Access-Control-Allow-Methods', METHODS.join(', '));
    const asked = request.headers.get('Access-Control-Request-Headers');
    if (asked) h.set('Access-Control-Allow-Headers', asked);
    h.set('Access-Control-Max-Age', '600');
  }
  return out;
}
