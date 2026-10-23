# Feature Specification: Accounts, Pods and Solid Sign-In

**Feature Branch**: `002-accounts-households`

**Created**: 2026-10-22

**Status**: Clarified; scope reduced 2026-10-23

**Input**: User description: "Users sign in with one solidshmolid login (Clerk, as in our other
apps), then link whatever storage they use. Our site is also the Solid identity provider those
people sign in with from any Solid app." Revised 2026-10-23: "an account can make multiple pods
for themselves and that's it" (households, members and children's accounts are out of scope).

## Clarifications

### Session 2026-10-22

- Q: When a pod or account is deleted, what happens to its storage folder? → A: The user chooses
  at deletion time; the default leaves it untouched. Deleting the files takes several
  confirmation steps, including typing a sentence naming the storage provider.
- Q: How do staging pods get HTTPS on a single domain? → A: Staging pod hosts are one label
  under the production pod domain (`<id>-stg.solidshmolid.page`, covered by the free
  certificate); no Advanced Certificate Manager.
- Q: Do people pick their pod's address? → A: No. Each pod gets a short random id
  (`k3x9fqm7.solidshmolid.com`) so names cannot be squatted.

### Session 2026-10-23

- Q: Households, managed members and children's accounts? → A: Out of scope. One person, one
  account, one WebID; the person may make more pods for themselves. Children's accounts would
  need a children's-privacy (COPPA) review first.
- Q: Does each extra pod get its own WebID? → A: No. Extra pods belong to the person's one
  WebID and are listed in its profile as storages.

## User Scenarios & Testing *(mandatory)*

Running example: Dana, who keeps her files in Dropbox.

### User Story 1 - Sign up, connect storage, get a pod (Priority: P1)

Dana visits solidshmolid.com, signs up, connects her Dropbox, and has a pod at a short random
address such as `k3x9fqm7.solidshmolid.com` with her WebID, its files in her Dropbox.

**Why this priority**: The minimum product: a person can get a pod without operator help.

**Independent Test**: A new visitor completes signup and storage connection, and their pod's
profile is publicly readable at its WebID while its root is private.

**Acceptance Scenarios**:

1. **Given** a new visitor, **When** they sign up, **Then** a WebID is created at a newly
   assigned random id that no other pod has ever used.
2. **Given** a signed-up user without connected storage, **When** they finish connecting
   storage, **Then** the pod's files are in a folder named for the pod in that storage.
3. **Given** a storage folder that already holds a pod for that id (a returning user),
   **When** it is connected, **Then** that pod is adopted rather than overwritten.

---

### User Story 2 - Sign in to any Solid app (Priority: P1)

Dana opens a third-party Solid app, chooses "solidshmolid.com" as her provider, signs in with her
solidshmolid login, approves the app, and the app works with her pods as her WebID.

**Why this priority**: Without it, users need a WebID from another provider, which defeats the point.

**Independent Test**: A standard Solid client library completes login against our provider and
makes an authenticated request that the pod accepts as Dana's WebID.

**Acceptance Scenarios**:

1. **Given** a Solid app that names our site as provider, **When** Dana signs in and approves,
   **Then** the app receives tokens identifying her WebID.
2. **Given** an app Dana approved before, **When** she signs in again, **Then** she is not asked
   to approve again until she revokes it.
3. **Given** Dana revokes an app in her account, **When** the app next uses its tokens, **Then**
   it can no longer act as Dana.

---

### User Story 3 - More pods (Priority: P2)

Dana adds a second pod for work. It gets its own random address and its own folder in her
Dropbox, belongs to her WebID, and apps that read her profile find it.

**Why this priority**: Separate spaces for separate parts of life, under one sign-in.

**Independent Test**: After adding a pod, it serves only Dana, has no profile of its own, and
Dana's profile lists it as a storage.

**Acceptance Scenarios**:

1. **Given** an account with connected storage, **When** Dana adds a pod, **Then** it gets a new
   random id and its own folder beside her first pod.
2. **Given** a second pod, **When** anyone looks at it, **Then** Dana's WebID has full access and
   nobody else has any.
3. **Given** a second pod, **When** an app reads Dana's profile, **Then** it finds both pods as
   her storages.

---

### User Story 4 - Controls and guardrails (Priority: P3)

