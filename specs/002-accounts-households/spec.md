# Feature Specification: Accounts, Households and Solid Sign-In

**Feature Branch**: `002-accounts-households`

**Created**: 2026-10-22

**Status**: Clarified

**Input**: User description: "Users sign in with one solidshmolid login (Clerk, as in our other
apps), then link whatever storage they use. One account can create and manage several pods, for
example a parent with one Google Drive making pods for a spouse and three kids and handing each
their own identity. Our site is also the Solid identity provider those people sign in with from
any Solid app."

## Clarifications

### Session 2026-10-22

- Q: What may a manager do with a managed member's data? → A: Full access: managers read and
  write member pods in any Solid app. A member who wants privacy gets their own account and
  storage (handover).
- Q: What is a managed child, account-wise? → A: A separate Clerk user the manager creates
  (username, no email), signed in on the child's device by a one-time setup code plus passkey.
  Revisit after real use.
- Q: When a pod or account is deleted, what happens to its storage folder? → A: The user chooses
  at deletion time; the default leaves it untouched. Deleting the files takes several
  confirmation steps, including typing a sentence naming the storage provider.

## User Scenarios & Testing *(mandatory)*

Running example: Dana (manager), her spouse Alex, and their kids Sam (8), Maya (16) and Leo (12).

### User Story 1 - Sign up, connect storage, get a pod (Priority: P1)

Dana visits solidshmolid.com, signs up, picks the handle `dana`, connects her Dropbox, and has a
pod at `dana.solidshmolid.com` with her WebID, its files in her Dropbox.

**Why this priority**: The minimum product: a person can get a pod without operator help.

**Independent Test**: A new visitor completes signup and storage connection, and their pod's
profile is publicly readable at its WebID while its root is private.

**Acceptance Scenarios**:

1. **Given** a new visitor, **When** they sign up and choose a free handle, **Then** a pod and
   WebID are created for that handle.
2. **Given** a taken, reserved or malformed handle, **When** it is chosen, **Then** it is refused
   with the reason before anything is created.
3. **Given** a signed-up user without connected storage, **When** they finish connecting
   storage, **Then** the pod's files are in a folder named for the pod in that storage.
4. **Given** a storage folder that already holds a pod for that handle (a returning user),
   **When** it is connected, **Then** that pod is adopted rather than overwritten.

---

### User Story 2 - Sign in to any Solid app (Priority: P1)

Dana opens a third-party Solid app, chooses "solidshmolid.com" as her provider, signs in with her
solidshmolid login, approves the app, and the app works with her pod as `dana`.

**Why this priority**: Without it, users need a WebID from another provider, which defeats the point.

**Independent Test**: A standard Solid client library completes login against our provider and
makes an authenticated request that the pod accepts as Dana's WebID.

**Acceptance Scenarios**:

1. **Given** a Solid app that names our site as provider, **When** Dana signs in and approves,
   **Then** the app receives tokens identifying `dana.solidshmolid.com/profile/card#me`.
2. **Given** an app Dana approved before, **When** she signs in again, **Then** she is not asked
   to approve again until she revokes it.
3. **Given** Dana manages several identities, **When** she signs in to an app, **Then** she
   chooses which of her own identities the app gets; managed members' identities are not offered.
4. **Given** Dana revokes an app in her account, **When** the app next uses its tokens, **Then**
   it can no longer act as Dana.

---

### User Story 3 - Create pods for family members (Priority: P2)

Dana creates pods `sam`, `maya` and `leo` inside her household. Each lives in its own folder in
Dana's connected storage and has its own WebID.

**Why this priority**: The household case is what makes one account manage many pods.

**Independent Test**: A manager creates a pod for a member who has no login yet; the pod exists,
is stored in the manager's storage, and its WebID is distinct from the manager's.

**Acceptance Scenarios**:

1. **Given** a household with connected storage, **When** the manager adds a member pod,
   **Then** it gets its own folder, handle and WebID, and the manager is recorded as its manager.
2. **Given** a member pod, **When** anyone looks at it, **Then** its owner is the member's
   WebID, not the manager's; the manager's full access is a separate grant.
3. **Given** a member pod, **When** the manager signs in to a Solid app as themselves,
   **Then** the app can read and write the member's pod.

