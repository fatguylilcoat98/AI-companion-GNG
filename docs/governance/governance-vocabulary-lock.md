# Governance Vocabulary Lock

**Applies to:** the companion platform — this master template and every
companion instance copied from it.
**Status:** Locked. See "Change control" below.

## Why this document exists

A companion instance is built, deployed, and maintained by different
people over time. Terms like "memory", "fact", and "provenance" drift in
meaning unless they are pinned. This file is the single, locked
definition of each governance term. Every schema migration, every
policy, and every governance code path in the platform uses each term
exactly as defined here.

A term is **locked**: it is not redefined casually. Changing a
definition is a reviewed change to this file that lists the documents
and code paths that must be re-checked.

**Notation.** A concept is written in `code font`. An enum value a
column or flag is expected to hold is written in `UPPER_SNAKE` or
`lower_snake`.

## A. Foundations

### source
The external origin of an assertion: a person (the supported person, an
authorized circle member, the operator), a document, a sensor, or an
upstream system. A `source` is *who or what said it* — not the assertion
itself.

### provenance
The immutable metadata recording where a `claim` came from: which
`source` asserted it, when, by what path, and every governance action
since. Provenance answers "how do we know this?". It is append-only.

### claim
A single discrete assertion about the world or the supported person. A
claim is *content only* — not yet trusted or classified.

### memory
A `claim` stored with `provenance`, a record classification, a
`visibility` level, and an `admissibility` state. "Memory" is the
governed unit of recall. Raw model output and raw conversation text are
**not** memory until stored through the governed path.

## B. Record classifications (the three provenance classes)

### `VERIFIED_FACT`
A `memory` whose `claim` has been confirmed by an authoritative `source`
through `authority validation` and explicit human or source
confirmation. The strongest trust class. Model output alone can never
produce a `VERIFIED_FACT`.

### `USER_STATED`
A `memory` whose `claim` was stated by the supported person, or another
first-party human source, without independent verification. Trusted as
"that person said so", not as established fact.

### `AI_INFERRED`
A `memory` whose `claim` was produced by the model inferring,
summarizing, or pattern-matching — not directly stated by a human
source. The weakest trust class. Always provenance-tagged as
model-originated and subject to the strictest `admissibility` and
`governed context` restrictions.

## C. Lifecycle and governance operations

### admissibility
The governance decision of whether a `memory` may enter `governed
context` and influence companion behavior. A memory can be stored yet
*inadmissible* (held, disputed, retracted, superseded, or pending
approval). Admissibility is separate from existence and separate from
`visibility`.

### authority validation
The check that a `source` actually has the standing to assert or confirm
a given `claim`, or to change a memory's `visibility` or
`admissibility`.

### retraction
Marking a `memory` as no longer asserted. A retracted memory becomes
inadmissible; its content and `provenance` are preserved, never deleted.

### supersession
Replacing a `memory`'s `claim` with a newer, corrected claim. A new
memory record is created and the old one is preserved and linked as the
superseded predecessor. Correction is supersession — never an in-place
edit.

### continuity reconstruction
Assembling a coherent, time-ordered picture of the supported person and
the relationship from stored, *admissible* memories across sessions —
so the companion "remembers" without re-deriving.

### governed context
The filtered, admissibility-checked, visibility-respecting set of
memories and profile data assembled for a single companion turn. It is
the **only** memory surface the model sees.

## D. Visibility model

### visibility
The access-control classification on a `memory` determining *who may see
it*: `private`, `family_shared`, `password_locked`.

### `private`
Default visibility. Visible only to the supported person it belongs to
(and the system path serving them).

### `family_shared`
Visible to the supported person and to their **authorized circle** — the
circle members linked to that supported person within the same `pilot
instance`. (The enum token is `family_shared`; the concept it names is
the authorized circle.)

### `password_locked`
Gated behind a separate vault secret; not surfaced into `governed
context` until the secret is supplied for the session.

## E. Audit

### audit log
The append-only record of governance-relevant events: memory creation,
admissibility transitions, retraction, supersession, visibility changes,
authority-validation outcomes, and vault access. It is not `memory` and
never enters `governed context`.

## F. Tenancy and profiles

### pilot instance
The data-scoping boundary: one deployed companion configured for one
supported person and their authorized circle. Every memory, profile,
and audit row is scoped to exactly one pilot instance.

### companion instance
A deployment produced by copying the master template — the running
product for one supported person. (Usually the same boundary as one
`pilot instance`: "pilot instance" is the data-scoping term, "companion
instance" is the deployment term.)

### companion profile
The configuration of the companion itself for an instance: its name,
persona / tone calibration, voice settings, safety posture. *About the
AI.*

### supported-person profile
The durable, structured record of the supported person: identity,
authorized-circle contacts, routines, preferences, care-relevant facts.
*About the human.*

### continuity profile
The evolving, reconstructed picture of the *relationship and ongoing
narrative* between the supported person and the companion. Produced by
`continuity reconstruction`.

## G. Master-template rules

These rules bind the **master template** specifically:

- **No real user data in the master.** The master template contains no
  real supported-person data, no real memories, no real authorized-
  circle information. Demo / sample data only — clearly fictional.
- **No client-specific memory in the master.** Memory belongs in a
  companion instance, never in the template.
- See `../setup/template-boundaries.md` for the full boundary list.

## Change control

This file is locked. To change a definition, open a reviewed change to
this file only, state the old and new wording, and list every document
and code path that references the term. Do not redefine a term inline
elsewhere.

## Cross-references

- `source-of-truth-memory-policy.md` — how a `claim` becomes a trusted
  `memory`.
- `feature-flag-model.md` — the staged-rollout flag model.
- `owner-decisions-template.md` — decisions a deployment owner records
  per instance.
- `../setup/template-boundaries.md` — what must never enter the master.
