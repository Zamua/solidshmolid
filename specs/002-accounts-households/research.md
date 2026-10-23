# Research: Accounts, Households and Solid Sign-In

## R1. Who issues Solid tokens

- **Decision**: Our own Solid-OIDC provider in the Worker on the apex host. Clerk only answers
  "which person is at this browser" during the authorization step.
- **Rationale**: Solid-OIDC needs a `webid` claim, DPoP-bound access tokens (`cnf.jkt`), the
  `solid_oidc_supported` discovery field and Client ID Documents (a client identified by a URL
  we dereference). Clerk's OAuth-provider feature offers none of these. The token format already
  has a working verifier in this repo, so issuer and verifier can be tested against each other,
  and against Community Solid Server as an independent resource server.
- **Alternatives**: `oidc-provider` (what CSS uses) is Node-server shaped (koa, its own
  adapters) and fights the Workers runtime; Clerk as the OP cannot emit Solid tokens; a separate
  CSS instance as IdP would put identity on a second server we run.

## R2. Signing keys

- **Decision**: An ES256 key pair held as the Worker secret `OIDC_SIGNING_JWK`; the JWKS
  publishes it with its `kid`. Rotation adds a second secret, publishes both, signs with the
  new one, and retires the old after the longest token lifetime.
- **Rationale**: One secret, no key storage service. ES256 is accepted by every Solid verifier.

## R3. Clerk on Workers

- **Decision**: Clerk's frontend (`@clerk/clerk-js`) on our apex pages for sign-in, sign-up and
  passkeys; the Worker verifies the Clerk session token against Clerk's JWKS (the same pattern
  as kcal) and calls Clerk's Backend API with `CLERK_SECRET_KEY` for creating managed members,
  issuing sign-in tokens and removing passkeys.
- **Rationale**: Matches the operator's other apps; no passwords stored here (FR-001).
- **Spike result (2026-10-23, dev instance)**: with email optional, usernames on (minimum
  length 1) and passwords off, the Backend API creates a username-only user
  (`skip_password_requirement`) with no email and no password. Instance sign-in is passwordless:
  email code, Google, passkeys.

## R4. Device setup codes

- **Decision**: A setup code is a Clerk sign-in token (`POST /v1/sign_in_tokens`,
  `expires_in_seconds: 900`) for the member's Clerk user, shown as a QR code of
  `https://<apex>/setup#<token>`. The page signs in with Clerk's ticket strategy, then asks the
  device to register a passkey.
- **Rationale**: Clerk sign-in tokens are single-use by design and accept a custom lifetime,
  which is exactly FR-014. Putting the token in the URL fragment keeps it out of server logs.
- **Spike result (2026-10-23)**: a 900 s token for the username-only user signed a fresh
  browser in on first use; the second use was refused ("This sign in token has already been
  used"). Passkey registration needs a real authenticator: checked on a device, or with a
  virtual authenticator in e2e.

## R5. Where state lives

- **Decision**: Durable Objects only, keyed by their natural isolation boundary:
  - `PodObject` per handle (exists): index, write queue, replay check.
  - `HouseholdObject` per household id: members and roles, pods, storage links with encrypted
    refresh tokens, the access-token cache.
  - `AccountObject` per Clerk user id: which WebIDs the person may sign in as, app approvals,
    authorization codes and refresh-token families.
  - `DirectoryObject` (single): handle reservations, Clerk user to household, provider account
    to storage link (for webhooks later).
- **Rationale**: Each object owns one kind of authority; a pod never sees another household's
  credentials. No D1 (constitution VII): the only cross-cutting lookups are a handful of keyed
  reads served by one directory object.
- **Alternatives**: D1 for the directory (unneeded SQL across accounts); Clerk Organizations
  for households (we would still need our own record for storage links and pods, giving two
  sources of truth for membership).

## R6. Several pods in one storage link

- **Decision**: Each pod lives in the subfolder named by its handle: `Apps/solidshmolid/<handle>/`.
  The storage link (one refresh token) belongs to the household; a pod's Durable Object asks its
  household for an access token over RPC and caches it until shortly before expiry.
- **Rationale**: The Dropbox adapter already supports a root subfolder. One grant per provider
  account matches how users think ("I connected my Dropbox once").
- **Consequence**: Walking away means pointing CSS at one pod's subfolder. A development pod
  linked at the app-folder root before this change is dev-only data and is not migrated.

## R7. Family sharing

- **Decision**: WAC `acl:agentGroup` pointing at a `vcard:Group` document stored in the
  manager's pod (`/household/members.ttl#members`), readable by household members. The service
  keeps it current when membership changes. The WAC evaluator gains group support for groups
  hosted on this service (read through the owning pod), not arbitrary remote groups.
- **Rationale**: Standard WAC, so CSS evaluates the same rules after walking away; the group
  lives in the user's storage like everything else.

## R8. Manager access and handover

- **Decision**: On creating a member pod, its root ACL grants the member's WebID full control
  and each manager's WebID Read, Write and Control with `acl:default` (FR-012). Handover rewrites
  the root ACL without the manager authorizations, then moves the folder to the member's storage
  link with the existing copy-and-adopt path; the old copy keeps serving until the new one is
  complete (FR-017).

## R9. Deletion confirmation

- **Decision**: Deleting files is a separate API call requiring a token from a first
  confirmation step and the exact sentence `yes, delete my data in <Provider>`; the check is a
  pure domain function with a test that every other input deletes nothing (SC-006).

## R10. Interop testing of our provider

- **Decision**: Three automated checks: (1) a scripted Solid client does authorization code +
  PKCE + DPoP against our provider and our own verifier accepts the token; (2) a stock CSS pod
  granting our WebID accepts our token (independent resource server); (3) a standard Solid
  client library (`@inrupt/solid-client-authn-node`) completes login.
- **Rationale**: Issuer and verifier written by the same hands can share a mistake; CSS and the
  Inrupt library are independent implementations.
