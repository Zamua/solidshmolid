// AES-GCM under TOKEN_KEY for the credentials kept at rest (storage refresh
// tokens). The associated data names the record a value belongs to, so a
// sealed value copied into another record does not open.

export class Sealer {
  private key: CryptoKey | null = null;

  constructor(private readonly keyBase64: string | undefined) {}

  async seal(plain: string, recordId: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(recordId) }, await this.cryptoKey(), new TextEncoder().encode(plain)),
    );
    const out = new Uint8Array(iv.byteLength + ct.byteLength);
    out.set(iv);
    out.set(ct, iv.byteLength);
    return btoa(String.fromCharCode(...out));
  }

  async open(sealed: string, recordId: string): Promise<string> {
    const bytes = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(recordId) },
      await this.cryptoKey(),
      bytes.slice(12),
    );
    return new TextDecoder().decode(plain);
  }

  private async cryptoKey(): Promise<CryptoKey> {
    if (this.key) return this.key;
    if (!this.keyBase64) throw new Error('TOKEN_KEY is not configured');
    const raw = Uint8Array.from(atob(this.keyBase64), (c) => c.charCodeAt(0));
    if (raw.byteLength !== 32) throw new Error('TOKEN_KEY must be 32 bytes, base64');
    this.key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return this.key;
  }
}
