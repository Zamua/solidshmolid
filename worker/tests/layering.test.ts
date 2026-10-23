import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// The dependency rules, by layer and bounded context:
//   runtime -> app -> domain, nothing imports upward;
//   domain contexts see only themselves and domain/shared;
//   app contexts see the domain, app/shared, themselves, and the other
//   contexts they are allowed to orchestrate.
const ROOT = new URL('..', import.meta.url).pathname;

const ALLOWED: Record<string, string[]> = {
  'domain/shared': ['domain/shared'],
  'domain/pods': ['domain/pods', 'domain/shared'],
  'domain/identity': ['domain/identity', 'domain/shared'],
  'domain/accounts': ['domain/accounts', 'domain/shared'],
  'app/shared': ['app/shared', 'domain'],
  'app/pods': ['app/pods', 'app/shared', 'app/storage/ports.ts', 'domain'],
  'app/storage': ['app/storage', 'app/shared', 'app/pods', 'domain'],
  'app/identity': ['app/identity', 'app/shared', 'domain'],
  'app/accounts': ['app/accounts', 'app/shared', 'app/storage/ports.ts', 'domain'],
};

const BANNED_SPECIFIERS = [/^cloudflare:/, /^node:/];

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? tsFiles(p) : name.endsWith('.ts') ? [p] : [];
  });
}

function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

describe('the dependency rules hold', () => {
  for (const [area, allowed] of Object.entries(ALLOWED)) {
    it(`${area} imports only what it may`, () => {
      const files = tsFiles(join(ROOT, area));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        for (const spec of importsOf(f)) {
          const where = `${relative(ROOT, f)} imports ${spec}`;
          for (const banned of BANNED_SPECIFIERS) expect(banned.test(spec), where).toBe(false);
          if (!spec.startsWith('.')) continue;
          const target = relative(ROOT, resolve(dirname(f), spec)).replace(/\.js$/u, '.ts');
          expect(
            allowed.some((a) => target === a || target.startsWith(`${a}/`)),
            where,
          ).toBe(true);
        }
      }
    });
  }

  it('nothing outside runtime imports runtime', () => {
    for (const area of ['domain', 'app']) {
      for (const f of tsFiles(join(ROOT, area))) {
        for (const spec of importsOf(f)) {
          if (!spec.startsWith('.')) continue;
          expect(relative(ROOT, resolve(dirname(f), spec)).startsWith('runtime'), `${relative(ROOT, f)} imports ${spec}`).toBe(false);
        }
      }
    }
  });
});