Dana sees the apps she approved and revokes one. She cannot disconnect storage that still holds
pods. Deleting a pod or her account asks whether to also delete the files in her storage, and
deleting them takes several deliberate confirmations.

**Why this priority**: Needed before people rely on it; not needed for a first user.

**Independent Test**: Disconnecting storage that holds pods is refused with the list of pods to
delete first.

**Acceptance Scenarios**:

1. **Given** storage holding two pods, **When** Dana tries to disconnect it, **Then** it is
   refused and both pods are named.
2. **Given** a pod, **When** Dana deletes it and keeps the default, **Then** its address stops
   resolving and its folder stays in her storage, still a complete pod.
3. **Given** Dana chooses to delete the files too, **When** she has not typed the confirmation
   sentence naming her storage provider exactly, **Then** nothing is deleted.

### Edge Cases

- Ids are never reused, so an old link to a deleted pod can never point at someone else.
- Storage revoked from the provider's side while pods live there: every affected pod reports
  "storage disconnected" and the person is shown a reconnect action.

## Requirements *(mandatory)*

### Functional Requirements

**Accounts and sign-in**

- **FR-001**: People MUST sign in to solidshmolid through Clerk (email codes, and Google as
  offered by Clerk); the service stores no passwords.
- **FR-002**: An account MUST be able to own several storage links and several pods.
- **FR-003**: Signing in MUST NOT require owning a storage account.

**Solid identity provider**

- **FR-004**: The service MUST act as a Solid-OIDC identity provider for every WebID it hosts,
  using the Clerk session to establish who is signing in.
- **FR-005**: The provider MUST accept apps identified by Client ID Documents, and MAY accept
  dynamically registered clients.
- **FR-006**: Issued access tokens MUST be DPoP-bound and carry the person's WebID.
- **FR-007**: Each person MUST be able to see and revoke the apps they approved.
- **FR-008**: A WebID's profile MUST name this provider as its issuer.

**Pods**

- **FR-009**: Pod addresses MUST be assigned by the service as random ids of 8 characters from an
  unambiguous lowercase alphabet (no `0`, `1`, `i`, `l`, `o`), unique service-wide and never
  reused. People never choose them.
- **FR-010**: An account MUST have exactly one WebID, whose profile lives in its first pod.
- **FR-011**: Each pod MUST live in its own folder inside one storage link; several pods MAY
  share one link.
- **FR-012**: A pod's root access rule MUST give the account's WebID Read, Write and Control,
  inherited by the whole pod, and nobody else any access.
- **FR-013**: Every pod after the first MUST be listed as a `pim:storage` of the WebID in its
  profile, and MUST NOT have a profile of its own.
- **FR-014**: Moving a pod to another storage link MUST keep every resource URL, and MUST leave
  the old copy serving until the new one is complete.
- **FR-015**: Storage that still holds pods MUST NOT be disconnectable.
- **FR-016**: Deleting a pod or account MUST ask whether to also delete the pod folders in the
  user's storage; the default MUST leave them untouched. Deleting the files MUST take at least
  two separate confirmation steps, the last requiring the user to type a sentence naming the
  storage provider (for example "yes, delete my data in Dropbox"); anything else cancels.

### Key Entities

- **Account**: a person who signs in (a Clerk user), with one WebID; owns storage links and pods.
- **Storage link**: a connected provider account (Dropbox, later Drive and OneDrive) owned by an
  account; holds the encrypted grant.
- **Pod**: a random id, a folder within one storage link, owned by the account's WebID.
- **App approval**: a person's consent for a Solid app (client) to act as their WebID.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new user goes from landing page to a working pod in their own storage in under
  3 minutes.
- **SC-002**: A standard Solid client library signs in against the provider and makes an accepted
  authenticated request on the first attempt (checked automatically on every change).
- **SC-003**: After a storage move, 100% of previously valid resource URLs still resolve.
- **SC-004**: The service holds no passwords and no storage app secrets.
- **SC-005**: No storage files are ever deleted without the typed confirmation (checked by a test
  that attempts deletion with every other input).

## Assumptions

- Clerk is the account system, as in the operator's other apps; its free tier covers early use
  (passkeys need its paid tier and are not required).
- Dropbox is the only storage provider at launch; Drive and OneDrive arrive as separate features
  and slot into the same storage-link model.
- Per-pod storage use is the size of its folder as reported by the provider.
