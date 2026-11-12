// The pod service: the Solid resource semantics over the index and the user's
// storage.
//
// Every write goes storage first, index second, so a failure between the two
// leaves either an unindexed file or a row whose file is gone; both are
// repairable from the folder, and the folder is never missing a resource the
// index claims to have written.

import { containerDescription } from '../../domain/pods/container.js';
import { negotiate } from '../../domain/pods/conneg.js';
import { UnmappablePath, basePathOf, documentFile, metaFileOf } from '../../domain/pods/layout.js';
import { bareType } from '../../domain/shared/mediaTypes.js';
import { ROOT_ACL, allowedMethods } from '../../domain/pods/methods.js';
import { InvalidPatch, PatchConflict, applyPatch, modesForPatch, parsePatch } from '../../domain/pods/n3patch.js';
import {
  type PodPath,
  aclPathOf,
  ancestorsOf,
  childPath,
  foldKey,
  isAclPath,
  isContainer,
  isMetaPath,
  otherKind,
  parentOf,
  shadowsAuxiliary,
  subjectOfAcl,
} from '../../domain/pods/paths.js';
import { InvalidRdf, N3, RDF_TYPES, TURTLE, isRdfType, parseRdf, serializeRdf } from '../../domain/shared/rdf.js';
import { type Mode, MODES, authorizationsOf, grantedModes } from '../../domain/pods/wac.js';
import { MA, SOLID } from '../../domain/shared/vocab.js';
import { PROFILE_PATH, webidAt } from '../../domain/pods/profile.js';
import { podRootAcl, profileAcl } from '../../domain/pods/starter.js';
import {
  type Conditions,
  type RangeRequest,
  etagOfRev,
  preconditionFailure,
  representationEtag,
  resolveRange,
  slugName,
} from '../../domain/pods/requests.js';
import { readAll } from '../shared/streams.js';
import {
  BadRequest,
  Conflict,
  Forbidden,
  MethodNotAllowed,
  NotAcceptable,
  NotFound,
  PayloadTooLarge,
  PreconditionFailed,
  RangeNotSatisfiable,
  Unauthenticated,
  Unprocessable,
  UnsupportedMediaType,
} from '../shared/errors.js';
import { AclResolver } from './acl.js';
import { type ContainerRow, type DocumentRow, type PodIndex, type ResourceRow } from './ports.js';
import { newContainerRow, touch } from './rows.js';
import { type ByteRange, type FileStore, type ListedEntry, RevisionConflict } from '../storage/ports.js';
import { type ReconcileReport, applyChanges, rebuildIndex } from './reconcile.js';
import type { Quad } from 'n3';
import { Serial } from '../shared/serial.js';

/** RDF bodies are parsed in memory; anything larger is refused. */
export const RDF_LIMIT = 8 * 1024 * 1024;
/** RDF documents up to this size are served from the index cache. */
export const CACHE_LIMIT = 64 * 1024;

export interface Agent {
  webid: string | null;
}

export interface Body {
  stream: ReadableStream<Uint8Array>;
}

export interface Access {
  user: Set<Mode>;
  public: Set<Mode>;
}

export interface ListingEntry {
  path: PodPath;
  kind: 'container' | 'document';
  contentType: string | null;
  size: number;
  modified: string;
}

export interface ReadResult {
  kind: 'document' | 'container';
  path: PodPath;
  contentType: string;
  /** Unquoted. Converted representations carry a `+<type>` suffix. */
  etag: string;
  modified: string;
  /** Null for HEAD. */
  body: ReadableStream<Uint8Array> | string | null;
  /** Byte length of the full representation, when known without serializing. */
  size: number | null;
  range: ByteRange | null;
  access: Access;
}

export interface WriteResult {
  path: PodPath;
  created: boolean;
}

export interface ReadOptions {
  accept: string | null;
  range: RangeRequest | null;
  head: boolean;
}

