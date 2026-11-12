import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

// The dependency rules, by layer and bounded context:
//   runtime -> app -> domain, nothing imports upward;
//   domain contexts see only themselves and domain/shared;
//   app contexts see the domain, app/shared, themselves, and the other
//   contexts they are allowed to orchestrate.
// A folder under domain/ or app/ without an entry below fails the suite, so a
// new context states its rule before it gets code.
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

/** The packages each layer may import; every other bare specifier, platform
 * modules (`cloudflare:`, `node:`) included, is refused. */
const PACKAGES: Record<string, string[]> = {
  domain: ['n3', 'mime-types', 'jsonld-streaming-parser', 'jsonld-streaming-serializer'],
  app: ['n3', 'mime-types', 'jsonld-streaming-parser', 'jsonld-streaming-serializer'],
};
const LAYERS = Object.keys(PACKAGES);

function entries(dir: string): { files: string[]; folders: string[] } {
  const names = readdirSync(dir);
  return {
    files: names.filter((n) => n.endsWith('.ts') && statSync(join(dir, n)).isFile()),
    folders: names.filter((n) => statSync(join(dir, n)).isDirectory()),
  };
}

function tsFiles(dir: string): string[] {
  const { files, folders } = entries(dir);
  return [...files.map((f) => join(dir, f)), ...folders.flatMap((f) => tsFiles(join(dir, f)))];
}

/** Every module a file names: static imports, re-exports, `import()` and
 * `import('...')` types alike, as the compiler finds them. */
function importsOf(file: string): string[] {
  return ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles.map((f) => f.fileName);
}

describe('the dependency rules hold', () => {
  it('every folder of a layer has a rule, and no file sits outside one', () => {
    for (const layer of LAYERS) {
      const { files, folders } = entries(join(ROOT, layer));
      expect(files, `files directly in ${layer}/`).toEqual([]);
      for (const folder of folders) expect(Object.keys(ALLOWED), `${layer}/${folder} has no rule`).toContain(`${layer}/${folder}`);
    }
  });

  for (const [area, allowed] of Object.entries(ALLOWED)) {
    it(`${area} imports only what it may`, () => {
      const files = tsFiles(join(ROOT, area));
      expect(files.length).toBeGreaterThan(0);
      const packages = PACKAGES[area.split('/')[0]!]!;
      for (const f of files) {
        for (const spec of importsOf(f)) {
          const where = `${relative(ROOT, f)} imports ${spec}`;
          if (!spec.startsWith('.')) {
            expect(packages, where).toContain(spec);
            continue;
          }
          const target = relative(ROOT, resolve(dirname(f), spec)).replace(/\.js$/u, '.ts');
          expect(
            allowed.some((a) => target === a || target.startsWith(`${a}/`)),
            where,
          ).toBe(true);
        }
      }
    });
  }

  it('finds dynamic imports and import types too', () => {
    const found = ts.preProcessFile("const a = await import('../runtime/x.js'); type E = import('cloudflare:workers').Env; export * from './y.js';", true, true);
    expect(found.importedFiles.map((f) => f.fileName).sort()).toEqual(['../runtime/x.js', './y.js', 'cloudflare:workers']);
  });
});
