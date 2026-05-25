# Project Separation

**Applies to:** the entire `ai-companion-gng` repository — the
Lylo Companion Golden Master Template, also referred to in
conversation as the Maddie / GNG companion. This document is
the explicit, repo-local statement that this codebase is
independent of any other AI / governance project and exists on
its own architectural foundation.

**Status:** documentation-only. This file adds no architecture,
no runtime logic, no dependencies, no schema, and no test
canary. The mechanical enforcement of the separation lives in
`scripts/ci/check-contamination.js` (the existing GM-baseline
contamination scanner) plus the various per-module boundary
guards. This document records the **policy**; those guards
record the **mechanics**.

## What this repo is

- The Lylo Companion Golden Master Template.
- A standalone, copy-to-fork blueprint for individual companion
  AI instances.
- A self-contained substrate of governance-staging tables,
  Decision-gated actors, and append-only ledgers, built across
  GM-3 through GM-30 inside this repository.
- Dependent only on the three pinned npm packages declared in
  `package.json`: `@anthropic-ai/sdk` (model SDK),
  `pg` (Postgres driver), and `ajv` (JSON Schema validator,
  devDependency).

## What this repo is NOT

This repository does NOT contain, depend on, import, or imply
any of the following:

- Any external NDA project's code, schema, runtime, or canon.
- Any "Pete" project, "U4CE" project, "You4C" project,
  "Project Cairn" project, or any other named external
  project whose terminology occasionally appears in
  conversational context.
- Any external governance substrate, lineage substrate,
  continuity substrate, or "canonical authority" surface from
  another codebase.
- Any external project's vocabulary, intent types, actor
  pattern, RLS contract, or migration shape.
- Any sibling repository (`mattie-the-protective-ai`,
  `lylo-website`) as a runtime dependency. References to those
  repos exist ONLY in this repo's own boundary documentation
  to explain what the template is extracted from and what
  scope adjacent repositories occupy.

The mechanical proof is in the contamination scanner's denylist
(`mattie`, `sandy`, `mattie_soul`) plus the boundary guards'
import allowlists. The substrate-freeze canary (L22) plus the
14 boundary guards plus the existing C2/C3/C4 vocabulary
snapshots collectively assert that this repo's architecture is
self-contained — every table, actor, ctx operation, intent
type, reason, outcome, EVENT_TYPES entry, and locked vocabulary
value originates inside this repo.

## Independence statement

The Maddie / GNG companion is an independent companion AI work.
It does not require any external canon to read, build, run, or
audit. The locked vocabulary, the constitutional rule chain
(approval ≠ authorization ≠ execution ≠ truth ≠ verification ≠
repair), the seven-stage governance chain, and the gauntlet
harness are all developed in-repo and documented in
`docs/governance/`.

If a developer or council member sees terminology in this
workspace that originates outside this repo's own documented
architecture, that terminology is **conversational drift**, not
inheritance.

## Treatment of external-project terminology

When external-project terms appear in conversation about this
repo — for example "U4CE", "Project Cairn", "Pete", "canonical
substrate", "lineage admission", "continuity surface",
"replay-free continuity", "substrate replay" — those terms
must be treated as **potential conversational contamination**
until classified.

The protocol:

