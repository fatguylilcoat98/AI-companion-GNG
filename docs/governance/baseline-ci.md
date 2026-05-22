# Baseline CI

Baseline governance-enforcement CI for the golden master template. It
runs on every pull request and on push to `main`. Every check is a
standard-library-only Node guard — no application code, no database, no
network.

## What CI enforces today

| Guard | Script | Enforces |
|---|---|---|
| Lint / format | `check-format.js` | Final newline, no trailing whitespace, and no focused tests (`.only(`) across the authored surface. |
| Migration discipline | `check-migrations.js` | Numbered `NNN_*.sql` migrations only; no duplicate numbers; no stray `.sql` outside approved locations. |
| Secret / env-file guard | `check-secrets.js` | No tracked `.env*` file except `.env.example`; `.env.example` holds blank placeholders only; no secret-shaped tokens (private-key blocks, provider key prefixes, AWS key ids, JSON web tokens) in tracked files. |
| No real-data guard | `check-no-real-data.js` | No data-export file types tracked anywhere; the `seed/` tree confined to `seed/demo/`. |
| No archived SQL guard | `check-no-archived-sql.js` | No `_archive` path anywhere — the master starts a clean migration chain. |

All five guards are **enforced** — a violation fails the build.

## What is scaffold / deferred

- **RLS / privacy contract suite.** The synthetic RLS / privacy contract
  (a synthetic schema, a test harness, and a test matrix) is the
  platform's binding privacy contract. It exists, already generic, in
  the reference system and is to be ported into `tests/rls-contract/` in
  a dedicated follow-up PR — porting and generalizing a large multi-file
  suite is its own independently reviewable unit and is kept out of this
  baseline-CI infrastructure PR. The `rls-contract` CI job is a
  **scaffold** until then: it reports status and passes. See
  `../../tests/rls-contract/README.md`.

## Limitations

- The **no real-data guard** enforces *structural* rules (file types,
  `seed/` layout). It cannot decide whether a particular value is
  "real" — a guard cannot read intent. That semantic boundary is
  enforced by `../setup/template-boundaries.md` and by review.
- The **secret guard** is pattern-based defense-in-depth. It is not a
  substitute for never handling real secrets in the master template.

## Running the guards locally

```sh
node scripts/ci/check-format.js
node scripts/ci/check-migrations.js
node scripts/ci/check-secrets.js
node scripts/ci/check-no-real-data.js
node scripts/ci/check-no-archived-sql.js
```

## Promotion criteria

When the RLS / privacy contract suite is ported into
`tests/rls-contract/`, the `rls-contract` job stops being a scaffold and
runs the suite. That port is the next governance-infrastructure step.