export interface PodDeps {
  index: PodIndex;
  files: FileStore;
  /** Origin of the pod, no trailing slash: 'https://alice.example'. */
  base: string;
  now: () => Date;
  newId: () => string;
  /** The pod's write queue, given when several `Pod`s serve one index. */
  writes?: Serial;
}

const ALL_MODES = new Set<Mode>(MODES);
const ACL_TYPE = TURTLE;

export class Pod {
  private readonly writes: Serial;
  private readonly acls: AclResolver;

  constructor(private readonly deps: PodDeps) {
    this.writes = deps.writes ?? new Serial();
    this.acls = new AclResolver(deps.index, (path) => this.url(path), (row) => this.readText(row));
  }

  url(path: PodPath): string {
    return `${this.deps.base}${path}`;
  }

  isProvisioned(): boolean {
    return this.deps.index.state() !== null;
  }

  // ---- provisioning ----------------------------------------------------

  /** Creates the root container and its ACL, and with `profile` the owner's
   * profile document (a WebID's pod; further pods have none). `left` is what
   * an interrupted attempt already wrote to the folder: those documents are
   * kept and only the missing ones written. */
  provision(owner: string, profile: string | null, left: ListedEntry[] = []): Promise<void> {
    return this.writes.run(async () => {
      const { index, files } = this.deps;
      const resumed = left.some((e) => e.kind === 'file');
      if (index.state() && !resumed) throw new Conflict('pod already exists');
      await files.makeFolder('');
      if (resumed) await rebuildIndex(this.deps, left);
      if (!index.get('/')) index.atomically(() => index.upsert(newContainerRow('/', this.deps)));
      const starter: [PodPath, string, string][] = [['/.acl', ACL_TYPE, podRootAcl(owner)]];
      if (profile !== null) starter.push([PROFILE_PATH, TURTLE, profile], [aclPathOf(PROFILE_PATH), ACL_TYPE, profileAcl(owner)]);
      for (const [path, type, text] of starter) if (!index.get(path)) await this.storeRdf(path, type, text, null);
      if (!index.state()) index.setState({ owner, created: this.deps.now().toISOString() });
    });
  }

  // ---- reconcile ------------------------------------------------------------

  /** Takes over an existing pod folder: the index becomes what it holds. */
  adopt(owner: string, entries: ListedEntry[]): Promise<ReconcileReport> {
    return this.writes.run(async () => {
      const report = await rebuildIndex(this.deps, entries);
      if (!this.deps.index.state()) this.deps.index.setState({ owner, created: this.deps.now().toISOString() });
      return report;
    });
  }

  /** Folds in changes made to the folder outside this server. */
  applyChanges(entries: ListedEntry[]): Promise<ReconcileReport> {
    return this.writes.run(() => applyChanges(this.deps, entries));
  }

  // ---- access control ---------------------------------------------------

  /** The modes `agent` holds on `path`, which need not exist. */
  async modes(path: PodPath, agent: Agent): Promise<Set<Mode>> {
    if (isAclPath(path)) {
      const onSubject = await this.modes(subjectOfAcl(path), agent);
      return onSubject.has('control') ? new Set(ALL_MODES) : new Set();
    }
    const { auths, inheritedFrom } = await this.acls.effective(path);
    return grantedModes(auths, { url: this.url(path), inheritedFrom }, agent.webid);
  }

  async access(path: PodPath, agent: Agent): Promise<Access> {
    return { user: await this.modes(path, agent), public: await this.modes(path, { webid: null }) };
  }

  private async require(path: PodPath, agent: Agent, needs: Mode[]): Promise<void> {
    const held = await this.modes(path, agent);
    if (needs.every((m) => held.has(m))) return;
    const label = `${needs.join('+')} on ${path}`;
    throw agent.webid === null ? new Unauthenticated(label) : new Forbidden(label);
  }

  // ---- reads --------------------------------------------------------------

