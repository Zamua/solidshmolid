# solidshmolid Constitution

## Core Principles

### I. The Folder Is the Pod

The user's own storage holds every byte of every resource. The pod folder MUST use Community
Solid Server's file-backend layout, so a stock CSS pointed at a copy of the folder serves the
same pod; `make compat` MUST keep proving this in both directions. Our servers MAY keep only
the per-pod index and a bounded cache of small RDF documents, both rebuildable from the folder.
Reconcile MUST NOT delete or rewrite a user file it cannot map; it reports it and leaves it.

Rationale: "you own your data" is only true if walking away needs nothing from us.

### II. Protocol Fidelity

The server implements the Solid Protocol, Web Access Control, Solid-OIDC and N3 Patch as
specified. Behavior MUST be checked against a running Community Solid Server (folder
compatibility, real identity-provider tokens, end-to-end through the Worker) and, once
available, the Solid conformance suite. Every intentional deviation (refused remote JSON-LD
contexts, the 100 MB upload cap) MUST be written in the feature spec with its reason.

### III. Least Privilege, Fail Closed

- Storage access uses the narrowest scope a provider offers (Dropbox App folder,
  Drive `drive.file`, OneDrive app folder).
- No client secret is held where PKCE suffices. Long-lived credentials (refresh tokens)
  MUST be encrypted at rest, bound to their pod as associated data.
- An ACL that does not parse grants nothing. Bearer tokens are refused; DPoP proofs are
  checked and never accepted twice.
- Every fetch of a URL a client chose (issuers, JWKS, WebID documents) MUST be time-boxed
  and size-capped. Remote JSON-LD contexts are not fetched.

### IV. Identity Is Not Storage

Accounts (the humans who sign in), storage links (connected Dropbox or Drive accounts),
pods (a handle plus a folder in some linked storage) and WebIDs are distinct things. A WebID
and every resource URL MUST stay the same when a pod's storage moves. Signing in MUST NOT
require owning a storage account, so a parent can create and hand over pods for family members.

### V. Test First, Red Reachable

New behavior starts with a failing test. A guard is only covered when a test fails with the
guard removed; for security and data-loss guards that check MUST actually be run once. Tests
name the property they pin. Provider behavior is tested against a faithful fake in CI and
against the real provider with `make live` before it ships.

### VI. Layered Domain

`worker/domain` is pure (no I/O, no runtime imports); `worker/app` orchestrates through ports;
`worker/runtime` holds the Worker, Durable Objects, HTTP translation and adapters. The
layering test enforces the dependency rule. Provider-specific detail stays inside its adapter;
cross-cutting concerns (auth, sync, retries) are wired at the composition root, not woven into
the pod service.

### VII. Simplicity

Cloudflare-native: one Worker and one Durable Object per pod. A new primitive (D1, R2, Queues,
KV, containers) requires a concrete need written in the plan; R2 never holds user data. Prefer
the simpler shape until a second real use case appears.

## Platform and Security Constraints

- Runtime: Cloudflare Workers with SQLite-backed Durable Objects, `nodejs_compat`.
- Request bodies are capped at 100 MB by the zone plan; files larger than that are out of scope.
- Secrets live in Worker secrets (`wrangler secret`) or the operator's `~/keys`, never in the repo.
  The repository is destined to be public: it MUST contain no personal context, keys, account
  identifiers or operator paths. Per-environment config lives in the private `infra/solidshmolid/`.
- Hosts: production pods at `<handle>.solidshmolid.com`, staging pods at
  `stg-<handle>.solidshmolid.com`, identity provider at the apex (`stg.` for staging).
- Accounts and sign-in are provided by Clerk; the Solid-OIDC provider is ours.

## Development Workflow

- Features follow Spec Kit: constitution, specify, clarify, plan, tasks, implement.
  `docs/SPEC.md` describes the system as built and stays current with merged work.
- Work happens on a branch, lands through a pull request with CI green (`make typecheck`,
  `make test`, `make compat`, `make e2e`), and is squash-merged. CI on `main` is watched too.
- Nothing deploys from a branch: merge, tag a semver release, then deploy staging, smoke before
  and after, and only then production with the same tag.
- Commit messages are single-line Conventional Commits. Prose avoids em dashes.

## Governance

This constitution supersedes other practice in this repository. Amendments land as pull requests
that update this file, bump its version (MAJOR for removed or redefined principles, MINOR for
added principles or sections, PATCH for wording) and state the reason. Plans MUST include a
constitution check; a violation is either fixed or recorded with its justification in the plan's
complexity tracking. Runtime guidance for agents lives in `CLAUDE.md`.

**Version**: 1.0.0 | **Ratified**: 2026-10-22 | **Last Amended**: 2026-10-22