1. **Stop.** Do not adopt the terminology as default framing.
2. **Classify** the term against this document's exclusion list
   and the contamination scanner's denylist:
   - generic English (e.g. `compete` containing the substring
     `Pete`) → harmless overlap;
   - intentional in-repo boundary documentation (e.g. the
     README's mention of Mattie / Sandy / MATTIE_SOUL as the
     reference system the template was extracted FROM, OR the
     contamination scanner's denylist itself) → no action,
     this IS the defense;
   - any other appearance → contamination, do not propagate
     into this repo's docs / prompts / code / migrations /
     tests / runbooks / package metadata / env vars.
3. **If unsure**, run the contamination scanner
   (`node scripts/ci/check-contamination.js`) and the boundary
   audit pattern documented in this directory before adopting
   the term.

This is a one-way isolation rule. External-project canon does
not flow into this repo; this repo's vocabulary does not flow
out into external-project context. Each project owns its own
architecture.

## Comparisons

Any comparison between this repo and another project is
permitted only inside an explicit, bounded audit (such as the
self-audit that produced this document). Comparisons must:

- be one-way: this repo audited against an explicit list of
  external terms; never the inverse.
- never pull external repo content into this repo.
- never import external project material as comparison input.
- be inspection-only — no file modifications during the audit.

Outside of a bounded audit, this repo's docs, prompts, code,
and conversations operate in this repo's own vocabulary only.

## Active mechanical defenses

These already exist; this document does not add to them. It
references them so the policy is co-located with the proof:

| Defense | Where | Enforces |
|---|---|---|
| Contamination scanner | `scripts/ci/check-contamination.js` | Denylist of `mattie`, `sandy`, `mattie_soul` substrings in `config/`, `scripts/setup/`, `scripts/validate/`, `src/`. Build fails if any leak in. |
| Log sentinel scan | `tests/runtime/log.test.js` | Asserts captured log lines never include the reference-system identifiers. |
| Companion configuration boundary doc | `docs/governance/companion-configuration-boundary.md` §C1 | Forbids hardcoded soul/persona constants like `MATTIE_SOUL`. |
| Substrate freeze (L22) | `tests/governance/adversarial.test.js` | Exactly 7 governance-staging tables, 8 Decision-gated actor factories, 19 ctx operations, 2 EVENT_TYPES. Any drift fails. |
| Vocabulary snapshots (C2, C3, C4, J37, K37) | `tests/governance/adversarial.test.js` | Locked counts for REASONS, INTENT_TYPES, OUTCOMES, EXECUTION_OUTCOME_TYPES, VERIFICATION_TYPES, VERIFICATION_RESULTS. Any external vocabulary import would surface as a count drift. |
| 14 boundary guards (incl. gauntlet) | `scripts/ci/check-*.js` | Import allowlists per `src/` layer; no module imports external paths; the gauntlet specifically cannot import from anything except `../governance`, `../actors`, `../review` public entries. |
| K22 / J22 / I23 / H22 / G13 zero-consumer canaries | `tests/governance/adversarial.test.js` | Each governance-staging table has zero consumer references outside its own writing path. External code cannot become a consumer without immediate canary failure. |

## What this document is NOT

- Not an architecture document. It adds no tables, actors, ctx
  operations, vocabulary, RLS policy, GRANT, EVENT_TYPES
  entry, migration, env var, or dependency.
- Not a substrate change. L22 substrate-freeze counts remain
  unchanged: 7 tables, 8 actors, 19 ctx ops, 2 EVENT_TYPES.
- Not a new canary. The contamination scanner and the existing
  L-series adversarial canaries already cover the mechanical
  enforcement.
- Not a substitute for the contamination scanner. The scanner
  is the mechanical defense; this document is the **stated
  policy** the scanner enforces.
- Not a one-time statement. It is the ongoing rule for how
  conversations and contributions about this repo must treat
  external-project terminology.

## Change control

If a future inspection-only GM expands or relaxes the
exclusion list, that GM must:

1. Update this document explicitly.
2. Update `scripts/ci/check-contamination.js` DENYLIST if a
   new term must be mechanically forbidden.
3. Update `docs/governance/baseline-ci.md` if the scanner's
   scoped roots shift.
4. Pair with a clear, recorded OQ approval block.

A silent change — adopting external vocabulary into this repo's
docs / prompts / code without updating this document — is the
failure mode this document exists to prevent.

## Cross-references

- `../README.md` — the repo-level statement of what the
  template is and is not.
- `../setup/template-boundaries.md` — what must never enter
  the master template.
- `companion-configuration-boundary.md` — the configuration
  contract (with the C1 forbidden-constant rule).
- `substrate-freeze.md` — the GM-30 substrate freeze.
- `baseline-ci.md` — the 14 boundary guards and the
  contamination scanner.
- `../../scripts/ci/check-contamination.js` — the mechanical
  enforcement.
- `../../tests/runtime/log.test.js` — the log sentinel-scan
  canary.
- `../../tests/governance/adversarial.test.js` — L22 (freeze),
  C2/C3/C4 (vocabulary), K22 (zero-consumer), and the rest
  of the constitutional canary set.
