-- Plan: GM-28 — the reported-outcome substrate. The sixth
-- persistence expansion since the process lock, following GM-23
-- through GM-27. The FIRST artifact in the chain that records a
-- judgment about what happened — and walks an extremely fine
-- line to do it without making truth claims.
--
-- This migration creates governance_execution_outcomes, the
-- substrate where a human admin records what they OBSERVED about
-- an attempt's apparent state. The substrate is bound by the
-- strictest constitutional discipline in the entire chain:
--
--   AN OUTCOME ROW IS NOT TRUTH.
--   `reported_completed` ≠ `verified_completed`.
--   `reported_unknown` is active epistemic uncertainty, NOT a
--   default filler state.
--
-- Vocabulary discipline:
--
--   The 4 outcome_type values are observational, not evaluative.
--   Every value is mandatorily `reported_*` prefixed (J37
--   snapshot test enforces). Deliberately EXCLUDED:
--     - reported_succeeded / reported_failed
--         (would smuggle truth claims under the prefix)
--     - reported_partial
--         (creates a sliding scale; observational states are crisper)
--     - reported_verified
--         (verification is a SEPARATE future ring with its own
--          non-`reported_*` vocabulary)
--
-- Inert by design:
--
--   - Append-only via BEFORE-UPDATE-OR-DELETE trigger.
--   - recorded_by_role locked to 'admin' via CHECK.
--   - authorization_scope inherited from GM-25 (4-value vocab).
--   - execution_surface inherited from GM-26 (4-value vocab,
--     mandatory future_* prefix).
--   - outcome_type CHECK-locked to the 4-value reported_* vocab.
--   - UNIQUE(execution_attempt_id) — each attempt has at most
--     one outcome row. Outcomes are OPTIONAL (per OQ-28.12); a
--     missing row means "no outcome reported."
--   - BEFORE-INSERT trigger walks the 6-deep chain:
--       (a) attempt exists in same pilot
--       (b) authorization_scope on outcome equals attempt's scope
--       (c) execution_surface on outcome equals attempt's surface
--       (d) recorder ≠ attempter (self-recording forbidden —
--           extends the adjacent-only separation-of-duties chain
--           one more stage, now 5 deep:
--             reviewer ≠ authorizer ≠ claimant ≠ attempter ≠ recorder)
--       (e) the chain outcome → attempt → claim → authorization
--           → review_decision must resolve to review_outcome =
--           'approved' (defense in depth — impossible-by-design
--           today since review_decisions are append-only, but
--           cheap to assert).
--   - No UPDATE / DELETE grants for any role.
--   - SELECT visibility narrowed to admin (no proposer / reviewer
--     / authorizer / claimant / attempter / recorder-as-non-admin
--     / family / caregiver / runtime).
--   - lylo_runtime / lylo_setup have NO access.
--
-- See docs/governance/execution-outcome-runtime-boundary.md
-- for the full contract — especially "What this is NOT" and
-- "What remains unresolved" sections (J27 doc-presence canary
-- enforces their continued presence).

-- ---------------------------------------------------------------------
-- governance_execution_outcomes — the new append-only artifact.
-- ---------------------------------------------------------------------

CREATE TABLE governance_execution_outcomes (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id        UUID NOT NULL REFERENCES pilot_instances(id),
  execution_attempt_id     UUID NOT NULL,
  authorization_scope      TEXT NOT NULL
    CHECK (authorization_scope IN (
      'memory_candidate_admission',
      'future_external_action',
      'future_visibility_change',
      'future_vault_action'
    )),
  execution_surface        TEXT NOT NULL
    CHECK (execution_surface IN (
      'future_memory_admission_consumer',
      'future_external_action_consumer',
      'future_visibility_change_consumer',
      'future_vault_action_consumer'
    )),
  outcome_type             TEXT NOT NULL
    CHECK (outcome_type IN (
      'reported_completed',
      'reported_interrupted',
      'reported_abandoned',
      'reported_unknown'
    )),
  recorded_by_user_id      UUID NOT NULL,
  recorded_by_role         TEXT NOT NULL
    CHECK (recorded_by_role = 'admin'),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Each attempt has at most one outcome row.
  UNIQUE (execution_attempt_id),
  -- Composite uniqueness so a future GM can compose-FK to
  -- (pilot_instance_id, id).
  UNIQUE (pilot_instance_id, id),
  -- Defense in depth: alongside RLS WITH CHECK, the composite FKs
  -- enforce same-pilot recorder AND same-pilot attempt.
  FOREIGN KEY (pilot_instance_id, recorded_by_user_id)
    REFERENCES users (pilot_instance_id, id),
  FOREIGN KEY (pilot_instance_id, execution_attempt_id)
    REFERENCES governance_execution_attempts (pilot_instance_id, id)
);

-- ---------------------------------------------------------------------
-- Append-only trigger. Mirrors the GM-23/24/25/26/27 pattern.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_governance_execution_outcomes_append_only() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'governance_execution_outcomes is append-only; % is not permitted', TG_OP;
END $$;

DROP TRIGGER IF EXISTS governance_execution_outcomes_append_only ON governance_execution_outcomes;
CREATE TRIGGER governance_execution_outcomes_append_only
  BEFORE UPDATE OR DELETE ON governance_execution_outcomes
  FOR EACH ROW EXECUTE FUNCTION trg_governance_execution_outcomes_append_only();

