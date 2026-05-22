# Companion Configuration Contract

**Applies to:** the companion platform — this master template and every
companion instance copied from it.
**Status:** the contract is fixed. The configuration *values* for a
given instance are a deployment-owner decision (see
`owner-decisions-template.md`).
**Depends on:** `companion-configuration-boundary.md` (the boundary this
contract makes machine-enforceable), `governance-vocabulary-lock.md`,
`source-of-truth-memory-policy.md`.

## Purpose

The GM-4 boundary (`companion-configuration-boundary.md`) defined, in
prose, what is platform-forever and what is companion-specific. This
document makes the companion-specific half **machine-enforceable**: it
records the JSON Schema artifact, the physical mapping to the database,
the validation modes, and the version/compatibility rules.

The schema itself is `config/companion.schema.json` — JSON Schema
**draft 2020-12**.

## 1. The schema artifact

- **One root schema file**, `config/companion.schema.json`, with
  internal `$defs` for reusable sub-schemas. The configuration surface
  is one small document; separate schema files would be premature.
- **Draft 2020-12** (owner decision OQ-4.5).
- `additionalProperties: false` at **every** object level — an unknown
  key is a validation failure, not an ignored extra.
- The schema describes **structure, enums, and keys only**. It cannot
  express the platform governance floor; that floor lives in code and in
  the database schema and is never configurable (see section 6).

## 2. Versioning and evolution

- `schema_version` is a `MAJOR.MINOR` string carried in the config file.
  The v1.0 schema pins it with `const: "1.0"`.
- It is **config-file metadata**. It is distinct from the numbered SQL
  migrations in `db/migrations/`.

| Change | Version bump | Compatibility |
|---|---|---|
| New optional field; new enum / vocabulary value that *widens* choice | **MINOR** | Backward-compatible — existing config still valid |
| New required field; removed or renamed field; removed enum value; tightened constraint | **MAJOR** | Breaking — existing config invalid, migration required |

A config at MINOR *n* validates against a schema at MINOR *m ≥ n* of the
same MAJOR. A different MAJOR, or a config MINOR ahead of the code, is
not assumed compatible (see section 8). The schema is **locked** and
changes only through a reviewed change to the schema file and this
document.

## 3. Isomorphic shape and physical mapping

The config object is **isomorphic** with the GM-3 `companion_profile`
row (owner decision OQ-5.1): the four keys under `companion` map
one-to-one onto the four columns. There is no file-to-database
transform.

| Config path | Database location | Type |
|---|---|---|
| `companion.name` | `companion_profile.companion_name` | `TEXT` column |
| `companion.persona` | `companion_profile.persona` | `JSONB` column |
| `companion.voice` | `companion_profile.voice` | `JSONB` column |
| `companion.safety` | `companion_profile.safety` | `JSONB` column |
| `schema_version`, `_comment` | not persisted | config-file metadata (see section 9) |

The richer GM-4 sections nest inside these three JSONB columns:

| GM-4 section | Config path |
|---|---|
| topics | `companion.persona.topics` |
| terminology | `companion.persona.terminology` |
| reminders | `companion.persona.reminders` |
| emotional boundaries | `companion.safety.emotional_boundaries` |
| escalation | `companion.safety.escalation` |

GM-5 stays **JSONB-only** — no new columns, no migrations (owner
decision OQ-5.5). Promoting a constraint-bearing field (for example
`safety.posture`) to a real column with a database `CHECK` is a possible
**later** migration, only if needed; it is out of scope here.

The supported person is **not** in this contract. Their record lives in
`supported_person_profile` (`display_name`, `timezone`, `locale`,
`preferences`). Feature flags live in environment variables; onboarding
progress lives in `setup_state`. None of those are companion
configuration.

## 4. Two validation modes

One schema file, validated in two modes (owner decision OQ-5.3).

| Mode | Validates | Identity fields |
|---|---|---|
| **template** | structure, enums, keys | **may be blank** — used for `config/companion.example.json` in the master |
| **deployed** | structure, enums, keys | **must be non-empty** — used for the runtime config loaded from `companion_profile` |

`config/companion.schema.json` is the structural schema; it is the whole
of template mode. Deployed mode is that schema **plus** a non-empty
assertion on the identity fields below.

### Deployed-mode non-empty fields

- `companion.name`
- `companion.persona.tone`
- `companion.persona.speaking_style`
- `companion.voice.voice_id` — only when `companion.voice.enabled` is
  `true` (this one case is also enforced structurally, by the schema's
  `if/then`, so it holds in both modes).

Each field is marked in the schema with a `$comment` noting the
deployed-mode rule. The non-empty assertion itself is **not** in the
schema file — it is applied by the GM-6 validator (template/deployed
selectable) and by the runtime loader (always deployed).

## 5. Validation rules

