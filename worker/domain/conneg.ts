// Content negotiation over the Accept header.

import { bareType } from './layout.js';

interface Range {
  type: string;
  q: number;
}

function ranges(accept: string): Range[] {
  return accept
    .split(',')
    .map((part) => {
      const [type, ...params] = part.split(';').map((s) => s.trim());
      const q = params.find((p) => p.startsWith('q='));
      return { type: (type ?? '').toLowerCase(), q: q ? Number(q.slice(2)) : 1 };
    })
    .filter((r) => r.type !== '' && Number.isFinite(r.q));
}

function quality(type: string, accepted: Range[]): number {
  const [major] = type.split('/');
  let best: { q: number; specificity: number } | null = null;
  for (const r of accepted) {
    const specificity = r.type === type ? 3 : r.type === `${major}/*` ? 2 : r.type === '*/*' ? 1 : 0;
    if (specificity > 0 && (best === null || specificity > best.specificity)) best = { q: r.q, specificity };
  }
  return best?.q ?? 0;
}

/** The best of `available` for `accept`, or null when none is acceptable.
 * `available` is in preference order: ties go to the earlier type, so the
 * stored type comes first and is served unconverted when the client allows. */
export function negotiate(accept: string | null, available: string[]): string | null {
  if (!accept || accept.trim() === '') return available[0] ?? null;
  const accepted = ranges(accept);
  let best: { type: string; q: number } | null = null;
  for (const type of available) {
    const q = quality(bareType(type), accepted);
    if (q > 0 && (best === null || q > best.q)) best = { type, q };
  }
  return best?.type ?? null;
}