-- ---------------------------------------------------------------------
-- BEFORE-INSERT preconditions trigger.
--
-- Walks the 6-deep chain outcome → attempt → claim → authorization
-- → review_decision and enforces five invariants.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_governance_execution_outcomes_preconditions() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  a_scope         TEXT;
  a_surface       TEXT;
  a_attempter     UUID;
  a_claim_id      UUID;
  c_auth_id       UUID;
  d_outcome       TEXT;
BEGIN
  -- (a) Look up the referenced attempt.
  SELECT authorization_scope, execution_surface, attempted_by_user_id, execution_claim_id
    INTO a_scope, a_surface, a_attempter, a_claim_id
    FROM governance_execution_attempts
   WHERE id = NEW.execution_attempt_id
     AND pilot_instance_id = NEW.pilot_instance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'governance_execution_outcomes: attempt % not found in pilot %',
      NEW.execution_attempt_id, NEW.pilot_instance_id;
  END IF;
  -- (b) authorization_scope equality with attempt.
  IF a_scope <> NEW.authorization_scope THEN
    RAISE EXCEPTION
      'governance_execution_outcomes: authorization_scope drift (outcome=% vs attempt=%)',
      NEW.authorization_scope, a_scope;
  END IF;
  -- (c) execution_surface equality with attempt.
  IF a_surface <> NEW.execution_surface THEN
    RAISE EXCEPTION
      'governance_execution_outcomes: execution_surface drift (outcome=% vs attempt=%)',
      NEW.execution_surface, a_surface;
  END IF;
  -- (d) Self-recording prohibition (5th separation-of-duties stage).
  IF a_attempter = NEW.recorded_by_user_id THEN
    RAISE EXCEPTION
      'governance_execution_outcomes: recorder % cannot be the attempter (self-recording forbidden)',
      NEW.recorded_by_user_id;
  END IF;
  -- (e) Chain walk: attempt → claim → authorization → review_decision.
  -- The underlying review must still be 'approved'. Impossible-by-
  -- design today (all upstream tables are append-only), but cheap
  -- to assert.
  SELECT d.review_outcome INTO d_outcome
    FROM governance_review_decisions d
    JOIN governance_execution_authorizations a
      ON a.review_decision_id = d.id
     AND a.pilot_instance_id  = d.pilot_instance_id
    JOIN governance_execution_claims c
      ON c.execution_authorization_id = a.id
     AND c.pilot_instance_id          = a.pilot_instance_id
   WHERE c.id = a_claim_id
     AND c.pilot_instance_id = NEW.pilot_instance_id;
  IF d_outcome IS NULL THEN
    RAISE EXCEPTION
      'governance_execution_outcomes: chain walk to review_decision broken for attempt %',
      NEW.execution_attempt_id;
  END IF;
  IF d_outcome <> 'approved' THEN
    RAISE EXCEPTION
      'governance_execution_outcomes: underlying review is no longer approved (outcome=%)',
      d_outcome;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS governance_execution_outcomes_preconditions ON governance_execution_outcomes;
CREATE TRIGGER governance_execution_outcomes_preconditions
  BEFORE INSERT ON governance_execution_outcomes
  FOR EACH ROW EXECUTE FUNCTION trg_governance_execution_outcomes_preconditions();

-- ---------------------------------------------------------------------
-- Table-level grants. lylo_app may SELECT and INSERT (the
-- execution-outcome ledger actor records; admin inspection reads
-- through this role). lylo_admin may SELECT (operator audit).
-- No UPDATE / DELETE grants for any role. lylo_runtime /
-- lylo_setup have no access.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT ON governance_execution_outcomes TO lylo_app;
GRANT SELECT          ON governance_execution_outcomes TO lylo_admin;

-- ---------------------------------------------------------------------
-- Enable RLS. Default-deny + admin-only policies.
-- ---------------------------------------------------------------------

ALTER TABLE governance_execution_outcomes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outcome_insert_admin ON governance_execution_outcomes;
CREATE POLICY outcome_insert_admin ON governance_execution_outcomes FOR INSERT
  WITH CHECK (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND recorded_by_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND current_setting('app.user_role', true) = 'admin'
  );

DROP POLICY IF EXISTS outcome_admin_select ON governance_execution_outcomes;
CREATE POLICY outcome_admin_select ON governance_execution_outcomes FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND current_setting('app.user_role', true) = 'admin'
  );

-- Rollback:
-- DROP POLICY IF EXISTS outcome_admin_select ON governance_execution_outcomes;
-- DROP POLICY IF EXISTS outcome_insert_admin ON governance_execution_outcomes;
-- ALTER TABLE governance_execution_outcomes DISABLE ROW LEVEL SECURITY;
-- REVOKE SELECT         ON governance_execution_outcomes FROM lylo_admin;
-- REVOKE SELECT, INSERT ON governance_execution_outcomes FROM lylo_app;
-- DROP TRIGGER IF EXISTS governance_execution_outcomes_preconditions ON governance_execution_outcomes;
-- DROP FUNCTION IF EXISTS trg_governance_execution_outcomes_preconditions();
-- DROP TRIGGER IF EXISTS governance_execution_outcomes_append_only ON governance_execution_outcomes;
-- DROP FUNCTION IF EXISTS trg_governance_execution_outcomes_append_only();
-- DROP TABLE IF EXISTS governance_execution_outcomes;
