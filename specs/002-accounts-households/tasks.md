---
description: "Task list for accounts, households and Solid sign-in"
---

# Tasks: Accounts, Households and Solid Sign-In

**Input**: Design documents from `/specs/002-accounts-households/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Required (constitution V): every story starts with failing tests; guards get a
red-reachable check.

**Organization**: Tasks are grouped by user story so each can ship and be tested on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependencies)
- Paths follow plan.md (`worker/domain`, `worker/app`, `worker/runtime`, `worker/tests`)

## Phase 1: Setup

- [ ] T001 Operator creates the Clerk application `solidshmolid` (dev and prod instances): usernames on, email optional, passkeys on; keys into `~/keys` and `infra/solidshmolid/`
- [ ] T002 Spike against the Clerk dev instance: create a username-only user via the Backend API, issue a 900 s sign-in token, sign in with it once, register a passkey, confirm a second use fails (research R3, R4); record results in research.md
- [ ] T003 [P] Generate `OIDC_SIGNING_JWK` in `make .dev.vars`; add `CLERK_PUBLISHABLE_KEY`/`CLERK_SECRET_KEY` handling in Makefile
- [x] T004 [P] Mobile-first mockups (sign-up, connect storage, dashboard, member card, consent, device setup QR, delete with typed confirmation) as static HTML at iPhone width with Phosphor icons; screenshots to the operator for approval before any page is built
- [ ] T005 Move `PodObject` to `worker/runtime/objects/` and register `HouseholdObject`, `AccountObject`, `DirectoryObject` with a v2 migration in `wrangler.jsonc` and `wrangler.dev.jsonc`

## Phase 2: Foundational (blocks every story)

- [ ] T006 [P] Tests then code: `worker/domain/oidc.ts` (claims for access and ID tokens, scope rules, redirect matching, PKCE S256 check) in `worker/tests/oidc-domain.test.ts`
- [ ] T007 [P] Tests then code: `worker/domain/household.ts` (roles, at-least-one-manager invariant, member root ACL with manager grants per FR-012, family group document) in `worker/tests/household-domain.test.ts`
- [ ] T008 [P] Tests then code: `worker/domain/deletion.ts` (sentence for a provider display name; exact-match check) with a test that every other input is refused (SC-006) in `worker/tests/deletion.test.ts`
- [ ] T009 Ports in `worker/app/ports.ts`: `Sessions` (current Clerk user), `ClerkAdmin` (create user, sign-in token, remove passkeys), `Approvals`, `Codes`, `RefreshFamilies`, `SigningKeys`, `ClientIds`, `Directory`, `Households`
- [ ] T010 `worker/runtime/clerk.ts`: session verification against Clerk JWKS and the Backend API adapter; tests with a fake JWKS in `worker/tests/clerk.test.ts`
- [ ] T011 `DirectoryObject` (handles with 90-day release, account and provider-account lookups) with tests in `worker/tests/directory.test.ts`
- [ ] T012 Storage links move to `HouseholdObject`; `PodObject` gets access tokens over RPC and stores its folder (`root` = handle); update `worker/tests/link.test.ts` and `make live` to the subfolder layout

## Phase 3: User Story 1, sign up and get a pod (P1) 🎯 MVP

**Goal**: A visitor signs up, picks a handle, connects Dropbox and has a pod in `Apps/solidshmolid/<handle>/`.

**Independent Test**: signup + connect on wrangler dev; profile public, root private; returning folder adopted.

- [ ] T013 [P] [US1] Tests: handle refused when taken/reserved/malformed; signup creates household with caller as manager; connect creates the pod in the link; existing folder adopted, in `worker/tests/households.test.ts`
- [ ] T014 [US1] `worker/app/households.ts`: signup, connect storage, create own pod
- [ ] T015 [US1] `/api/me`, `/api/signup`, `/api/storage/dropbox/start`, `/link/dropbox/callback` in `worker/runtime/api/`
- [ ] T016 [US1] Pages: sign-up and connect-storage (from approved mockups) in `worker/runtime/pages/`
- [ ] T017 [US1] e2e on wrangler dev with a Clerk testing token: sign up, connect (fake Dropbox in dev), read own profile, in `worker/tests/e2e-signin.test.ts`

## Phase 4: User Story 2, sign in to any Solid app (P1)

**Goal**: Our site is a Solid-OIDC provider for the WebIDs it hosts.

**Independent Test**: scripted client does code + PKCE + DPoP; our verifier, a stock CSS and the Inrupt client library all accept the result.

- [ ] T018 [P] [US2] Tests for `worker/app/provider.ts`: authorize needs a session; Client ID Document fetch with limits and exact redirect match; code single-use (second use revokes); PKCE; DPoP binding; refresh rotation with reuse revoking the family; revoke approval kills its tokens, in `worker/tests/provider.test.ts`
- [ ] T019 [US2] `worker/app/provider.ts` and `AccountObject` storage for approvals, codes, refresh families
- [ ] T020 [US2] Endpoints in `worker/runtime/oidc/`: discovery, JWKS, auth, token, reg, session end (contracts/oidc.md)
- [ ] T021 [US2] Consent page and app list (`/api/apps`) in `worker/runtime/pages/` and `worker/runtime/api/`
- [ ] T022 [US2] Profiles name our issuer (`solid:oidcIssuer`) for every hosted WebID; migrate dev pods
- [ ] T023 [P] [US2] Interop: a stock CSS pod granting our WebID accepts our token, in `worker/tests/oidc-interop.test.ts` (`make compat`)
- [ ] T024 [P] [US2] Interop: `@inrupt/solid-client-authn-node` completes login against wrangler dev (`make e2e`)

## Phase 5: User Story 3, member pods (P2)

- [ ] T025 [P] [US3] Tests: manager adds a managed member; Clerk user created (fake ClerkAdmin); pod in manager's link; member owns it, manager has Read/Write/Control, in `worker/tests/households.test.ts`
- [ ] T026 [US3] `POST /api/members` and the member card on the dashboard

## Phase 6: User Story 4, child device setup (P2)

- [ ] T027 [P] [US4] Tests: setup code only for that member, 15 minutes, audit row; reset revokes passkeys, approvals and refresh families
- [ ] T028 [US4] `setup-code` and `reset-login` endpoints; `/setup` page (ticket sign-in, then passkey registration)

## Phase 7: User Story 5, invite an adult (P3)

- [ ] T029 [P] [US5] Tests: invitation accepted with the invitee's own Clerk login binds the pod; move to own link keeps URLs
- [ ] T030 [US5] Invitations and `POST /api/pods/{handle}/move` (copy, adopt, switch; old copy serves until commit)

## Phase 8: User Story 6, family sharing (P3)

- [ ] T031 [P] [US6] Tests: WAC `acl:agentGroup` for groups hosted on this service; member added later gains access; non-member refused; CSS agrees (`make compat`)
- [ ] T032 [US6] Group document in the manager's pod kept current; `POST /api/folders/share`

## Phase 9: User Story 7, handover (P3)

- [ ] T033 [P] [US7] Tests: handover removes manager grants; failed copy leaves the pod serving and retryable
- [ ] T034 [US7] `POST /api/pods/{handle}/handover` and the member-side flow

## Phase 10: User Story 8, controls and guardrails (P3)

- [ ] T035 [P] [US8] Tests: disconnect refused while pods use the link (names them); delete keeps files by default; typed sentence required to delete files (red-reachable check run once)
- [ ] T036 [US8] Usage and app lists on the dashboard; delete flow with the two-step confirmation

## Phase 11: Polish

- [ ] T037 Update `docs/SPEC.md`, `CLAUDE.md`, README for accounts and the provider
- [ ] T038 `infra/solidshmolid/`: wrangler per-environment files (`stg-{handle}` routes), secrets contract, DEPLOY.md, smoke; first staging deploy from a tag
- [ ] T039 Run quickstart.md by hand on staging with a real Clerk instance and Dropbox

## Dependencies

- Setup (T001 to T005) before Foundational; T001 and T002 gate everything Clerk-shaped.
- Foundational (T006 to T012) before every story.
- US1 then US2 (sign-in needs hosted WebIDs); US3 to US8 depend on US1 and can then proceed in
  any order; US4 needs US3; US7 needs US5's move.

## Parallel Examples

- Foundational: T006, T007, T008 together (separate domain files).
- US2: T023 and T024 together once T020 lands.

## Implementation Strategy

MVP is US1 + US2: a person can get a pod in their own Dropbox and use it from any Solid app.
Ship that to staging, then add households (US3, US4), then the P3 stories.
