// Draws the wordmark's cloud into the favicon and home-screen icons and bakes
// them into worker/runtime/http/assets/appIconData.ts, so the Worker serves
// them without an asset pipeline. Run `make icons` after changing anything here.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

/** The cloud, in a 34 x 22 box: three puffs on a flat base that meets the
 * outer puffs at their lowest points, so the bottom edge stays smooth. */
const PUFFS = [
  [9, 14, 7],
  [18, 9, 9],
  [26, 14, 7],
];
const BASE = { x: 9, y: 12, w: 17, h: 9 };
const BOUNDS = { x: 2, y: 0, w: 31, h: 21 };

export const CLOUD =
  PUFFS.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`).join('') +
  `<rect x="${BASE.x}" y="${BASE.y}" width="${BASE.w}" height="${BASE.h}"/>`;

const SKY_TOP = [0x4f, 0x80, 0xea];
const SKY_BOTTOM = [0x2a, 0x52, 0xb8];
const hex = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;

/** `cloud` is the cloud's width as a share of the tile; `round` the corner
 * radius as a share of it (0 fills the square, for platforms that mask it). */
const TAB = { cloud: 0.8, round: 0.22 };
const HOME = { cloud: 0.6, round: 0.22 };
const BLEED = { cloud: 0.6, round: 0 };

function roundBox(px, py, hx, hy, r) {
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function cloudDistance(u, v) {
  let d = roundBox(u - (BASE.x + BASE.w / 2), v - (BASE.y + BASE.h / 2), BASE.w / 2, BASE.h / 2, 0);
  for (const [cx, cy, r] of PUFFS) d = Math.min(d, Math.hypot(u - cx, v - cy) - r);
  return d;
}

const coverage = (distancePx) => Math.min(1, Math.max(0, 0.5 - distancePx));

/** RGBA pixels of a size x size icon, anti-aliased from signed distances. */
export function render(size, { cloud, round }) {
  const scale = (cloud * size) / BOUNDS.w;
  const ox = size / 2 - (BOUNDS.x + BOUNDS.w / 2) * scale;
  const oy = size / 2 - (BOUNDS.y + BOUNDS.h / 2) * scale;
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const t = (y + 0.5) / size;
    const sky = SKY_TOP.map((c, i) => c + (SKY_BOTTOM[i] - c) * t);
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const tile = coverage(roundBox(px - size / 2, py - size / 2, size / 2, size / 2, round * size));
      const white = coverage(cloudDistance((px - ox) / scale, (py - oy) / scale) * scale);
      const at = (y * size + x) * 4;
      for (let i = 0; i < 3; i++) out[at + i] = Math.round(sky[i] + (255 - sky[i]) * white);
      out[at + 3] = Math.round(255 * tile);
    }
  }
  return out;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rows.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An ICO holding PNG images, which every browser that still asks for
 * /favicon.ico reads. */
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    head[at] = size % 256;
    head[at + 1] = size % 256;
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.data)]);
}

const pngOf = (size, layout) => png(size, render(size, layout));

function faviconSvg() {
  const scale = (TAB.cloud * 64) / BOUNDS.w;
  const tx = 32 - (BOUNDS.x + BOUNDS.w / 2) * scale;
  const ty = 32 - (BOUNDS.y + BOUNDS.h / 2) * scale;
  const n = (v) => Number(v.toFixed(3));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<linearGradient id="sky" x2="0" y2="1"><stop stop-color="${hex(SKY_TOP)}"/><stop offset="1" stop-color="${hex(SKY_BOTTOM)}"/></linearGradient>` +
    `<rect width="64" height="64" rx="${n(TAB.round * 64)}" fill="url(#sky)"/>` +
    `<g fill="#fff" transform="translate(${n(tx)} ${n(ty)}) scale(${n(scale)})">${CLOUD}</g></svg>`
  );
}

function main() {
  const files = {
    '/favicon.ico': { type: 'image/x-icon', data: ico([16, 32, 48].map((size) => ({ size, data: pngOf(size, TAB) }))) },
    '/apple-touch-icon.png': { type: 'image/png', data: pngOf(180, BLEED) },
    '/icons/192.png': { type: 'image/png', data: pngOf(192, HOME) },
    '/icons/512.png': { type: 'image/png', data: pngOf(512, HOME) },
    '/icons/maskable-512.png': { type: 'image/png', data: pngOf(512, BLEED) },
  };
  const manifestIcons = [
    { src: '/icons/192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ];
  const entries = Object.entries(files).map(([path, { type, data }]) => `  '${path}': { type: '${type}', base64: '${data.toString('base64')}' },`);
  writeFileSync(
    'worker/runtime/http/assets/appIconData.ts',
    `// Generated by scripts/app-icons.mjs. Do not edit; run \`make icons\`.

/** The wordmark's cloud, in a 34 x 22 box. */
export const CLOUD = '${CLOUD}';

export const FAVICON_SVG = '${faviconSvg()}';

export const MANIFEST_ICONS = [
${manifestIcons.map((i) => `  { src: '${i.src}', sizes: '${i.sizes}', type: '${i.type}', purpose: '${i.purpose}' },`).join('\n')}
] as const;

export const ICON_FILES: Record<string, { type: string; base64: string }> = {
${entries.join('\n')}
};
`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