---

### User Story 4 - Set up a child's device (Priority: P2)

Dana taps "Set up Sam's device". A one-time QR code appears. Sam's tablet scans it, is signed in
as Sam, and registers a passkey. Afterwards Sam signs in himself with the passkey.

**Why this priority**: Children cannot sign in with email or their own storage account.

**Independent Test**: A one-time setup code signs a fresh device in as the member and registers
a passkey; the code then stops working; the passkey alone signs in afterwards.

**Acceptance Scenarios**:

1. **Given** a member without a login, **When** the manager creates a setup code, **Then** it
   works once, within 15 minutes, and only for that member.
2. **Given** a member who lost their device, **When** the manager resets their login, **Then**
   existing passkeys and app approvals for that member stop working and a new setup code is issued.

---

### User Story 5 - Invite an adult member (Priority: P3)

Dana invites Alex by email. Alex signs up with his own solidshmolid login and receives the pod
`alex`. He can keep it in Dana's storage or connect his own and move it there.

**Why this priority**: Adults in a household need independence; less urgent than the core.

**Independent Test**: An invited adult accepts, signs in with their own login, and controls
their pod; moving it to their own storage keeps the same WebID and URLs.

**Acceptance Scenarios**:

1. **Given** an invitation, **When** Alex accepts with his own login, **Then** the `alex` pod
   is his to sign in as.
2. **Given** Alex connects his own storage and moves his pod, **When** the move completes,
   **Then** the pod is served from his storage with unchanged URLs, and its folder no longer
   counts against Dana's storage.

---

### User Story 6 - Share within the family (Priority: P3)

Dana marks her `photos/` folder as shared with the family. Every household member's WebID can
read it in any Solid app.

**Why this priority**: Expected household behavior; built on access rules that already work.

**Independent Test**: Toggling family sharing on a folder grants read to every current member;
a member added later gains access without editing the folder again.

**Acceptance Scenarios**:

1. **Given** a folder shared with the family, **When** a member's app reads it, **Then** it
   succeeds; **When** a non-member's app reads it, **Then** it is refused.
2. **Given** a member who leaves the household, **When** their app reads it, **Then** it is refused.

---

### User Story 7 - Hand over a pod (Priority: P3)

Maya grows up. Dana hands her pod over: Maya adds her own login, connects her own storage, her
folder is copied there, and Dana stops being her manager.

**Why this priority**: Makes "your data" true for members who started managed.

**Independent Test**: After handover the pod is served from the member's storage with the same
WebID and URLs; the former manager can no longer manage or read it.

**Acceptance Scenarios**:

1. **Given** a managed member pod, **When** handover completes, **Then** the member is its only
   controller and the manager's grant is removed.
2. **Given** a handover in progress, **When** the copy fails midway, **Then** the pod keeps
   serving from the old storage and the handover can be retried.

---

### User Story 8 - Manager controls and guardrails (Priority: P3)

Dana sees each pod's storage use and which apps each member has approved. She can reset a
member's login, export or delete a member pod, and cannot disconnect storage that still holds
pods. Deleting asks whether to also delete the files in her storage, and deleting them takes
several deliberate confirmations.

**Why this priority**: Needed before real families rely on it; not needed for a first user.

**Independent Test**: Disconnecting storage that holds pods is refused with the list of pods to
move or delete first.

**Acceptance Scenarios**:

1. **Given** storage holding three pods, **When** Dana tries to disconnect it, **Then** it is
   refused and the three pods are named.
2. **Given** a member pod, **When** Dana deletes it and keeps the default, **Then** its handle
   stops resolving and its folder stays in her storage, still a complete pod.
3. **Given** Dana chooses to delete the files too, **When** she has not typed the confirmation
   sentence naming her storage provider exactly, **Then** nothing is deleted.

### Edge Cases

- A handle that once belonged to a deleted pod: not reusable for 90 days, so old links do not
  silently point at someone else.
- A member who belongs to two households: not supported in v1; one household per member.
- Storage revoked from the provider's side while pods live there: every affected pod reports
  "storage disconnected" and the manager is shown a reconnect action.
- A setup code shared outside the family: it works once and expires; a used code shows who used it.
- A manager who deletes their own account while managing others: refused until members are
  handed over or deleted.