  /** A container's members, for people browsing it (not the LDP view). */
  async listing(container: PodPath, agent: Agent): Promise<ListingEntry[]> {
    const row = this.deps.index.get(container);
    await this.require(container, agent, ['read']);
    if (!row) throw new NotFound(container);
    if (row.kind !== 'container') throw new BadRequest(`${container} is not a folder`);
    return this.members(container).map((m) =>
      m.kind === 'document'
        ? { path: m.path, kind: m.kind, contentType: m.contentType, size: m.size, modified: m.modified }
        : { path: m.path, kind: m.kind, contentType: null, size: 0, modified: m.modified },
    );
  }

  async read(path: PodPath, agent: Agent, options: ReadOptions): Promise<ReadResult> {
    if (isMetaPath(path)) throw new NotFound(path);
    const row = this.deps.index.get(path);
    if (!row) {
      await this.require(path, agent, ['read']);
      throw new NotFound(path);
    }
    await this.require(path, agent, ['read']);
    const access = await this.access(path, agent);
    return row.kind === 'container' ? this.readContainer(row, options, access) : this.readDocument(row, options, access);
  }

  private async readContainer(row: ContainerRow, options: ReadOptions, access: Access): Promise<ReadResult> {
    const type = negotiate(options.accept, [...RDF_TYPES]);
    if (!type) throw new NotAcceptable('containers are served as RDF');
    const members = this.members(row.path).map((m) => ({ url: this.url(m.path) }));
    const quads = containerDescription(this.url(row.path), members, row.modified, row.path === '/');
    return {
      kind: 'container',
      path: row.path,
      contentType: type,
      etag: type === TURTLE ? row.etag : representationEtag(row.etag, type),
      modified: row.modified,
      body: options.head ? null : await serializeRdf(quads, type, this.url(row.path)),
      size: null,
      range: null,
      access,
    };
  }

  private async readDocument(row: DocumentRow, options: ReadOptions, access: Access): Promise<ReadResult> {
    const stored = row.contentType;
    const rdf = isRdfType(stored);
    const offered = rdf ? [stored, ...RDF_TYPES.filter((t) => t !== bareType(stored))] : [stored];
    const type = negotiate(options.accept, offered);
    if (!type) throw new NotAcceptable(`${row.path} is ${stored}`);
    const base = { kind: 'document' as const, path: row.path, modified: row.modified, access };

    if (bareType(type) !== bareType(stored)) {
      const quads = await this.storedQuads(row).catch((e: unknown) => {
        // A document edited in the storage into something that no longer
        // parses can still be read as stored, by a client that accepts that.
        if (e instanceof Conflict && negotiate(options.accept, [stored])) return null;
        if (e instanceof Conflict) throw new NotAcceptable(e.message);
        throw e;
      });
      if (quads) {
        return {
          ...base,
          contentType: type,
          etag: representationEtag(row.etag, type),
          body: options.head ? null : await serializeRdf(quads, type, this.url(row.path)),
          size: null,
          range: null,
        };
      }
    }

    const range = options.range ? this.range(options.range, row.size) : null;
    if (options.head) return { ...base, contentType: stored, etag: row.etag, body: null, size: row.size, range };
    const cached = range ? null : this.deps.index.cachedText(row.path);
    if (cached !== null) return { ...base, contentType: stored, etag: row.etag, body: cached, size: row.size, range: null };
    const file = await this.deps.files.read(row.file, range ?? undefined);
    if (!file) {
      this.forgetMissing(row);
      throw new NotFound(row.path);
    }
    if (file.rev === row.rev) return { ...base, contentType: stored, etag: row.etag, body: file.body, size: row.size, range };
    // The file changed in the storage and sync has not caught up: these are
    // the new bytes, so they go out under the new validator and size.
    if (!range) return { ...base, contentType: stored, etag: etagOfRev(file.rev), body: file.body, size: file.size, range: null };
    await file.body.cancel();
    const fresh = this.range(options.range!, file.size);
    const part = await this.deps.files.read(row.file, fresh);
    if (!part) {
      this.forgetMissing(row);
      throw new NotFound(row.path);
    }
    return { ...base, contentType: stored, etag: etagOfRev(part.rev), body: part.body, size: part.size, range: fresh };
  }

