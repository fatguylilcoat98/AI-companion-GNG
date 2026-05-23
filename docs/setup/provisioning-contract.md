# Instance Provisioning Contract

**Applies to:** a copied instance database that needs to be brought to
the point where the runtime can reach `ready`.
**Tool:** `scripts/setup/provision-instance.js` — a one-shot, offline
CLI. There is no provisioning HTTP endpoint and no runtime mounting.
**Depends on:** `companion-config-contract.md` (GM-5 schema),
`runtime-boundary.md` (locked runtime contract).

## Purpose

The runtime reads four tables — `pilot_instances`, `users`,
`companion_profile`, `supported_person_profile` — to derive its state.
Before this script existed, an operator had to insert those rows by
hand, in the right order, with the right structural shape, before
boot would yield `ready`. The script automates that single act of
provisioning without expanding the runtime's read-only boundary or
adding any new endpoint.

## Minimum provisioning contract

In dependency order, all inside one transaction:

1. `pilot_instances` — exactly one row, supplying `org_name`.
2. `users` — one row with `role='senior'`, supplying `username`.
3. `companion_profile` — one row referencing the pilot, supplying
   `companion_name` and the full GM-5 structural shape for
   `persona`, `voice`, `safety` (with non-empty identity fields).
4. `supported_person_profile` — one row referencing the pilot and the
   senior, supplying `display_name` (and optional `timezone`,
   `locale`).

Paper-trail rows in `setup_state` are recorded alongside but do not
gate the runtime — the loader's validation is authoritative.

## Answers file

Path supplied with `--answers <path>` or the `ANSWERS_FILE` env var.
JSON shape, mirroring `config/answers.example.json`. The example file
ships in the master with **placeholder / blank identity fields only**;
a copied instance fills them once and **never commits the filled file
back to the master**.

Required non-empty fields:

- `pilot.org_name`
- `senior.username`
- `supported_person.display_name`
- `companion.name`
- `companion.persona.tone`
- `companion.persona.speaking_style`
- `companion.voice.voice_id` — only when `companion.voice.enabled` is
  `true` (enforced structurally by the GM-5 schema).

The `companion` sub-object must validate against
`config/companion.schema.json` in **deployed mode**. The script runs
this validation in memory before any database connection is opened.

## Idempotency

- **No `--force`** — if `pilot_instances` already has any row, the
  script logs `setup.idempotency.refused` and exits non-zero. Nothing
  is written.
- **`--force`** — the flag is recognized but **does not perform
  destructive reset / reseed in this version**. It logs
  `setup.force.not_implemented` and exits non-zero. Deterministic
  non-destructive re-provisioning is reserved for a future PR (see
  OQ-12.6).

To re-provision today: drop and recreate the database (or
`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`), re-apply
migrations, and run the script against the fresh instance.

## Validation flow

1. Parse `--answers` / `ANSWERS_FILE`. Missing or unreadable →
   `setup.answers.invalid`, exit 1.
2. Parse JSON. Malformed → `setup.answers.invalid`, exit 1.
3. Required non-empty check. Any blank → `setup.answers.invalid`,
   exit 1. **No database connection has been opened yet.**
4. Companion sub-object validated against `companion.schema.json` in
   deployed mode (using the GM-6 shared core). Failure →
   `setup.answers.invalid`, exit 1.
5. `DATABASE_URL` from env. Missing → `setup.env.error`, exit 1.
6. Database connection. Failure → `setup.db.error`, exit 1.
7. Idempotency check (see above).
8. `BEGIN`; insert the four rows in order, recording a paper-trail
   `setup_state` row per step; `COMMIT`.
9. `setup.complete` log line.

A failure between `BEGIN` and `COMMIT` results in `ROLLBACK`; no
partial state is persisted.

## Logged events

| Event | Level | When |
|---|---|---|
| `setup.start` | info | Script invoked; includes `force` boolean |
| `setup.answers.invalid` | error | Missing path, unreadable file, malformed JSON, blank required field, or companion-config validation failure |
| `setup.env.error` | error | `DATABASE_URL` missing |
| `setup.db.error` | error | DB connect or query failure (coarse `error_class`) |
| `setup.idempotency.refused` | error | A pilot already exists and `--force` was not passed |
| `setup.force.not_implemented` | error | `--force` was passed; destructive reseed is not implemented in this version |
| `setup.pilot.created` | info | `pilot_instances` row inserted; includes `pilot_instance_id` |
| `setup.senior.created` | info | Senior `users` row inserted |
| `setup.companion_profile.created` | info | `companion_profile` row inserted |
| `setup.supported_person.created` | info | `supported_person_profile` row inserted |
| `setup.setup_state.recorded` | info | Paper-trail step rows inserted |
| `setup.complete` | info | All inserts committed |
| `setup.fatal` | error | Unexpected error escaped `main()` |

All entries are JSON-line through a dedicated provisioning logger
(`scripts/setup/log.js`) that mirrors the shape of the runtime logger
(`src/runtime/log.js`). The two loggers are sibling modules with
identical output format so log aggregators see uniform entries from
both processes. The provisioning script has **no imports** into
`src/runtime/` or `src/db/`. Raw error messages and the connection
string are **never logged**.

## Offline-only constraint

The runtime is a **read-only** consumer of these tables. The
provisioning script writes them. Running the script while the runtime
is mounted against the same database risks read-side inconsistency.

**Provision while the runtime is down** (or before it is first
started). The runbook's failure-mode triage assumes this.

## Boundary preservation

- The runtime modules (`src/runtime/`, `src/db/`) remain read-only —
  the runtime-boundary guard's `INSERT`/`UPDATE`/`DELETE` ban still
  passes after this PR.
- The provisioning script lives in `scripts/setup/` — outside the
  runtime-boundary guard's `SCAN_ROOTS`. The script writes the same
  four tables the runtime reads, and is excluded from the guard by
  design.
- The contamination scanner **does** cover `scripts/setup/`, so
  reference-system identifiers (`Mattie`, `Sandy`, `MATTIE_SOUL`)
  cannot leak into the script.

## Relationship to the future Setup Mode wizard

A richer Setup Mode (iterative, resumable, possibly with a UI) is
still deferred. When it lands it may consume `setup_state` for
in-progress tracking and use the same answers shape. The contract in
this document defines the **minimum** provisioning surface; an
iterative wizard would be a superset.

## Cross-references

- `../governance/companion-config-contract.md` — the GM-5 schema the
  companion sub-object must satisfy.
- `../governance/runtime-boundary.md` — the runtime's read-only
  contract.
- `../deployment/operator-runbook.md` — how the operator triages
  `setup-incomplete` and runs the script.
- `instance-copy-workflow.md` — where this script fits in the copy
  flow (step 4).
- `../../config/answers.example.json` — the answers-file shape.
- `../../scripts/setup/provision-instance.js` — the script.

## Change control

The contract is locked. Adding a row to the provisioning surface, or
extending `--force` to a destructive path, requires a reviewed change
to this file and the script in the same PR.
