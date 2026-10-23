// Screenshots every mockup at iPhone 17 Pro size (402x874 points, 3x).
// Usage: node shoot.mjs <playwright-core dir> <out dir>
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [, , pwDir, outDir] = process.argv;
const { chromium } = createRequire(import.meta.url)(pwDir);
const here = new URL('.', import.meta.url).pathname;

const browser = await chromium.launch(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {});
const page = await browser.newPage({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 3 });
for (const file of readdirSync(here).filter((f) => /^\d\d-.*\.html$/u.test(f)).sort()) {
  await page.goto(`file://${join(here, file)}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(outDir, file.replace('.html', '.png')) });
}
await browser.close();
