---
description: "Task list for accounts, pods and Solid sign-in"
---

# Tasks: Accounts, Pods and Solid Sign-In

**Input**: Design documents from `/specs/002-accounts-households/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Required (constitution V): every story starts with failing tests; guards get a
red-reachable check.

**Organization**: Tasks are grouped by user story so each can ship and be tested on its own.

**Scope reduced 2026-10-23**: households, members and children's accounts were dropped (see
spec.md). Tasks already done for them stay listed as history; their code was removed with the
change that added more pods per person.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependencies)
- Paths follow plan.md (`worker/domain`, `worker/app`, `worker/runtime`, `worker/tests`)

## Phase 1: Setup

- [x] T001 Clerk application `solidshmolid` created via the CLI (dev instance now; the prod instance comes with the production domain at first deploy): passwords off, usernames on, email optional, passkeys on; dev keys in `~/keys/clerk-solidshmolid-dev.env`
- [x] T002 Spike against the Clerk dev instance: create a username-only user via the Backend API, issue a 900 s sign-in token, sign in with it once, register a passkey, confirm a second use fails (research R3, R4); record results in research.md
- [x] T003 [P] Generate `OIDC_SIGNING_JWK` in `make .dev.vars`; add `CLERK_PUBLISHABLE_KEY`/`CLERK_SECRET_KEY` handling in Makefile
- [x] T004 [P] Mobile-first mockups (sign-up, connect storage, dashboard, member card, consent, device setup QR, delete with typed confirmation) as static HTML at iPhone width with Phosphor icons; screenshots to the operator for approval before any page is built
- [x] T005 Move `PodObject` to `worker/runtime/objects/` and register `HouseholdObject`, `AccountObject`, `DirectoryObject` with a v2 migration in `wrangler.jsonc` and `wrangler.dev.jsonc`

## Phase 2: Foundational (blocks every story)

- [x] T006 [P] Tests then code: `worker/domain/oidc.ts` (claims for access and ID tokens, scope rules, redirect matching, PKCE S256 check) in `worker/tests/oidc-domain.test.ts`
- [x] T007 [P] Tests then code: `worker/domain/household.ts` (roles, at-least-one-manager invariant, member root ACL with manager grants per FR-012, family group document) in `worker/tests/household-domain.test.ts`
- [x] T008 [P] Tests then code: `worker/domain/deletion.ts` (sentence for a provider display name; exact-match check) with a test that every other input is refused (SC-006) in `worker/tests/deletion.test.ts`
- [x] T009 Ports per bounded context (`worker/app/<context>/ports.ts`), replacing one shared ports file
- [x] T010 `worker/runtime/clerk.ts`: session verification against Clerk JWKS and the Backend API adapter; tests with a fake JWKS in `worker/tests/clerk.test.ts`
- [x] T011 `DirectoryObject` (account and provider-account lookups) with tests in `worker/tests/directory.test.ts`
- [x] T011b Directory assigns random pod ids (replaces handle reservation and the 90-day hold)
- [x] T012 Storage links move to `HouseholdObject`; `PodObject` gets access tokens over RPC and stores its folder (`root` = handle); update `worker/tests/link.test.ts` and `make live` to the subfolder layout

## Phase 3: User Story 1, sign up and get a pod (P1) 🎯 MVP

**Goal**: A visitor signs up, gets a random pod id, connects Dropbox and has a pod in `Apps/solidshmolid/<id>/`.

**Independent Test**: signup + connect on wrangler dev; profile public, root private; returning folder adopted.

- [x] T013 [P] [US1] Tests: signup assigns a fresh random pod id (alphabet, length, uniqueness, never reused); creates household with caller as manager; connect creates the pod in the link; existing folder adopted, in `worker/tests/households.test.ts`
- [x] T014 [US1] `worker/app/households.ts`: signup, connect storage, create own pod
- [x] T015 [US1] `/api/me`, `/api/signup`, `/api/storage/dropbox/start`, `/link/dropbox/callback` in `worker/runtime/api/`
- [x] T016 [US1] Pages: sign-up and connect-storage (from approved mockups) in `worker/runtime/pages/`, with Clerk sign-in and sign-up
- [x] T017 [US1] e2e on wrangler dev with a Clerk testing token: sign up, connect (fake Dropbox in dev), read own profile (`worker/tests/e2e-signup.test.ts` with dev sign-in; `worker/tests/clerk.live.test.ts` with a real Clerk session)

## Phase 4: User Story 2, sign in to any Solid app (P1)

**Goal**: Our site is a Solid-OIDC provider for the WebIDs it hosts.

**Independent Test**: scripted client does code + PKCE + DPoP; our verifier, a stock CSS and the Inrupt client library all accept the result.

- [x] T018 [P] [US2] Tests for `worker/app/provider.ts`: authorize needs a session; Client ID Document fetch with limits and exact redirect match; code single-use (second use revokes); PKCE; DPoP binding; refresh rotation with reuse revoking the family; revoke approval kills its tokens, in `worker/tests/provider.test.ts`
- [x] T019 [US2] `worker/app/provider.ts` and `AccountObject` storage for approvals, codes, refresh families
- [x] T020 [US2] Endpoints in `worker/runtime/oidc/`: discovery, JWKS, auth, token, reg, session end (contracts/oidc.md)
- [ ] T021 [US2] Consent page and app list (`/api/apps`) in `worker/runtime/pages/` and `worker/runtime/api/`
- [x] T022 [US2] Profiles name our issuer (`solid:oidcIssuer`) for every hosted WebID; migrate dev pods
- [x] T023 [P] [US2] Interop: a stock CSS pod granting our WebID accepts our token, in `worker/tests/oidc-interop.test.ts` (`make compat`)
- [ ] T024 [P] [US2] Interop: `@inrupt/solid-client-authn-node` completes login against wrangler dev (`make e2e`)

## Phase 5: User Story 3, more pods (P2)

- [x] T025 [P] [US3] Tests: a second pod gets a fresh id and folder beside the first, has no profile, is owned by the WebID only, and is listed as `pim:storage` in the profile, in `worker/tests/accounts.test.ts`, `worker/tests/starter.test.ts` and `worker/tests/e2e-signup.test.ts`
- [x] T026 [US3] Households fold into the account (`AccountObject` holds pods and storage links); `POST /api/pods` and "Add a pod" on the pods page

## Phase 6: User Story 4, controls and guardrails (P3)

- [ ] T027 [P] [US4] Tests: disconnect refused while pods use the link (names them); delete keeps files by default; typed sentence required to delete files (red-reachable check run once)
- [ ] T028 [US4] App list and revoke (`/api/apps`) on the pods page
- [ ] T029 [US4] Disconnect storage; delete a pod or the account with the two-step confirmation
- [ ] T030 [US4] Move a pod to another link (copy, adopt, switch; old copy serves until commit)

## Phase 11: Polish

- [ ] T037 Update `docs/SPEC.md`, `CLAUDE.md`, README for accounts and the provider
- [ ] T038 `infra/solidshmolid/`: wrangler per-environment files (`stg-{handle}` routes), secrets contract, DEPLOY.md, smoke; first staging deploy from a tag
- [ ] T039 Run quickstart.md by hand on staging with a real Clerk instance and Dropbox

## Dependencies

- Setup (T001 to T005) before Foundational; T001 and T002 gate everything Clerk-shaped.
- Foundational (T006 to T012) before every story.
- US1 then US2 (sign-in needs hosted WebIDs); US3 and US4 depend on US1.

## Parallel Examples

- Foundational: T006, T007, T008 together (separate domain files).
- US2: T023 and T024 together once T020 lands.

## Implementation Strategy

MVP is US1 + US2: a person can get a pod in their own Dropbox and use it from any Solid app.
Ship that to staging with US3, then add US4 before anyone relies on it.
