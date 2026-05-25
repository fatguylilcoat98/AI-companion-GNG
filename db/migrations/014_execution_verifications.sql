-- Plan: GM-29 — the execution-verification substrate. The seventh
-- persistence expansion since the process lock, following GM-23
-- through GM-28. The FIRST artifact in the chain that records
-- whether a reported outcome was independently CHECKED — and
-- deliberately stops short of saying whether the check was
-- correct, repaired anything, or had any operational consequence.
--
-- This migration creates governance_execution_verifications, the
-- substrate where a separate human admin records what they
-- VERIFIED about a recorded outcome. The substrate is bound by
-- the strictest constitutional discipline in the entire chain:
--
--   VERIFICATION ≠ RECONCILIATION ≠ REPAIR.
--   A verification row is epistemic, not authoritative.
--   `verified_consistent` does NOT establish truth — it records
--   that a verifier checked and what they observed was consistent
--   with the reported outcome.
--   `verification_inconclusive` does NOT mean "retry" or "escalate"
--   — it means "the verifier could not establish consistency."
--   A missing verification row is NOT a verification result.
--
-- Vocabulary discipline (per OQ-29.4 + OQ-29.11 + constitutional
-- addendum 4):
--
--   verification_type — 4 values naming the evidence channel:
--     - human_observation
--     - system_log_review
--     - database_state_check
--     - external_confirmation
--
--   verification_result — 3 values; the `verified_*` prefix is
--     constitutionally isolated to this table:
--     - verified_consistent
--     - verified_inconsistent
--     - verification_inconclusive
--
--   Deliberately EXCLUDED:
--     - verified_succeeded / verified_failed
--         (would smuggle truth claims via verification)
--     - verification_refused
--         (refusal-to-verify is a separate decision gate)
--     - automated_check
--         (automation-as-verifier is a separate decision gate)
--     - verified_repaired / verified_corrected / verified_fixed
--         (correction is a separate future ring; K24 mechanically
--          forbids these vocabulary fragments anywhere in the
--          ledger actor file)
--
--   No verification_basis column (per OQ-29.3(d) + constitutional
--   addendum 7). GM-29 stores governance metadata only — no
--   evidence payloads, no raw logs, no screenshots, no URLs, no
--   notes, no free-form verifier narratives. The basis question
--   is a separate decision gate with its own privacy + retention
--   contract.
--
-- Inert by design (per constitutional addendum 2):
--
--   - Append-only via BEFORE-UPDATE-OR-DELETE trigger.
--   - verified_by_role locked to 'admin' via CHECK.
--   - verification_type CHECK-locked to the 4-value vocab.
--   - verification_result CHECK-locked to the 3-value vocab.
--   - UNIQUE(execution_outcome_id) — each outcome has at most ONE
--     verification row (per OQ-29.2). Verifications are OPTIONAL
--     (per OQ-29.6); a missing row means "no verification recorded."
--   - BEFORE-INSERT trigger walks the 7-deep chain:
--       (a) outcome exists in same pilot
--       (b) verifier ≠ recorder (self-verification forbidden —
--           extends the adjacent-only separation-of-duties chain
--           one more stage, now 6 deep:
--             reviewer ≠ authorizer ≠ claimant ≠ attempter ≠ recorder ≠ verifier)
--       (c) the chain verification → outcome → attempt → claim →
--           authorization → review_decision must resolve to
--           review_outcome = 'approved' (defense in depth —
--           impossible-by-design today since review_decisions are
--           append-only, but cheap to assert).
--   - No UPDATE / DELETE grants for any role.
--   - SELECT visibility narrowed to admin (no proposer / reviewer
--     / authorizer / claimant / attempter / recorder / verifier-
--     as-non-admin / family / caregiver / runtime).
--   - lylo_runtime / lylo_setup have NO access.
--   - NO consumer of governance_execution_verifications anywhere
--     in src/ — K22 static-scan canary mechanically enforces.
--   - NO operational, retry, reconciliation, rollback, or repair
--     vocabulary in the actor file — K24 mechanically enforces
--     (22-word forbidden list).
--
-- See docs/governance/execution-verification-runtime-boundary.md
-- for the full contract — especially "What this is NOT",
-- "What remains unresolved", "Verification is not reconciliation",
-- and "Verification does not execute or repair" sections (K27
-- doc-presence canary enforces their continued presence).

-- ---------------------------------------------------------------------
-- governance_execution_verifications — the new append-only artifact.
-- ---------------------------------------------------------------------

CREATE TABLE governance_execution_verifications (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id        UUID NOT NULL REFERENCES pilot_instances(id),
  execution_outcome_id     UUID NOT NULL,
  verified_by_user_id      UUID NOT NULL,
  verified_by_role         TEXT NOT NULL
    CHECK (verified_by_role = 'admin'),
  verification_type        TEXT NOT NULL
    CHECK (verification_type IN (
      'human_observation',
      'system_log_review',
      'database_state_check',
      'external_confirmation'
    )),
  verification_result      TEXT NOT NULL
    CHECK (verification_result IN (
      'verified_consistent',
      'verified_inconsistent',
      'verification_inconclusive'
    )),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Each outcome has at most one verification row.
  UNIQUE (execution_outcome_id),
  -- Composite uniqueness so a future GM can compose-FK to
  -- (pilot_instance_id, id).
  UNIQUE (pilot_instance_id, id),
  -- Defense in depth: alongside RLS WITH CHECK, the composite FKs
  -- enforce same-pilot verifier AND same-pilot outcome.
  FOREIGN KEY (pilot_instance_id, verified_by_user_id)
    REFERENCES users (pilot_instance_id, id),
  FOREIGN KEY (pilot_instance_id, execution_outcome_id)
    REFERENCES governance_execution_outcomes (pilot_instance_id, id)
);

