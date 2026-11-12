// Which authorizations govern a resource (WAC): its own ACL, else the nearest
// container above it with one. Each ACL is parsed once per version, and the
// parsed copy is used only while the index is known to match the folder.

import { InvalidPath, type PodPath, aclPathOf, ancestorsOf, canonicalPath, isContainer } from '../../domain/pods/paths.js';
import { TURTLE, parseRdf } from '../../domain/shared/rdf.js';
import { type Authorization, authorizationsOf } from '../../domain/pods/wac.js';
import type { DocumentRow, PodIndex } from './ports.js';

export interface EffectiveAcl {
  auths: Authorization[];
  /** The container whose ACL applies by default, or null for the resource's own. */
  inheritedFrom: string | null;
}

export class AclResolver {
  private readonly cache = new Map<PodPath, { etag: string; auths: Authorization[] }>();

  constructor(
    private readonly index: PodIndex,
    private readonly url: (path: PodPath) => string,
    private readonly readText: (row: DocumentRow) => Promise<string | null>,
    private readonly fresh: () => boolean = () => true,
  ) {}

  /** Drops the parsed ACL at `path`: its row was replaced or removed. */
  forget(path: PodPath): void {
    this.cache.delete(path);
  }

  forgetAll(): void {
    this.cache.clear();
  }

  async effective(path: PodPath): Promise<EffectiveAcl> {
    for (const candidate of [path, ...ancestorsOf(path).reverse()]) {
      if (!isContainer(candidate) && candidate !== path) continue;
      const row = this.index.get(aclPathOf(candidate));
      if (row?.kind !== 'document') continue;
      return { auths: await this.load(row), inheritedFrom: candidate === path ? null : this.url(candidate) };
    }
    return { auths: [], inheritedFrom: null };
  }

  private async load(row: DocumentRow): Promise<Authorization[]> {
    const hit = this.cache.get(row.path);
    if (hit && hit.etag === row.etag && this.fresh()) return hit.auths;
    let auths: Authorization[] = [];
    const text = await this.readText(row);
    if (text !== null) {
      try {
        auths = authorizationsOf(await parseRdf(text, TURTLE, this.url(row.path))).map((a) => ({ ...a, accessTo: a.accessTo.map(this.canonical), defaults: a.defaults.map(this.canonical) }));
      } catch {
        // An ACL that does not parse grants nothing.
        auths = [];
      }
    }
    this.cache.set(row.path, { etag: row.etag, auths });
    return auths;
  }

  /** An IRI of this pod as the pod spells it. An ACL may name a resource by
   * any URL that reaches it (`:` or `%3A`), and the comparison is by string. */
  private readonly canonical = (iri: string): string => {
    const origin = this.url('/').slice(0, -1);
    if (!iri.startsWith(`${origin}/`) || /[?#]/u.test(iri)) return iri;
    try {
      return this.url(canonicalPath(iri.slice(origin.length)));
    } catch (e) {
      if (e instanceof InvalidPath) return iri;
      throw e;
    }
  };
}