  /** A stored RDF document's triples. The file can be edited in the storage,
   * so it may not parse: that is the document's state, not a server fault. */
  private async storedQuads(row: DocumentRow) {
    const text = await this.requireText(row);
    try {
      return await parseRdf(text, row.contentType, this.url(row.path));
    } catch (e) {
      if (e instanceof InvalidRdf) throw new Conflict(`${row.path} as stored does not parse as ${bareType(row.contentType)}: ${e.message}`);
      throw e;
    }
  }

  /** The members a container lists: auxiliary resources are not members. */
  private members(container: PodPath): ResourceRow[] {
    return this.deps.index.children(container).filter((r) => !isAclPath(r.path) && !isMetaPath(r.path));
  }

  private async readText(row: DocumentRow): Promise<string | null> {
    const cached = this.deps.index.cachedText(row.path);
    if (cached !== null) return cached;
    const file = await this.deps.files.read(row.file);
    if (!file) return null;
    const text = new TextDecoder().decode(await readAll(file.body, RDF_LIMIT));
    if (text.length <= CACHE_LIMIT) this.deps.index.setCachedText(row.path, text);
    return text;
  }

  private async requireText(row: DocumentRow): Promise<string> {
    const text = await this.readText(row);
    if (text === null) {
      this.forgetMissing(row);
      throw new NotFound(row.path);
    }
    return text;
  }

  /** The index claimed a file the folder no longer has: believe the folder. */
  private forgetMissing(row: ResourceRow): void {
    const { index } = this.deps;
    index.atomically(() => {
      index.delete(row.path);
      touch(this.deps.index, parentOf(row.path), this.deps);
    });
  }

  // ---- writes -------------------------------------------------------------

  put(path: PodPath, agent: Agent, body: Body, contentType: string | null, conditions: Conditions): Promise<WriteResult> {
    return this.writes.run(async () => {
      this.refuseMeta(path);
      this.refuseShadow(path);
      const existing = this.deps.index.get(path);
      // Authorization comes before preconditions and conflicts, so their
      // answers never tell an outsider whether a resource exists.
      if (isContainer(path)) {
        await this.authorizeWrite(path, existing, agent);
        this.checkConditions(existing, conditions);
        if (existing) throw new Conflict('the container already exists; PUT cannot replace a container');
        await this.createContainer(path);
        return { path, created: true };
      }
      if (!contentType) throw new BadRequest('Content-Type is required');
      await this.authorizeWrite(path, existing, agent);
      this.checkConditions(existing, conditions);
      await this.storeBody(path, contentType, body, existing);
      return { path, created: existing === null };
    });
  }

  post(container: PodPath, agent: Agent, body: Body, contentType: string | null, slug: string | null, asContainer: boolean): Promise<WriteResult> {
    return this.writes.run(async () => {
      // Access first, so the answer says nothing about what is there.
      await this.require(container, agent, ['append']);
      const target = this.deps.index.get(container);
      if (!target) throw new NotFound(container);
      if (target.kind !== 'container') throw new MethodNotAllowed('POST is for containers', allowedMethods(container));
      const path = this.freeChildPath(container, slug, asContainer);
      if (asContainer) {
        await this.createContainer(path);
      } else {
        if (!contentType) throw new BadRequest('Content-Type is required');
        await this.storeBody(path, contentType, body, null);
      }
      return { path, created: true };
    });
  }

