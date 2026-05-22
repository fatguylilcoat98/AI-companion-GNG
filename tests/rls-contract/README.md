# RLS / privacy contract suite

This directory will hold the **synthetic RLS / privacy contract** for the
companion platform: a synthetic database schema, a test harness, and a
matrix of tests that verify row-level security, visibility, audit, and
compose-context behavior.

## Status — not yet ported

The contract suite exists, already generic, in the reference system. It
is **to be ported here in a dedicated follow-up PR**. Porting and
generalizing it — a large multi-file suite including a substantial
synthetic schema — is its own independently reviewable unit and is
deliberately kept out of the baseline-CI infrastructure PR.

When ported, the suite will:

- be **synthetic only** — a throwaway local database, fictional data, no
  real supported-person data, and no reference-system-specific language;
- be the binding contract the master's `db/migrations/` schema must
  satisfy;
- be run by the `rls-contract` job in
  `../../.github/workflows/baseline-ci.yml` (currently a scaffold — see
  `../../docs/governance/baseline-ci.md`).

Until then this directory is a placeholder.
