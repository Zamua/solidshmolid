import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The dependency rule: runtime -> app -> domain, and nothing imports upward.
const ROOT = new URL('..', import.meta.url).pathname;

const FORBIDDEN: Record<string, RegExp[]> = {
  domain: [/^\.\.\/app\//, /^\.\.\/runtime\//, /cloudflare:/, /^node:/],
  app: [/^\.\.\/runtime\//, /cloudflare:/, /^node:/],
};

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? tsFiles(p) : name.endsWith('.ts') ? [p] : [];
  });
}

function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

describe('the dependency rule holds', () => {
  for (const [layer, banned] of Object.entries(FORBIDDEN)) {
    it(`${layer} imports nothing it may not`, () => {
      const files = tsFiles(join(ROOT, layer));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        for (const im of importsOf(f)) {
          for (const b of banned) expect(b.test(im), `${f.slice(ROOT.length)} imports ${im}`).toBe(false);
        }
      }
    });
  }
});