  patch(path: PodPath, agent: Agent, text: string, contentType: string | null, conditions: Conditions): Promise<WriteResult> {
    return this.writes.run(async () => {
      this.refuseMeta(path);
      this.refuseShadow(path);
      if (!contentType || bareType(contentType) !== N3) throw new UnsupportedMediaType('PATCH takes text/n3');
      if (isContainer(path)) throw new MethodNotAllowed('containers cannot be patched', allowedMethods(path));
      const existing = this.deps.index.get(path);
      if (existing?.kind === 'container') throw new Conflict(`${path} is a container`);
      // Any patch that can change something needs Append at least, so check
      // that before preconditions and before parsing an outsider's body.
      if (isAclPath(path)) await this.authorizeWrite(path, existing, agent);
      else {
        if (!existing) await this.authorizeCreate(path, agent);
        await this.require(path, agent, ['append']);
      }
      this.checkConditions(existing, conditions);
      let patch;
      try {
        patch = parsePatch(text, this.url(path));
      } catch (e) {
        if (e instanceof InvalidPatch) throw new Unprocessable(e.message);
        throw e;
      }
      const storedType = existing?.contentType ?? TURTLE;
      if (!isRdfType(storedType)) throw new UnsupportedMediaType(`${path} is ${storedType}; only RDF documents can be patched`);
      await this.require(path, agent, modesForPatch(patch));
      const current = existing ? await this.storedQuads(existing) : [];
      let next;
      try {
        next = applyPatch(current, patch);
      } catch (e) {
        if (e instanceof PatchConflict) throw new Conflict(e.message);
        throw e;
      }
      // A patch that only tests its where clause changes nothing.
      if (patch.inserts.length === 0 && patch.deletes.length === 0) return { path, created: false };
      await this.storeRdf(path, storedType, await serializeRdf(next, storedType, this.url(path)), existing);
      return { path, created: existing === null };
    });
  }

  remove(path: PodPath, agent: Agent, conditions: Conditions): Promise<void> {
    return this.writes.run(async () => {
      if (path === '/') throw new MethodNotAllowed('the root cannot be deleted', allowedMethods(path));
      // Nobody holds Control without it, so nobody could put it back.
      if (path === ROOT_ACL) throw new MethodNotAllowed('the root ACL cannot be deleted; replace it instead', allowedMethods(path));
      this.refuseMeta(path);
      const { index, files } = this.deps;
      const row = index.get(path);
      if (!row) {
        await this.require(path, agent, ['read']);
        throw new NotFound(path);
      }
      if (isAclPath(path)) {
        await this.require(path, agent, ['control']);
      } else {
        await this.require(path, agent, ['write']);
        await this.require(parentOf(path)!, agent, ['write']);
      }
      this.checkConditions(row, conditions);
      if (row.kind === 'container' && this.members(path).length > 0) throw new Conflict('the container is not empty');
      if (row.kind === 'document' && (await this.protectedIssuers(row)).length > 0) {
        throw new Conflict('this profile names who signs its owner in, so it cannot be deleted');
      }

      // A container's remaining children are auxiliary resources, its own ACL
      // among them; they go with it.
      const companions = row.kind === 'container' ? index.children(path) : [index.get(aclPathOf(path))].filter((r) => r !== null);
      if (isAclPath(path)) companions.length = 0;
      if (row.kind === 'container') {
        // Deleting a folder takes everything in it, and the folder can hold
        // files this pod never listed: those are the person's, not ours.
        const ours = new Set(companions.map((c) => c.file.slice(row.file.length)));
        const others = (await files.namesIn(row.file)).filter((name) => !ours.has(name));
        if (others.length > 0) throw new Conflict('the folder in storage holds files this pod does not list; move or delete them there first');
        await files.removeFolder(row.file);
      } else {
        // The resource goes before its ACL: stopping in between leaves an
        // ACL with nothing to guard, never a resource without its ACL.
        await files.remove(row.file);
        if (row.hasMeta) await files.remove(metaFileOf(path));
        for (const c of companions) await files.remove(c.file);
      }
      index.atomically(() => {
        for (const c of companions) index.delete(c.path);
        index.delete(path);
        touch(this.deps.index, parentOf(path), this.deps);
      });
    });
  }

  // ---- write internals ----------------------------------------------------

  private refuseMeta(path: PodPath): void {
    if (isMetaPath(path)) throw new MethodNotAllowed('metadata files are managed by the server', allowedMethods(path));
  }