-- ---------------------------------------------------------------------
-- Append-only trigger. Mirrors the GM-23/24/25/26/27/28 pattern.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_governance_execution_verifications_append_only() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'governance_execution_verifications is append-only; % is not permitted', TG_OP;
END $$;

DROP TRIGGER IF EXISTS governance_execution_verifications_append_only ON governance_execution_verifications;
CREATE TRIGGER governance_execution_verifications_append_only
  BEFORE UPDATE OR DELETE ON governance_execution_verifications
  FOR EACH ROW EXECUTE FUNCTION trg_governance_execution_verifications_append_only();

-- ---------------------------------------------------------------------
-- BEFORE-INSERT preconditions trigger.
--
-- Walks the 7-deep chain verification → outcome → attempt → claim
-- → authorization → review_decision and enforces three invariants.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_governance_execution_verifications_preconditions() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  o_recorder      UUID;
  o_attempt_id    UUID;
  a_claim_id      UUID;
  d_outcome       TEXT;
BEGIN
  -- (a) Look up the referenced outcome.
  SELECT recorded_by_user_id, execution_attempt_id
    INTO o_recorder, o_attempt_id
    FROM governance_execution_outcomes
   WHERE id = NEW.execution_outcome_id
     AND pilot_instance_id = NEW.pilot_instance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'governance_execution_verifications: outcome % not found in pilot %',
      NEW.execution_outcome_id, NEW.pilot_instance_id;
  END IF;
  -- (b) Self-verification prohibition (6th separation-of-duties stage).
  IF o_recorder = NEW.verified_by_user_id THEN
    RAISE EXCEPTION
      'governance_execution_verifications: verifier % cannot be the outcome recorder (self-verification forbidden)',
      NEW.verified_by_user_id;
  END IF;
  -- (c) Chain walk: outcome → attempt → claim → authorization → review_decision.
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
    JOIN governance_execution_attempts t
      ON t.execution_claim_id = c.id
     AND t.pilot_instance_id  = c.pilot_instance_id
   WHERE t.id = o_attempt_id
     AND t.pilot_instance_id = NEW.pilot_instance_id;
  IF d_outcome IS NULL THEN
    RAISE EXCEPTION
      'governance_execution_verifications: chain walk to review_decision broken for outcome %',
      NEW.execution_outcome_id;
  END IF;
  IF d_outcome <> 'approved' THEN
    RAISE EXCEPTION
      'governance_execution_verifications: underlying review is no longer approved (outcome=%)',
      d_outcome;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS governance_execution_verifications_preconditions ON governance_execution_verifications;
CREATE TRIGGER governance_execution_verifications_preconditions
  BEFORE INSERT ON governance_execution_verifications
  FOR EACH ROW EXECUTE FUNCTION trg_governance_execution_verifications_preconditions();

-- ---------------------------------------------------------------------
-- Table-level grants. lylo_app may SELECT and INSERT (the
-- execution-verification ledger actor records; admin inspection
-- reads through this role). lylo_admin may SELECT (operator audit).
-- No UPDATE / DELETE grants for any role. lylo_runtime /
-- lylo_setup have no access.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT ON governance_execution_verifications TO lylo_app;
GRANT SELECT          ON governance_execution_verifications TO lylo_admin;

-- ---------------------------------------------------------------------
-- Enable RLS. Default-deny + admin-only policies.
-- ---------------------------------------------------------------------

ALTER TABLE governance_execution_verifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS verification_insert_admin ON governance_execution_verifications;
CREATE POLICY verification_insert_admin ON governance_execution_verifications FOR INSERT
  WITH CHECK (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND verified_by_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND current_setting('app.user_role', true) = 'admin'
  );

DROP POLICY IF EXISTS verification_admin_select ON governance_execution_verifications;
CREATE POLICY verification_admin_select ON governance_execution_verifications FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND current_setting('app.user_role', true) = 'admin'
  );

-- Rollback:
-- DROP POLICY IF EXISTS verification_admin_select ON governance_execution_verifications;
-- DROP POLICY IF EXISTS verification_insert_admin ON governance_execution_verifications;
-- ALTER TABLE governance_execution_verifications DISABLE ROW LEVEL SECURITY;
-- REVOKE SELECT         ON governance_execution_verifications FROM lylo_admin;
-- REVOKE SELECT, INSERT ON governance_execution_verifications FROM lylo_app;
-- DROP TRIGGER IF EXISTS governance_execution_verifications_preconditions ON governance_execution_verifications;
-- DROP FUNCTION IF EXISTS trg_governance_execution_verifications_preconditions();
-- DROP TRIGGER IF EXISTS governance_execution_verifications_append_only ON governance_execution_verifications;
-- DROP FUNCTION IF EXISTS trg_governance_execution_verifications_append_only();
-- DROP TABLE IF EXISTS governance_execution_verifications;