| Rule | How it is expressed | Enforced by |
|---|---|---|
| Required keys | `required` on every object | schema |
| Conditional requirement | `voice.voice_id` non-empty when `voice.enabled` is `true` — schema `if/then` | schema |
| Enumerated values | `enum` / `const` | schema |
| **Additive-restrictive** | the floor is the **lowest enum member** — e.g. `safety.posture` is `["standard","heightened"]`, so a below-floor posture is unrepresentable; `comfort_role` excludes clinical roles | schema (membership) |
| Forbidden overrides | `additionalProperties: false` everywhere — a `governance`, `provenance`, `audit`, or `privacy` key cannot validate | schema |
| Controlled vocabularies | `topics.disallowed` / `topics.encouraged` items are the `topicTag` enum | schema |
| Safe defaults | `default` annotations | the **runtime loader applies** them — JSON Schema validators do not apply `default` |
| Blank-until-Setup | template vs deployed mode | GM-6 validator / runtime loader |
| `schema_version` | `const: "1.0"` | schema |
| `_comment` | explicitly declared so `additionalProperties:false` permits it | schema |

`emotional_boundaries.escalation_on_distress` from the GM-4 draft is
**not** in the schema — see section 7.

## 6. What configuration cannot express

Configuration is **additive-restrictive only**: it may make a companion
more cautious, never less. No configuration source may weaken the
platform governance floor — provenance rules, audit requirements,
privacy defaults, the no-fabrication rule, medical and legal boundaries,
or user-data protections.

This is enforced two ways:

1. **`additionalProperties: false`** at every level means a key naming a
   governance, provenance, audit, or privacy control cannot even appear
   in a valid config — the override is structurally unexpressible.
2. **Enum design** places the platform floor at the lowest representable
   value, so "more restrictive" is the only direction config can move.

What the schema *cannot* catch — a generic-looking value that is
secretly an instance-specific assumption — is covered by the GM-6
contamination checks and by review (see `companion-configuration-boundary.md`,
section 8).

## 7. Distress escalation is platform floor

`escalation_on_distress` appeared in the GM-4 draft shape. It is
**removed from the companion schema** (owner decision OQ-5.2). Escalating
distress is **platform floor**: every companion instance escalates
distress according to the platform safety floor, and configuration may
not disable it.

Configuration *may* still express escalation **preferences** —
`safety.escalation.preferred_channel` and `safety.escalation.contact_order`
— because routing preference does not weaken the floor. What is gone is
any switch that could turn distress escalation off.

## 8. Compatibility

| Scenario | Behavior |
|---|---|
| **Setup Mode seeds config** | Setup reads `companion.example.json` as the shape and seed; the owner fills values; Setup writes each `companion.*` key into its `companion_profile` column. `setup_state` tracks step completion. |
| **Runtime loads config** | The runtime reads `companion_profile` (the sole runtime source — OQ-4.1), reassembles the `companion` object, validates it in **deployed** mode, and **fails closed** on an invalid or incomplete config. The example file is never read at runtime. |
| **Version match** | config `schema_version` MAJOR equals the code's MAJOR, and config MINOR ≤ code MINOR → load. |
| **Version mismatch** | different MAJOR, or config MINOR ahead of the code → **fail closed**; surface "configuration upgrade required" and route to Setup. Never silently coerce. |
| **Future schema change** | a MINOR change needs no migration — existing config still validates. A MAJOR change needs a documented config migration (a transform of the `companion_profile` JSONB, tracked as a `setup_state` step), kept distinct from SQL DDL migrations. |

The failure principle is unchanged from the boundary doc:
**fail closed, never fail open.** A misconfigured companion is inert,
not improvised.

## 9. `schema_version` and `_comment` persistence

`schema_version` and `_comment` are properties of the **config-file
artifact**, not columns of `companion_profile`. `_comment` is a human
note and is never persisted. `schema_version` is checked on the
file-load path (Setup seed / re-seed) against the running code's
expected version.

GM-5 adds no columns, so the config schema version is **not** persisted
on the database row. For a deployed instance the authoritative version
is the version the running code is built against. Persisting the version
onto the `companion_profile` row — to detect a stored-config / code
mismatch on the database side — is a **deferred item**, to be handled by
the later hybrid-column migration if one is made. It is recorded here so
the gap is explicit, not silent.

## Downstream

**GM-6** adds the configuration validator and a baseline-CI job that
runs `companion.schema.json` against `companion.example.json` in
template mode. GM-6 also owns extending the `check-format` guard to
cover `config/`. Application-code extraction follows GM-6.

## Cross-references

- `companion-configuration-boundary.md` — the boundary this contract
  enforces.
- `governance-vocabulary-lock.md`, `source-of-truth-memory-policy.md`
- `feature-flag-model.md`, `owner-decisions-template.md`
- `../../config/companion.schema.json`, `../../config/companion.example.json`

## Change control

Locked. Changes are made by a reviewed change to this file and to
`config/companion.schema.json` together, following the version-bump
rules in section 2.
