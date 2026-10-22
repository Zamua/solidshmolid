# solidshmolid: Solid pods on the user's own storage

Served at `solidshmolid.com`. The code names no domain: hosts come from
deployment variables.

## What it is

A hosted Solid server whose pods live in storage the user already owns
(Dropbox first, then OneDrive, Google Drive, WebDAV). The service runs the
protocol: identity, access control, containers, PATCH, notifications. The
user's storage holds every byte of every resource. Revoking our access, or the
service disappearing, leaves the user with a complete, self-describing folder.

## Goals

1. **Spec-compliant Solid pod** (Solid Protocol, WAC, Solid-OIDC), checked
   against the Solid conformance suite and Community Solid Server (CSS) as the
   reference.
2. **The folder is the pod.** The pod folder in the user's storage uses CSS's
   file-backend layout (below), so a stock CSS pointed at a synced copy of the
   folder serves the same resources. That property is tested, not promised.
3. **Our servers hold no copy of user data** beyond a bounded cache of small
   RDF documents and the per-pod index, both rebuildable from the folder.
4. **Cloudflare-native**: one Worker plus one Durable Object per pod.

## Non-goals (v1)

- ACP (WAC only). Solid Notifications beyond WebSocketChannel2023.
- SPARQL Update PATCH (N3 Patch only; SPARQL Update is a later addition).
- Remote JSON-LD contexts: a document whose `@context` is a URL is refused
  (400), because loading it would make every parse a fetch to a URL the client
  chose. Bundling a few well-known contexts is a later option.
- iCloud (no web API for iCloud Drive).
- Uploads over 100 MB (the Cloudflare request-body cap on our zone plan).
- Server-side encryption of user data.

## URLs

| what | URL |
| --- | --- |
| | production | staging | local dev |
| --- | --- | --- | --- |
| pod root | `https://<handle>.solidshmolid.com/` | `https://stg-<handle>.solidshmolid.com/` | `http://<handle>.localhost:8787/` |
| WebID | `<pod root>profile/card#me` | same | same |
| identity provider | `https://solidshmolid.com/` | `https://stg.solidshmolid.com/` | `http://localhost:8787/` |

Pod hosts come from `POD_HOST_TEMPLATE` (`{handle}.solidshmolid.com`,
`stg-{handle}.solidshmolid.com`). One pod per host keeps pods in separate
browser origins. Staging shares the production domain because Cloudflare's
free certificate covers one wildcard level only: each staging host is an
exact Worker route, which wins over production's `*.solidshmolid.com` route.
Handles match `[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?`, contain no `--`, never
start with `stg-` (staging's), and avoid a reserved list (`www`, `api`,
`id`, `stg`, ...).

## Architecture

```
client --> Worker (stateless)
             - host -> handle; apex -> identity provider (M3)
             - verifies Solid-OIDC access token + DPoP proof (M2)
             - forwards to POD.idFromName(handle) with the verified agent
           Pod DO (one per pod, SQLite)
             - index: every resource, its file, rev, etag, type
             - WAC evaluation; ACL docs cached parsed
             - write lock: all writes to the pod are serialized
             - reconcile: rebuild/repair the index from the folder
           FileStore port --> Dropbox | OneDrive | Drive | WebDAV | dev store
```

### Layers (enforced by a test, as in kcal)

- `worker/domain/`: pure. Paths, the CSS file layout, content-type mapping,
  RDF graph helpers, WAC evaluation, N3 Patch application, container
  representation. No I/O, no `cloudflare:` or `node:` imports.
- `worker/app/`: the pod service and its ports (`FileStore`, `PodIndex`,
  `Clock`). Orchestration only.
- `worker/runtime/`: Worker entry, the `Pod` Durable Object, HTTP
  translation, adapters.

## The folder layout (CSS file-backend compatible)

The pod root maps to the pod folder (e.g. `Apps/<app>/` in Dropbox). For a
resource URL path `p` (percent-decoded):

- **Container** `/a/b/` is folder `a/b/`.
- **Document** `/a/b/c.ttl` is file `a/b/c.ttl` when the extension's media
  type (the `mime-types` database, plus `acl` and `meta` as `text/turtle`)
  equals the resource's content type.
- Otherwise the file gets a `$.<ext>` suffix, where `<ext>` is the canonical
  extension of the content type: `/profile/card` as `text/turtle` is
  `profile/card$.ttl`. A type with no known extension uses `$.unknown`, and the
  real type is kept in the metadata file.
- A document's URL path may not end in `$.<word>` (400; CSS refuses it too).
- **Auxiliary resources** are ordinary documents: `/a/c.ttl.acl` is file
  `a/c.ttl.acl`; a container's ACL `/a/.acl` is `a/.acl`.
- **Metadata** that file-system conventions cannot express (today only an
  unknown content type) goes in `<file>.meta` (`a/.meta` for a container) as
  Turtle. Most resources have none.
- Types and modification times come from the convention, not from files.

**Case.** Solid paths are case-sensitive; Dropbox, OneDrive and default macOS
are not. Creating a resource whose path equals an existing one under Unicode
case folding is refused with 409, so the layout stays one-to-one.

## Resource semantics (Solid Protocol subset for M1)

- `GET`/`HEAD` on documents stream the file, honoring `Range`. RDF documents
  are stored as sent and converted on request between `text/turtle`,
  `application/ld+json` and `application/n-triples`.
- `GET` on a container returns its description: `ldp:Container`,
  `ldp:BasicContainer`, `ldp:Resource`, `ldp:contains` per child, from the
  index (no storage round trip).
- `PUT` creates or replaces a document and creates missing intermediate
  containers. `PUT` on a container URL creates the container. A document and a
  container may not share a name ignoring the trailing slash (409).