## Requirements *(mandatory)*

### Functional Requirements

**Accounts and sign-in**

- **FR-001**: People MUST sign in to solidshmolid through Clerk (passkeys, email codes, and
  Google/Apple as offered by Clerk); the service stores no passwords.
- **FR-002**: An account MUST be able to own several storage links and manage several pods.
- **FR-003**: Signing in MUST NOT require owning a storage account.

**Solid identity provider**

- **FR-004**: The service MUST act as a Solid-OIDC identity provider for every WebID it hosts,
  using the Clerk session to establish who is signing in.
- **FR-005**: The provider MUST accept apps identified by Client ID Documents, and MAY accept
  dynamically registered clients.
- **FR-006**: Issued access tokens MUST be DPoP-bound and carry the chosen WebID.
- **FR-007**: Each person MUST be able to see and revoke the apps they approved.
- **FR-008**: A WebID's profile MUST name this provider as its issuer.

**Pods and households**

- **FR-009**: Handles MUST be unique service-wide, follow the handle rules, and exclude reserved names.
- **FR-010**: A household MUST have at least one manager; managers can add member pods.
- **FR-011**: Each pod MUST live in its own folder inside one storage link; several pods MAY
  share one link.
- **FR-012**: A member pod's root access rule MUST name the member's WebID as owner and grant
  each manager's WebID Read, Write and Control (inherited by the whole pod). Handover removes
  the managers' grant.
- **FR-013**: A managed member MUST be a separate Clerk user created by the manager, with a
  username and no email address; it signs in with passkeys registered through device setup
  codes. Handover adds the member's own email or other sign-in method to that same user.
- **FR-014**: Device setup codes MUST be single-use, member-specific and expire in 15 minutes.
- **FR-015**: Resetting a member's login MUST revoke their passkeys and app approvals.
- **FR-016**: Family sharing MUST be expressed as an access rule naming a household group, so
  membership changes take effect without editing shared folders.
- **FR-017**: Moving a pod to another storage link MUST keep its WebID and every resource URL,
  and MUST leave the old copy serving until the new one is complete.
- **FR-018**: Storage that still holds pods MUST NOT be disconnectable.
- **FR-019**: Deleting a pod or account MUST ask whether to also delete the pod folders in the
  user's storage; the default MUST leave them untouched. Deleting the files MUST take at least
  two separate confirmation steps, the last requiring the user to type a sentence naming the
  storage provider (for example "yes, delete my data in Dropbox"); anything else cancels.

### Key Entities

- **Account**: a person who signs in (a Clerk user); may own storage links and manage pods.
- **Household**: a group of accounts and pods with one or more managers.
- **Storage link**: a connected provider account (Dropbox, later Drive and OneDrive) owned by an
  account; holds the encrypted grant.
- **Pod**: handle, WebID, a folder within one storage link, its owner and its managers.
- **Identity binding**: which accounts may sign in as which WebID.
- **App approval**: a person's consent for a Solid app (client) to act as one of their WebIDs.
- **Device setup code**: a one-time, expiring invitation to sign a device in as a member.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new user goes from landing page to a working pod in their own storage in under
  3 minutes.
- **SC-002**: A manager sets up a child's device, from tapping "set up" to the child signed in
  with a passkey, in under 2 minutes.
- **SC-003**: A standard Solid client library signs in against the provider and makes an accepted
  authenticated request on the first attempt (checked automatically on every change).
- **SC-004**: After a handover or storage move, 100% of previously valid resource URLs still resolve.
- **SC-005**: The service holds no passwords and no storage app secrets.
- **SC-006**: No storage files are ever deleted without the typed confirmation (checked by a test
  that attempts deletion with every other input).

## Assumptions

- Clerk is the account system, as in the operator's other apps; its free tier covers early use.
- Dropbox is the only storage provider at launch; Drive and OneDrive arrive as separate features
  and slot into the same storage-link model.
- A Clerk Organization models a household, unless planning finds a simpler fit.
- One household per member in v1.
- Accounts for children under 13 are created by a parent who consents; a review against
  children's-privacy law (COPPA in the US) happens before public launch.
- Per-pod storage use is the size of its folder as reported by the provider.