  /** Names a case-blind disk would read as `.acl` or `.meta` are refused,
   * whoever asks: on such a disk they would become the real thing. */
  private refuseShadow(path: PodPath): void {
    if (shadowsAuxiliary(path)) throw new BadRequest('a name ending in .acl or .meta must be in lower case');
  }

  /** The `solid:oidcIssuer` statements a stored WebID profile makes about its
   * owner. Apps sign the owner in through them, so requests may not change them. */
  private async protectedIssuers(row: ResourceRow | null): Promise<string[]> {
    if (row?.kind !== 'document' || row.path !== PROFILE_PATH || !isRdfType(row.contentType)) return [];
    const text = await this.readText(row);
    if (text === null) return [];
    // A profile that no longer parses protects nothing, so it can be repaired.
    const quads = await parseRdf(text, row.contentType, this.url(row.path)).catch(() => []);
    return this.issuersIn(quads);
  }

  private issuersIn(quads: Quad[]): string[] {
    const webid = webidAt(this.deps.base);
    return quads.filter((q) => q.subject.value === webid && q.predicate.value === SOLID('oidcIssuer')).map((q) => q.object.value).sort();
  }

  private async authorizeWrite(path: PodPath, existing: ResourceRow | null, agent: Agent): Promise<void> {
    if (isAclPath(path)) {
      // Access first, so the answer says nothing about what is there.
      await this.require(path, agent, ['control']);
      if (!this.deps.index.get(subjectOfAcl(path))) throw new Conflict(`${subjectOfAcl(path)} does not exist`);
      return;
    }
    if (existing) await this.require(path, agent, ['write']);
    else await this.authorizeCreate(path, agent);
  }

  private async authorizeCreate(path: PodPath, agent: Agent): Promise<void> {
    const parent = parentOf(path);
    // Provisioning makes the root; no request does.
    if (parent === null) throw new Conflict('the root container always exists');
    await this.require(parent, agent, ['append']);
  }

  /** A free name in `container` for a POST, from the Slug when it is usable. */
  private freeChildPath(container: PodPath, slug: string | null, asContainer: boolean): PodPath {
    const cleaned = slug ? encodeURIComponent(slugName(slug)) : '';
    const candidates = cleaned ? [cleaned, `${cleaned}-${this.deps.newId()}`] : [this.deps.newId()];
    for (const name of candidates) {
      const path = childPath(container, name, asContainer);
      if (this.isFree(path)) return path;
    }
    return childPath(container, this.deps.newId(), asContainer);
  }

  private isFree(path: PodPath): boolean {
    const { index } = this.deps;
    if (isAclPath(path) || isMetaPath(path) || shadowsAuxiliary(path)) return false;
    return !index.get(path) && !index.get(otherKind(path)) && !index.byFold(foldKey(path));
  }

  /** Refuses paths that would collide with an existing resource of the other
   * kind or with a different spelling under case folding. */
  private checkCreatable(path: PodPath): void {
    const { index } = this.deps;
    if (index.get(otherKind(path))) throw new Conflict(`${otherKind(path)} already exists`);
    const folded = index.byFold(foldKey(path));
    if (folded && folded.path !== path) throw new Conflict(`${folded.path} already exists with different case`);
  }

  /** Creates every missing container above and including `path`'s parent. */
  private async ensureAncestors(path: PodPath): Promise<PodPath[]> {
    const missing = ancestorsOf(path).filter((a) => !this.deps.index.get(a));
    for (const a of missing) this.checkCreatable(a);
    for (const a of missing) await this.deps.files.makeFolder(basePathOf(a));
    return missing;
  }

  private async createContainer(path: PodPath): Promise<void> {
    this.checkCreatable(path);
    const missing = await this.ensureAncestors(path);
    await this.deps.files.makeFolder(basePathOf(path));
    this.deps.index.atomically(() => {
      for (const a of [...missing, path]) {
        this.deps.index.upsert(newContainerRow(a, this.deps));
        touch(this.deps.index, parentOf(a), this.deps);
      }
    });
  }