- `POST` to a container creates a child: name from `Slug` (sanitized, made
  unique) or generated; `Link: <ldp:BasicContainer>; rel="type"` makes a
  container. Responds `201` with `Location`.
- `PATCH` with `text/n3` applies an N3 Patch (`solid:InsertDeletePatch`, with
  `solid:where`, `solid:inserts`, `solid:deletes`) to an RDF document,
  creating it if absent. A document breaking the N3 Patch rules (not exactly
  one patch resource, unbound variables, blank nodes in `where`/`deletes`,
  nested formulae) is 422. A `where` that does not match exactly once, or a
  delete that is absent, is 409. Any RDF document can be patched; it keeps
  its stored type.
- `DELETE` removes a document (and its `.acl`/`.meta`) or an empty container
  (409 if not empty). The root cannot be deleted.
- Conditional requests: `If-Match` and `If-None-Match` (including `*`) on
  every write, against the index ETag. A failed precondition is 412.
- Response headers: `ETag`, `Last-Modified`, `Link` (`rel="type"` for LDP
  types and `pim:Storage` on the root, `rel="acl"`), `Allow`, `Accept-Patch:
  text/n3`, `Accept-Post: */*` on containers, `Accept-Put: */*`, `WAC-Allow`.
- CORS on every response: echo `Origin`, allow credentials, expose
  `Accept-Patch, Accept-Post, Accept-Put, Allow, Content-Range, ETag, Link,
  Location, WAC-Allow`. `OPTIONS` answers preflights with 204.
- `GET /healthz` on any host returns `ok\n`, `Cache-Control: no-store`.

## Access control (WAC)

- Effective ACL: the resource's own `.acl` (authorizations with
  `acl:accessTo` it), else the nearest ancestor container's `.acl`
  (authorizations with `acl:default` that container).
- Agents: `acl:agent <webid>`, `acl:agentClass foaf:Agent` (anyone),
  `acl:agentClass acl:AuthenticatedAgent`. `acl:agentGroup` and `acl:origin`
  are not evaluated in v1.
- Modes: Read for GET/HEAD; Write for PUT/DELETE and PATCH with deletes;
  Append (or Write) for POST, insert-only PATCH, and creating a child in a
  container; Control for any access to an `.acl`. Deleting needs Write on the
  resource and its container.
- Denied without credentials is 401; denied with credentials is 403.
- `WAC-Allow: user="...",public="..."` on every successful response.
- An `.acl` must parse as Turtle or the write is refused (400). An `.acl` in
  the folder that does not parse (out-of-band edit) grants nothing and is
  logged; the pod fails closed.
- New pods get a root ACL granting the owner Read/Write/Control with
  `acl:default`, and a public-read profile document.

## The index (Pod DO SQLite)

One row per resource: URL path, parent, kind, content type, file path, file
rev, ETag, size, modified, and the case-folded path (unique). Containers carry
a version counter bumped on membership change; their ETag derives from it.

Small RDF documents (64 KiB and under, so every ACL and the profile) are
cached in the index, which keeps access control and WebID resolution working
while the user's storage is slow or briefly unreachable.

Write order: storage first, index second, in one DO transaction after the
storage call succeeds. A crash between the two leaves either an unindexed
file or a dangling row; reconcile repairs both (unindexed file: index it;
missing file: drop the row on the next read or sweep). Reconcile is also how
out-of-band edits arrive (M2: provider change feeds).

All writes to a pod take the pod's write lock, so read-modify-write (PATCH,
conditional PUT) is atomic with respect to this server. Reads do not take it.

## Storage port

```ts
interface FileStore {
  read(path, range?) -> { body, size, rev, range? } | null
  write(path, body, { size?, ifRev? })  -> FileInfo   // ifRev null: must not exist
  remove(path)
  makeFolder(path)
  removeFolder(path)
  list(folder) -> FileInfo[]
}
```

Paths are folder-relative with `/` separators. `rev` is the provider's
revision (Dropbox `rev`, Drive version, a hash for WebDAV). Adapters translate
provider errors into a small set: not found, conflict, quota exceeded,
unauthorized (access revoked), rate limited (with retry-after), unavailable.

Adapters in order: `MemoryFileStore` (tests), `DevFileStore` (DO SQLite, local
dev only; deployments refuse it), Dropbox (M2), OneDrive, Drive, WebDAV.

## Authentication (M2)

Resource-server side of Solid-OIDC: `Authorization: DPoP <jwt>` plus a `DPoP`
proof. Verify the proof (`htm`, `htu`, `iat` window, `jti` not replayed, key
thumbprint equals the token's `cnf.jkt`), the token signature against the
issuer's JWKS, `aud` including `solid`, `exp`, and that the token's `webid`
document lists the issuer as `solid:oidcIssuer`. Any Solid issuer is accepted;
our own comes in M3. Local dev may accept an `X-Dev-WebID` header, only when
the dev config enables it.

## Milestones

- **M1 core** (done): Worker + Pod DO + domain, `MemoryFileStore`/`DevFileStore`, all
  resource semantics above except JSON-LD, WAC with dev agent header, CORS.
  Exit: unit tests + an HTTP-level suite against `wrangler dev`.
- **M1b** (done): JSON-LD; `make compat` proves a stock CSS 7.2 serves a
  folder we wrote with the same documents, members and access decisions.
  Indexing a folder CSS wrote comes with reconcile in M2.
- **M2**: Solid-OIDC verification; Dropbox adapter (App folder, PKCE + refresh
  token, encrypted at rest); link flow; Dropbox change feed into reconcile.
- **M3**: our own Solid-OIDC identity provider, signup, WebID profiles.
- **M4**: Solid Notifications (WebSocketChannel2023 on hibernating DO
  sockets); OneDrive, Drive, WebDAV adapters; conformance suite in CI.
