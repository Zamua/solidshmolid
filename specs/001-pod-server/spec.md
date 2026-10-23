# Feature Specification: Pod Server on the User's Own Storage

**Feature Branch**: `main` (built before Spec Kit was adopted; this spec records it)

**Created**: 2026-10-22

**Status**: Implemented (merged in PRs #1 to #5; design detail in `docs/SPEC.md`)

**Input**: User description: "A hosted Solid pod whose files live in the user's own Dropbox, so
they own their data, can see it in their Dropbox, and can walk away with a working pod."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Use a pod from any Solid app (Priority: P1)

A pod owner signs in to a Solid app with a WebID from any Solid identity provider. The app
reads, creates, edits and deletes the owner's documents and folders, and converts linked data
between the formats Solid apps use.

**Why this priority**: Without a working pod nothing else matters.

**Independent Test**: With a token from a stock Solid identity provider, an app creates a note,
reads it back in another format, patches it, lists its folder and deletes it.

**Acceptance Scenarios**:

1. **Given** a pod, **When** its owner saves a document at a new path, **Then** the missing
   folders are created and the document appears in its folder's listing.
2. **Given** a linked-data document, **When** an app asks for it in another RDF format,
   **Then** it receives the same graph in that format.
3. **Given** two apps editing one document, **When** one saves with a stale version tag,
   **Then** its save is refused and the other app's change survives.
4. **Given** a request with a forged, replayed or wrong-target token, **When** it reaches
   the pod, **Then** it is refused as unauthenticated.

---

### User Story 2 - Share with someone else (Priority: P1)

The owner grants another WebID read, append or write access to a folder. That person's apps
see exactly what was granted, and nothing outside it.

**Why this priority**: Sharing is the point of Solid over a plain cloud folder.

**Independent Test**: The owner writes an access rule for a folder; a second WebID reads and
writes inside it, is refused at the pod root, and cannot read or change the rule itself.

**Acceptance Scenarios**:

1. **Given** a folder shared read-only, **When** the other person writes to it, **Then** the
   write is refused.
2. **Given** append-only access to an inbox folder, **When** the other person posts a message,
   **Then** it is created, but they cannot overwrite or delete it afterwards.
3. **Given** an access rule edited outside the server into something unreadable, **When**
   anyone asks for access under that rule, **Then** nothing is granted.

---

### User Story 3 - Keep the pod in my own Dropbox (Priority: P1)

The owner connects their Dropbox. The pod's files move into a folder in their Dropbox, where
they can see them. From then on every save lands there, and edits made directly in Dropbox
show up in the pod.

**Why this priority**: This is the product's promise.

**Independent Test**: Connect a real Dropbox to a pod holding two notes; the notes appear in
`Apps/solidshmolid`; a new note saved through the pod appears there; a file edited and one
added directly in Dropbox are served by the pod shortly after.

**Acceptance Scenarios**:

1. **Given** an empty app folder, **When** the owner connects Dropbox, **Then** the pod is
   copied in and served from Dropbox.
2. **Given** an app folder that already holds a pod, **When** the owner connects it, **Then**
   that pod is adopted as is.
3. **Given** a connected pod, **When** a file is edited or added directly in Dropbox, **Then**
   the pod serves the change within 30 seconds of the next request.
4. **Given** the owner revoked the app in Dropbox, **When** the pod is used, **Then** it
   reports that storage must be reconnected instead of failing silently.

---

### User Story 4 - Walk away (Priority: P2)

The owner stops using solidshmolid. Their Dropbox folder alone is a complete pod that standard
Solid server software can serve.

**Why this priority**: It proves the ownership claim; it is rarely exercised.

**Independent Test**: Point a stock Community Solid Server at a copy of the folder; it serves the
same documents, folder listings and access decisions.

**Acceptance Scenarios**:

1. **Given** a folder written by this service, **When** a stock CSS serves it, **Then** every
   document has the same type and content and every access decision matches.
2. **Given** a folder written by a stock CSS, **When** this service adopts it, **Then** it
   serves the same documents, types and folder members.

### Edge Cases

- Two names that differ only in letter case: the second is refused, since Dropbox would merge them.
- A file name the layout cannot map, or two files claiming one resource: reported and left untouched.
- A document whose type has no file extension: its type is kept in a sidecar metadata file.
- Upload larger than 100 MB: refused by the platform before it reaches the pod.
- Dropbox busy with concurrent writes: retried briefly, then reported as temporarily unavailable.
- Linked data that points at a remote JSON-LD context: refused rather than fetched.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The pod MUST implement Solid resource semantics: documents, folders (containers),
  create, read, replace, patch (N3 Patch) and delete, with version-tag preconditions.
- **FR-002**: The pod MUST serve linked data as Turtle, JSON-LD and N-Triples on request.
- **FR-003**: The pod MUST enforce Web Access Control, including inherited defaults, Append
  versus Write, and Control for access rules; unreadable rules MUST grant nothing.
- **FR-004**: The pod MUST accept only DPoP-bound Solid-OIDC tokens whose WebID names their issuer,
  and MUST refuse a reused proof.
- **FR-005**: The pod folder MUST use Community Solid Server's file-backend layout.
- **FR-006**: The owner MUST be able to connect Dropbox without the service holding an app secret;
  the stored grant MUST be encrypted at rest.
- **FR-007**: The pod MUST pick up changes made directly in the storage within 30 seconds of use.
- **FR-008**: The service MUST keep no copy of user files beyond small cached linked-data documents.

### Key Entities

- **Pod**: a handle, its URL and a folder in the owner's storage.
- **Resource**: a document or folder in a pod, with a type and a version tag.
- **Access rule**: a linked-data document granting modes to agents for a resource or folder.
- **Storage link**: the encrypted Dropbox grant and change cursor for a pod.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A stock Community Solid Server serves 100% of documents written by this service with
  identical type and content (checked on every change).
- **SC-002**: Every access decision checked in the compatibility suite matches CSS.
- **SC-003**: Edits made directly in Dropbox appear in the pod within 30 seconds of the next request.
- **SC-004**: Small linked-data reads (access rules, profiles) need no call to the storage provider.

## Assumptions

- Dropbox is the first provider; Google Drive, OneDrive and WebDAV follow as separate features.
- Pods are created by the operator or the dev configuration until accounts exist (spec 002).
- Local development stores files in the pod's own database; deployments never do.
