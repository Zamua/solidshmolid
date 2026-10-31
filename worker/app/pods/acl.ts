// Which authorizations govern a resource (WAC): its own ACL, else the nearest
// container above it with one. Each ACL is parsed once per version.

import { type PodPath, aclPathOf, ancestorsOf, isContainer } from '../../domain/pods/paths.js';
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
  ) {}

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
    if (hit && hit.etag === row.etag) return hit.auths;
    let auths: Authorization[] = [];
    const text = await this.readText(row);
    if (text !== null) {
      try {
        auths = authorizationsOf(await parseRdf(text, TURTLE, this.url(row.path)));
      } catch {
        // An ACL that does not parse grants nothing.
        auths = [];
      }
    }
    this.cache.set(row.path, { etag: row.etag, auths });
    return auths;
  }
}
