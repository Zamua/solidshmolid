# Implementation Plan: Accounts, Pods and Solid Sign-In

**Branch**: `002-accounts-households` | **Date**: 2026-10-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-accounts-households/spec.md`

## Summary

People sign in with Clerk; the Worker becomes a Solid-OIDC provider that issues DPoP-bound
tokens for the WebIDs it hosts, using the Clerk session to know who is signing in. Each
person's account (a Durable Object) holds their one WebID, their pods and their storage links;
each pod is a subfolder of one storage link. People add more pods for themselves, move pods
without changing their URLs, and delete pods with a typed confirmation before any file is
removed. Details and alternatives: [research.md](research.md); its household and device-setup
sections are history since the scope was reduced on 2026-10-23.

## Technical Context

**Language/Version**: TypeScript 5.9 on Cloudflare Workers (`nodejs_compat`)

**Primary Dependencies**: `jose` (token signing and verification), `n3` (RDF), Clerk
(`@clerk/clerk-js` on pages, Backend API over fetch); no new server framework

**Storage**: Durable Object SQLite (`PodObject`, `AccountObject`, `DirectoryObject`); pod data
in the user's Dropbox

**Testing**: vitest with node:sqlite fakes; `make compat` (CSS as an independent resource
server and identity provider); `make e2e` on wrangler dev with Clerk testing tokens;
`make live` for Dropbox

**Target Platform**: Cloudflare Workers (staging `stg.solidshmolid.com`, prod `solidshmolid.com`)

**Project Type**: web service with server-rendered pages

**Performance Goals**: token endpoint p95 under 300 ms; consent page under 1 s server time;
sign-in end to end limited by Clerk's UI

**Constraints**: no passwords and no storage app secrets held (SC-005); secrets only in Worker
secrets; 100 MB request bodies

**Scale/Scope**: early accounts in the hundreds; up to 10 pods per account in v1

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| principle | check | result |
| --- | --- | --- |
| I. The Folder Is the Pod | Pods stay whole folders (`Apps/solidshmolid/<id>/`); account and approval data is identity data, not pod data | pass |
| II. Protocol Fidelity | Solid-OIDC conformance checked against CSS and the Inrupt client library (R10); deviations listed in contracts/oidc.md | pass |
| III. Least Privilege, Fail Closed | PKCE everywhere, DPoP-bound access and refresh tokens, hashed codes, rotation with reuse detection, Client ID Documents fetched with limits | pass |
| IV. Identity Is Not Storage | Sign-in through Clerk needs no storage account; moves keep URLs | pass |
| V. Test First, Red Reachable | Deletion confirmation and token-reuse revocation each get a test that fails with the guard removed | pass |
| VI. Layered Domain | OP rules and account rules in `domain`/`app`; Clerk and Durable Objects behind ports | pass |
| VII. Simplicity | Two new Durable Object classes; see Complexity Tracking | justified |

Post-design re-check: unchanged; no new primitive beyond the two objects.

## Project Structure

### Documentation (this feature)

```text
specs/002-accounts-households/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── oidc.md
│   └── account-api.md
└── tasks.md            # /speckit-tasks
```

### Source Code (repository root)

```text
worker/
├── domain/{shared,pods,identity,accounts}/   pure rules
├── app/
│   ├── identity/   provider.ts, ports.ts (Accounts, ClientRegistry, TokenSigner, Clock, Secrets)
│   ├── storage/    placement.ts, sync.ts, migrate.ts, ports.ts
│   ├── pods/       pod.ts, reconcile.ts, ports.ts
│   ├── accounts/   accounts.ts (signup, connect storage, add pods), ports.ts
│   └── shared/     errors.ts, serial.ts, streams.ts
├── runtime/
│   ├── composition.ts   the composition root
│   ├── worker.ts        routes by host
│   ├── http/            solid.ts, oidc.ts, api.ts, home.ts, signIn.ts, dev.ts, pages/
│   ├── adapters/        sql*, dropbox*, tokenSigner, solidOidcVerifier, dpopProof, sessions, clerkSessions, clientRegistry, accountRpc
│   └── objects/         PodObject, AccountObject, DirectoryObject (thin shells)
└── tests/
```

**Structure Decision**: One Worker, one repository; the layers above follow constitution VI.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| `AccountObject` | Per-person approvals, codes, refresh families, pods and storage credentials, isolated from other people | Keeping links in each `PodObject` duplicates refresh tokens and cannot enforce "no disconnect while used" |
| `DirectoryObject` | Global pod-id uniqueness and lookups by Clerk user | D1 adds a primitive for a few keyed reads; Clerk metadata cannot enforce uniqueness |
