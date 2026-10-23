// Pod ids: the random first label of a pod's host (`k3x9fqm7.pods.example`).
// People never choose them, so there is nothing to squat; the alphabet leaves
// out characters that read alike (0/o, 1/i/l).

export const POD_ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
export const POD_ID_LENGTH = 8;

const ID = new RegExp(`^[${POD_ID_ALPHABET}]{${POD_ID_LENGTH}}$`, 'u');

export function isPodId(value: string): boolean {
  return ID.test(value);
}

/** An id drawn from `randomBytes`, without modulo bias: bytes at or above
 * the largest multiple of the alphabet size are skipped. Returns null when
 * the bytes run out first; the caller draws more. */
export function podIdFrom(randomBytes: Uint8Array): string | null {
  const n = POD_ID_ALPHABET.length;
  const limit = 256 - (256 % n);
  let id = '';
  for (const b of randomBytes) {
    if (b >= limit) continue;
    id += POD_ID_ALPHABET[b % n];
    if (id.length === POD_ID_LENGTH) return id;
  }
  return null;
}
