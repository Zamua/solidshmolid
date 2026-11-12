// AES-GCM under TOKEN_KEY for the credentials kept at rest (storage refresh
// tokens). The associated data names the record a value belongs to, so a
// sealed value copied into another record does not open.
//
// A key can be replaced without cutting anything off: values are sealed under
// the current key and still open under the keys it replaced, for as long as
// those are configured. AES-GCM authenticates, so a value opens under the key
// that sealed it and under no other.

/** A value opened, and whether the current key sealed it. */
export interface Opened {
  plain: string;
  current: boolean;
}

export class Sealer {
  private readonly keys: Promise<CryptoKey>[] = [];

  /** `older` holds the keys `keyBase64` replaced, newest first. */
  constructor(
    private readonly keyBase64: string | undefined,
    private readonly older: string[] = [],
  ) {}

  async seal(plain: string, recordId: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(recordId) }, await this.cryptoKey(0), new TextEncoder().encode(plain)),
    );
    const out = new Uint8Array(iv.byteLength + ct.byteLength);
    out.set(iv);
    out.set(ct, iv.byteLength);
    return btoa(String.fromCharCode(...out));
  }

  async open(sealed: string, recordId: string): Promise<string> {
    return (await this.unseal(sealed, recordId)).plain;
  }

  /** Opens under the current key, else under each key it replaced. */
  async unseal(sealed: string, recordId: string): Promise<Opened> {
    const bytes = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
    let refusal: unknown;
    for (let i = 0; i <= this.older.length; i++) {
      try {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(recordId) }, await this.cryptoKey(i), bytes.slice(12));
        return { plain: new TextDecoder().decode(plain), current: i === 0 };
      } catch (e) {
        // Only "this key did not seal it" moves on; a malformed key is the deployment's fault.
        if (!(e instanceof Error) || e.name !== 'OperationError') throw e;
        refusal ??= e;
      }
    }
    throw refusal;
  }

  /** Key 0 is the current one; the rest are the keys it replaced. */
  private cryptoKey(i: number): Promise<CryptoKey> {
    return (this.keys[i] ??= i === 0 ? importKey(this.keyBase64, 'TOKEN_KEY') : importKey(this.older[i - 1], 'TOKEN_KEY_OLD'));
  }
}

async function importKey(base64: string | undefined, name: string): Promise<CryptoKey> {
  if (!base64) throw new Error(`${name} is not configured`);
  const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  if (raw.byteLength !== 32) throw new Error(`${name} must be 32 bytes, base64`);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** The keys named in a list variable: base64 values separated by commas or spaces. */
export function keyList(value: string | undefined): string[] {
  return (value ?? '').split(/[\s,]+/u).filter((k) => k !== '');
}
