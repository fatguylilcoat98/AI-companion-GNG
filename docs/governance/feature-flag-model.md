# Feature-Flag Model

**Applies to:** every companion instance copied from this master
template.
**Status:** the model is fixed; the exact flag names, defaults, and
rollout order for a given instance are a deployment-owner decision (see
`owner-decisions-template.md`).

## Purpose

A companion instance is rolled out in stages, not flipped on all at
once. This document defines the feature-flag model every instance uses
for safe, reversible rollout.

## The hierarchy

### Layer 1 — master runtime switch

A single master switch (illustratively `LYLO_SHELL_MODE`, an
environment variable, default `false`) governs whether the companion
runtime mounts at all.

- `false`: the companion runtime does not mount; new routes return 404;
  no memory tables are read or written. The instance is inert and safe.
- `true`: the companion runtime mounts; the companion profile loads;
  pilot-instance scoping is active.
- Flip-off rollback: set `false` and redeploy. With an additive-only
  schema, no data is destroyed.

### Layer 2 — RLS enforcement (independent)

`RLS_ENFORCED` (environment variable, default `false`) governs database
row-level-security **enforcement**. It is deliberately **independent**
of the Layer-1 switch: RLS is validated through a shadow period before
enforcement, and that flip must not be coupled to the runtime mount. A
valid state is: runtime mounted, RLS still in shadow.

### Layer 3 — capability sub-flags

Capability sub-flags gate individual features for staged rollout
*inside* an already-mounted runtime (illustratively
`SETUP_MODE_ENABLED`, `LEGACY_PROJECT_MODE_ENABLED`, `VOICE_ENABLED`).
Each defaults to `false`. When the Layer-1 switch is `false`, Layer-3
flags have no effect.

## Precedence rules

1. Layer-1 `false` => every Layer-3 flag is inert.
2. `RLS_ENFORCED` is evaluated independently and may be `false` while
   the runtime is mounted.
3. A Layer-3 flag set `true` while Layer-1 is `false` is a no-op, not an
   error.

## Per-instance configuration

The exact flag **names**, **defaults**, and **rollout order** for a
given instance are recorded by the deployment owner in that instance —
see `owner-decisions-template.md`. The master template ships the
*model* and safe defaults (every flag `false`); it never hard-codes one
instance's rollout state.

## Master-template rule

The master template ships all flags **off**. A copied instance never
inherits a "live" flag state from the template.

## Cross-references

- `governance-vocabulary-lock.md`, `source-of-truth-memory-policy.md`
- `owner-decisions-template.md`
- `../../.env.example` — the flag environment variables.