  private async storeBody(path: PodPath, contentType: string, body: Body, existing: ResourceRow | null): Promise<void> {
    if (existing?.kind === 'container') throw new Conflict(`${path} is a container`);
    if (isAclPath(path) && bareType(contentType) !== ACL_TYPE) throw new UnsupportedMediaType('ACL documents are text/turtle');
    if (isRdfType(contentType)) {
      const text = new TextDecoder().decode(await readAll(body.stream, RDF_LIMIT));
      await this.storeRdf(path, contentType, text, existing);
      return;
    }
    if ((await this.protectedIssuers(existing)).length > 0) throw new Conflict('this profile names who signs its owner in, so it stays an RDF document');
    await this.storeDocument(path, contentType, body.stream, existing, null);
  }

  /** Validates and stores an RDF document. */
  private async storeRdf(path: PodPath, contentType: string, text: string, existing: DocumentRow | null): Promise<void> {
    let quads;
    try {
      quads = await parseRdf(text, contentType, this.url(path));
      if (isAclPath(path)) authorizationsOf(quads);
    } catch (e) {
      if (e instanceof InvalidRdf) throw new BadRequest(`invalid ${bareType(contentType)}: ${e.message}`);
      throw e;
    }
    if (path === ROOT_ACL && !authorizationsOf(quads).some((a) => a.modes.includes('control') && a.accessTo.includes(this.url('/')) && a.agents.length > 0)) {
      throw new Conflict('the root ACL must leave a named agent Control over the root, or nobody could change it again');
    }
    const issuers = await this.protectedIssuers(existing);
    if (issuers.length > 0 && issuers.join(' ') !== this.issuersIn(quads).join(' ')) {
      throw new Conflict('solid:oidcIssuer in this profile names who signs its owner in; a request cannot change it');
    }
    await this.storeDocument(path, contentType, new TextEncoder().encode(text), existing, text);
  }

  private async storeDocument(
    path: PodPath,
    contentType: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    existing: DocumentRow | null,
    text: string | null,
  ): Promise<void> {
    const { index, files } = this.deps;
    let mapped;
    try {
      mapped = documentFile(path, contentType);
    } catch (e) {
      if (e instanceof UnmappablePath) throw new BadRequest(e.message);
      throw e;
    }
    if (!existing) this.checkCreatable(path);
    const missing = await this.ensureAncestors(path);

    const sameFile = existing?.file === mapped.file;
    let info;
    try {
      info = await files.write(mapped.file, body, { ifRev: existing ? (sameFile ? existing.rev : undefined) : null });
    } catch (e) {
      if (e instanceof RevisionConflict) throw new Conflict(`${path} changed in storage; retry after it is re-read`);
      throw e;
    }
    if (mapped.typeInMeta) {
      await files.write(metaFileOf(path), new TextEncoder().encode(`<> <${MA('format')}> "${bareType(contentType)}".\n`));
    } else if (existing?.hasMeta) {
      await files.remove(metaFileOf(path));
    }
    if (existing && !sameFile) await files.remove(existing.file);

    index.atomically(() => {
      for (const a of missing) {
        index.upsert(newContainerRow(a, this.deps));
        touch(this.deps.index, parentOf(a), this.deps);
      }
      index.upsert({
        path,
        kind: 'document',
        contentType: bareType(contentType),
        file: mapped.file,
        rev: info.rev,
        etag: etagOfRev(info.rev),
        size: info.size,
        modified: info.modified,
        hasMeta: mapped.typeInMeta,
      });
      index.setCachedText(path, text !== null && text.length <= CACHE_LIMIT ? text : null);
      if (!existing) touch(this.deps.index, parentOf(path), this.deps);
    });
  }

  private checkConditions(row: ResourceRow | null, conditions: Conditions): void {
    const failure = preconditionFailure(row?.etag ?? null, conditions);
    if (failure) throw new PreconditionFailed(failure);
  }

  private range(request: RangeRequest, size: number): ByteRange {
    const span = resolveRange(request, size);
    if (!span) throw new RangeNotSatisfiable(size);
    return span;
  }
}
