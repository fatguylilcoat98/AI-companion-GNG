# Source-of-Truth Memory Policy

**Applies to:** the companion platform — this master template and every
companion instance copied from it.
**Depends on:** `governance-vocabulary-lock.md` — every term here is
defined there and used exactly as locked.

## Purpose

This policy defines how a `claim` becomes — or is prevented from
becoming — a trusted `memory`, and how that trust changes over a
memory's life. It is the authority for every part of the platform that
writes, classifies, promotes, retracts, supersedes, or reads memory.

## 1. The three provenance classes

| Class | Origin | May enter governed context? |
|---|---|---|
| `VERIFIED_FACT` | Confirmed by an authoritative source | Yes, without caveat |
| `USER_STATED` | A first-party human stated it | Yes, subject to admissibility |
| `AI_INFERRED` | Model inference / summary | Restricted (see section 5) |

Every memory carries exactly one class and immutable provenance.

## 2. VERIFIED_FACT lifecycle

`proposed` -> `pending_confirmation` -> `verified` ->
(`superseded` | `retracted`). A claim is proposed; routed to an
authorized source; recorded as `VERIFIED_FACT` only on explicit
confirmation. A `VERIFIED_FACT` is never silently edited.

## 3. Core rule — model output cannot self-promote

> Model output, inference, or summarization can never become a
> `VERIFIED_FACT` without explicit confirmation from a human source or
> an authoritative external source. There is no automatic promotion
> path from `AI_INFERRED` to `VERIFIED_FACT`.

An `AI_INFERRED` record may be presented to an authorized human for
confirmation; if confirmed, a **new** `VERIFIED_FACT` is created with
provenance linking back. The original `AI_INFERRED` record is not
mutated.

## 4. USER_STATED handling

Trusted as "the supported person (or a first-party human) said this" —
not as established truth. The `admissibility` default for `USER_STATED`
is a deployment-owner decision (see `owner-decisions-template.md`):
auto-admit, or require owner approval per fact.

## 5. AI_INFERRED restrictions

Always provenance-tagged as model-originated. Never auto-admitted into
`governed context` that drives consequential behavior (safety,
financial, authorized-circle-contact actions) without review. Never
represented to anyone as fact.

## 6. Retraction

Marks a memory inadmissible; content and provenance preserved. An
immutable provenance and audit event. Excluded from `governed context`
and `continuity reconstruction`. Retraction never deletes.

## 7. Supersession

Creates a new memory and links the old one as predecessor; the old one
becomes inadmissible-by-supersession and is preserved. Editing a memory
in place is forbidden — correction is always supersession.

## 8. Disputed memory

Conflicting admissible claims, or a source disputing an existing memory,
put the affected memory or memories into a `disputed` admissibility
state — inadmissible until resolved by retraction, supersession, or
owner adjudication. Every step is recorded.

## 9. Inadmissible memory

Inadmissible = stored but excluded from `governed context`. Inadmissible
memories remain in storage and in the audit log; they are never silently
dropped or deleted.

## 10. Provenance immutability

Provenance is append-only. Existing entries are never edited or deleted.
A memory's origin source, timestamp, and intake path never change after
creation. **Corrections happen through supersession or retraction —
never silent mutation.**

## 11. Default privacy = private

Every new memory is created with `visibility` = `private`. Raising
visibility requires `authority validation` and is audit-logged. No code
path creates a memory at a broader visibility than `private` by default.

## 12. Explicit sharing only — family_shared rules

A memory becomes `family_shared` (visible to the supported person's
authorized circle) **only** by an explicit, authority-validated action.
Sharing is never implicit or automatic. The owning supported person may
return a memory to `private` at any time; the change is audit-logged.

## 13. password_locked rules

Gated by a vault secret; not surfaced into `governed context` until the
secret is supplied for the session. The database never receives the
plaintext secret — verification is performed by the application before a
vault session is opened. Vault access (success and failure) is
audit-logged.

## 14. Audit requirements

Every memory creation, admissibility transition, retraction,
supersession, visibility change, authority-validation outcome, and vault
access is written to the append-only audit log. **All sensitive access
must be audited.** Audit entries never enter `governed context`.

## 15. No fabricated memory

> The companion must never create, store, or present a `memory` that no
> `source` asserted. The model may not invent a `claim` and store it.
> `continuity reconstruction` only assembles existing admissible
> memories — it never synthesizes new claims and persists them.

## 16. Master-template data rule

The master template carries **no real memory** — no real
supported-person data, no client-specific memory, no exported memory
store. Demo / sample memory only, clearly fictional. Real memory exists
only inside a deployed companion instance. See
`../setup/template-boundaries.md`.

## 17. Mechanical enforcement (GM-21)

A subset of this policy is mechanically enforced by the execution-
decision classifier in `src/governance/` (see
`governance-runtime-boundary.md`). Specifically: §2/§3 (model
self-promotion forbidden), §3/§5 (`AI_INFERRED` must not auto-
promote), §4 (`USER_STATED` defaults to review), §6 (retraction
infrastructure not yet available), §7 (supersession infrastructure
not yet available), §12 (visibility promotion requires authority
validation), and §13 (vault infrastructure not yet available) all
have paired classifier branches and citations in the locked
`REASONS` vocabulary. Edits to those sections require paired
updates to `src/governance/decisions.js` and
`src/governance/classifier.js`, in the same PR.

## Change control

Locked. Changes are made by a reviewed change to this file, which lists
the documents and code paths affected.
