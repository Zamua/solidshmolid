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

Pods serve whatever HTML their folders hold, so a pod host must never be
able to set cookies the apex reads: a page on a sibling subdomain could plant
its owner's session in a visitor's browser (cookie tossing) and have them act
inside the attacker's account. Pods therefore need a registrable domain of
their own (or a Public Suffix List entry); the production pod domain is still
to be chosen. The apex also checks `Origin` on every state-changing POST,
since SameSite cookies do not stop same-site pages.

A pod's handle is a random pod id: 8 characters from
`23456789abcdefghjkmnpqrstuvwxyz` (no look-alikes), assigned by the directory,
unique, and never reused, so nobody picks or squats one and a deleted pod's
URLs never come to point at someone else. The dev config also serves named
pods (`dana.localhost:8787`, any valid handle that is not a pod id), created
on first request in the dev store.

## Architecture

```
client --> Worker (stateless)
             - host -> handle; apex -> identity provider, account API, pages
             - verifies Solid-OIDC access token + DPoP proof
             - forwards to POD.idFromName(handle) with the verified agent
           Pod DO (one per pod, SQLite)
             - index: every resource, its file, rev, etag, type
             - WAC evaluation; ACL docs cached parsed
             - write lock: all writes to the pod are serialized
             - reconcile: rebuild/repair the index from the folder
             - placement: account, storage link, folder, change cursor
           Account DO (one per person): WebID, pods, storage links (sealed
             refresh tokens), access tokens for its pods over RPC; provider
             state (approvals, codes, refresh families)
           Directory DO (one): person -> account, pod ids, registered clients
           FileStore port --> Dropbox | OneDrive | Drive | WebDAV | dev store
```

### Layers (enforced by a test, as in kcal)

- `worker/domain/`: pure. Paths, the CSS file layout, content-type mapping,
  RDF graph helpers, WAC evaluation, N3 Patch application, container
  representation. No I/O, no `cloudflare:` or `node:` imports.
- `worker/app/`: services and their ports, per bounded context (pods,
  storage, identity, accounts). Orchestration only.
- `worker/runtime/`: Worker entry, the Durable Objects, HTTP translation,
  adapters, and the composition root that wires them.

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

## Accounts and storage

Signing up (`POST /api/signup`, contracts in
`specs/002-accounts-households/contracts/account-api.md`) assigns the person's first pod id
and their WebID, and binds their account to it. Repeating it, or racing it, returns the same
account: the account keeps the first record written. Each person has one account, one WebID
and any number of pods; the account's records live in their `AccountObject` beside the
provider state.

The pods exist once storage is connected. `POST /api/storage/<provider>/start` begins the
provider's OAuth with PKCE and offline access; the verifier waits in the account under a
one-time nonce (15 min). The state is `<accountKey>.<nonce>`; `/link/<provider>/callback`
exchanges the code, and only the same account can finish it. With PKCE Dropbox refreshes
without a client secret, so the service holds no app secret. The refresh token is stored in
the account, AES-GCM-sealed under the `TOKEN_KEY` secret with `account/<key>/link/<linkId>` as
associated data. Pods get short-lived access tokens from their account over RPC; nothing else
holds a grant.

Each pod waiting for storage is then placed in its own folder of the link,
`Apps/solidshmolid/<pod id>/` on Dropbox (`app/storage/placement.ts`): an empty folder gets a
new pod (the WebID in full; the first pod also gets the public profile); a folder that already
holds files is adopted: the index is rebuilt from a full listing (`app/pods/reconcile.ts`),
keeping ETags and caches of unchanged files. Files the layout cannot map, or that collide with
another file for the same resource, are reported and left alone; CSS's `.internal/` folder is
ignored. The pod records its placement and the listing's cursor.

`POST /api/pods` adds a pod beside the first, owned by the same WebID, with no profile of its
own; the WebID's profile gains a `pim:storage` for it, so apps find every pod.

While placed, a request first folds in what changed in the folder since the last look
(`list_folder/continue` from the stored cursor), at most every 30 s per pod. Webhooks can
replace the polling later; the reconcile path is the same.

`STORAGE` names the provider people connect: `dropbox`, or `dev` in the
dev config, which grants consent on the spot and keeps files in each pod's
own SQLite.

## Signing in (people, on the apex)

People sign in with Clerk. Every apex page loads clerk-js from the
instance's Frontend API plus our own `/assets/clerk-boot.js`, which keeps the
60-second session token fresh and mounts sign-in or sign-up where a page asks
(`/sign-in`, `/sign-up`, `/sign-out`; a `return` parameter must name a page
on the apex). Pages carry no inline script, and their CSP allows only the
Frontend API, Clerk's bot protection and Cloudflare Turnstile.

The Worker settles who is signed in once per apex request
(`runtime/adapters/clerkSessions.ts`, `@clerk/backend`): it verifies the
session token from the `__session` cookie or a bearer header, requires its
`azp` to be the apex origin, and answers a page load whose token has expired
with Clerk's handshake redirect, which comes straight back signed in. The dev
config also honors the `dev_person` cookie from `/dev/sign-in` first.

## Authentication

Resource-server side of Solid-OIDC (`runtime/auth/solidOidc.ts`, in the
Worker): `Authorization: DPoP <jwt>` plus a `DPoP` proof. Bearer tokens are
refused. Checked: the token signature against the issuer's JWKS (discovered
from `/.well-known/openid-configuration`, cached 5 minutes, refetched once on
an unknown key), `iss`, `exp`, `aud` including `solid`, a `webid` claim and a
`cnf.jkt`; the proof's signature, `typ`, key thumbprint equal to `cnf.jkt`,
`htm`, `htu` (query ignored), `iat` within 5 minutes, a `jti`, and `ath` when
present; and that the WebID document names the issuer as `solid:oidcIssuer`.
The pod's DO rejects a `jti` it has seen inside the proof window: a proof
names the pod's host in `htu`, so per-pod uniqueness suffices. Every URL the
verifier fetches is chosen by the client, so each fetch is time-boxed (5 s)
and size-capped (256 KiB). Any Solid issuer is accepted; our own comes in M3.
A failure is 401 with `WWW-Authenticate: DPoP error="invalid_token"`. The dev
config also accepts an `X-Dev-WebID` header.

## Milestones

- **M1 core** (done): Worker + Pod DO + domain, `MemoryFileStore`/`DevFileStore`, all
  resource semantics above except JSON-LD, WAC with dev agent header, CORS.
  Exit: unit tests + an HTTP-level suite against `wrangler dev`.
- **M1b** (done): JSON-LD; `make compat` proves a stock CSS 7.2 serves a
  folder we wrote with the same documents, members and access decisions.
  Indexing a folder CSS wrote comes with reconcile in M2.
- **M2**: Solid-OIDC verification (done; `make compat` verifies a real CSS
  token, `make e2e` drives a dev pod with one); reconcile (done, including
  adopting a folder a stock CSS wrote); Dropbox adapter (App folder, PKCE + refresh
  token, encrypted at rest); link flow; Dropbox change feed into reconcile.
- **M3**: our own Solid-OIDC identity provider (done; `make e2e` shows a
  stock CSS accepting its tokens); signup, connecting storage, more pods per
  person and Clerk sign-in (done); then the app list, disconnecting storage,
  moving and deleting pods.
- **M4**: Solid Notifications (WebSocketChannel2023 on hibernating DO
  sockets); OneDrive, Drive, WebDAV adapters; conformance suite in CI.
