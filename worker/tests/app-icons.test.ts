import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { appIconRoute, FAVICON_PATH, MANIFEST_PATH, TOUCH_ICON_PATH } from '../runtime/http/assets/appIcons.js';
import { page } from '../runtime/http/pages/shell.js';

const APEX = 'https://account.example';

async function get(path: string): Promise<Response> {
  const response = appIconRoute(new Request(`${APEX}${path}`), new URL(`${APEX}${path}`));
  if (!response) throw new Error(`no route for ${path}`);
  return response;
}

const bytesOf = async (path: string) => new Uint8Array(await (await get(path)).arrayBuffer());

function pngSize(png: Uint8Array): number[] {
  const view = new DataView(png.buffer, png.byteOffset);
  return [view.getUint32(16), view.getUint32(20)];
}

/** Every alpha value of an unfiltered RGBA PNG, as the generator writes them. */
function alphas(png: Uint8Array): number[] {
  const view = new DataView(png.buffer, png.byteOffset);
  const [width] = pngSize(png);
  const idat: Uint8Array[] = [];
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    if (String.fromCharCode(...png.subarray(at + 4, at + 8)) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const rows = inflateSync(Buffer.concat(idat));
  const out: number[] = [];
  for (let at = 0; at < rows.length; at += width! * 4 + 1) {
    for (let x = 0; x < width!; x++) out.push(rows[at + 1 + x * 4 + 3]!);
  }
  return out;
}

describe('app icons', () => {
  it('serves every icon the manifest lists as a PNG of its declared size', async () => {
    const manifest = (await (await get(MANIFEST_PATH)).json()) as { start_url: string; icons: { src: string; sizes: string; type: string }[] };
    expect(manifest.start_url).toBe('/');
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const { src, sizes, type } of manifest.icons) {
      const response = await get(src);
      expect(response.headers.get('Content-Type')).toBe(type);
      expect(pngSize(new Uint8Array(await response.arrayBuffer())).join('x')).toBe(sizes);
    }
  });

  it('fills the whole square in icons the platform masks', async () => {
    for (const path of [TOUCH_ICON_PATH, '/icons/maskable-512.png']) {
      expect(alphas(await bytesOf(path)).every((a) => a === 255)).toBe(true);
    }
    expect(pngSize(await bytesOf(TOUCH_ICON_PATH))).toEqual([180, 180]);
  });

  it('packs PNG images into /favicon.ico', async () => {
    const ico = await bytesOf('/favicon.ico');
    const view = new DataView(ico.buffer, ico.byteOffset);
    expect(view.getUint16(2, true)).toBe(1);
    const count = view.getUint16(4, true);
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const offset = view.getUint32(6 + 16 * i + 12, true);
      expect([...ico.subarray(offset + 1, offset + 4)]).toEqual([0x50, 0x4e, 0x47]);
      expect(pngSize(ico.subarray(offset))[0]).toBe(ico[6 + 16 * i]);
    }
  });

  it('serves the SVG favicon and leaves other paths and methods alone', async () => {
    expect((await get(FAVICON_PATH)).headers.get('Content-Type')).toBe('image/svg+xml');
    expect(appIconRoute(new Request(`${APEX}/other.png`), new URL(`${APEX}/other.png`))).toBeNull();
    expect(appIconRoute(new Request(`${APEX}${FAVICON_PATH}`, { method: 'POST' }), new URL(`${APEX}${FAVICON_PATH}`))).toBeNull();
  });
});

describe('page icons', () => {
  it('links the icons and the manifest on the account site', async () => {
    const html = await page('t', 'b').text();
    expect(html).toContain(`<link rel="icon" href="${FAVICON_PATH}"`);
    expect(html).toContain(`<link rel="apple-touch-icon" href="${TOUCH_ICON_PATH}">`);
    expect(html).toContain(`<link rel="manifest" href="${MANIFEST_PATH}">`);
  });

  it("takes a pod page's icons from the account site, and allows them", async () => {
    const response = page('t', 'b', 200, `${APEX}/`);
    const html = await response.text();
    expect(html).toContain(`<link rel="icon" href="${APEX}${FAVICON_PATH}"`);
    expect(html).not.toContain('rel="manifest"');
    expect(response.headers.get('Content-Security-Policy')).toMatch(new RegExp(`img-src [^;]*${APEX.replaceAll('.', '\\.')}`, 'u'));
  });
});
