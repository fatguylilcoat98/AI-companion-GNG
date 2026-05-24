-- Plan: GM-27 — the execution-attempt substrate. The fifth
-- persistence expansion since the process lock, following GM-23
-- (review queue), GM-24 (review decisions), GM-25 (execution
-- authorizations), and GM-26 (execution claims).
--
-- This migration creates governance_execution_attempts, the FIRST
-- artifact in the entire chain that names "execution" as a thing
-- that could happen. It deliberately stops short of saying whether
-- anything actually DID happen. The substrate records ONLY:
--
--   "An admin (different from the claimant) began an execution
--    attempt against a claim, naming the same scope and surface
--    the claim named, against a still-approved chain."
--
-- Constitutional rule (the most important rule in the entire
-- chain so far):
--
--   ATTEMPT IS NOT OUTCOME.
--
-- An attempt row records only the beginning of an attempt. It
-- does NOT record:
--   - success
--   - failure
--   - completion
--   - interruption
--   - delivery
--   - dispatch
--   - finalization
--   - committed state (the DB-transaction sense of "committed"
--     belongs to the transaction layer, not to this artifact)
--   - verification
--   - truth
--
-- The substrate is intentionally inert:
--
--   - Append-only via BEFORE-UPDATE-OR-DELETE trigger.
--   - attempted_by_role locked to 'admin' via CHECK.
--   - authorization_scope inherited from GM-25 (4-value vocab).
--   - execution_surface inherited from GM-26 (4-value vocab,
--     mandatory `future_*` prefix).
--   - UNIQUE(execution_claim_id) — each claim gets exactly one
--     attempt. Multi-attempt / retry semantics are forbidden in
--     GM-27 (per OQ-27.2 / OQ-27.4).
--   - BEFORE-INSERT trigger walks the chain:
--       (a) claim exists in same pilot
--       (b) authorization_scope on the attempt must equal the
--           claim's scope
--       (c) execution_surface on the attempt must equal the
--           claim's surface
--       (d) attempter ≠ claimant (self-attempt forbidden —
--           extends the adjacent-only separation-of-duties chain
--           one more stage)
--       (e) the chain attempt → claim → authorization →
--           review_decision must resolve to review_outcome =
--           'approved' (defense in depth — impossible-by-design
--           today since review_decisions are append-only, but
--           the cheap chain walk catches any future drift in
--           the review-decision layer)
--   - No UPDATE / DELETE grants for any role.
--   - SELECT visibility narrowed to admin (no proposer / reviewer
--     / authorizer / claimant / attempter-as-non-admin / family /
--     caregiver / runtime visibility).
--   - lylo_runtime / lylo_setup have NO access to this table.
--
-- An attempt without an outcome row is a PHANTOM. GM-27 does
-- NOT resolve phantom-attempt semantics. The future-outcome GM
-- must decide:
--   - Is an attempt with no outcome treated as in-flight,
--     abandoned, or unknown?
--   - Are pre-outcome-GM rows treated as outcome-unknown forever?
--   - Is missing outcome itself an outcome?
-- See docs/governance/execution-attempt-runtime-boundary.md
-- "What remains unresolved" for the full enumeration.

-- ---------------------------------------------------------------------
-- governance_execution_attempts — the new append-only artifact.
-- ---------------------------------------------------------------------

CREATE TABLE governance_execution_attempts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id        UUID NOT NULL REFERENCES pilot_instances(id),
  execution_claim_id       UUID NOT NULL,
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
  attempted_by_user_id     UUID NOT NULL,
  attempted_by_role        TEXT NOT NULL
    CHECK (attempted_by_role = 'admin'),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Each claim may be attempted at most once. Multi-attempt /
  -- retry is forbidden in GM-27.
  UNIQUE (execution_claim_id),
  -- Composite uniqueness so a future GM can compose-FK to
  -- (pilot_instance_id, id).
  UNIQUE (pilot_instance_id, id),
  -- Defense in depth: alongside RLS WITH CHECK, the composite FKs
  -- enforce same-pilot attempter AND same-pilot claim.
  FOREIGN KEY (pilot_instance_id, attempted_by_user_id)
    REFERENCES users (pilot_instance_id, id),
  FOREIGN KEY (pilot_instance_id, execution_claim_id)
    REFERENCES governance_execution_claims (pilot_instance_id, id)
);

-- ---------------------------------------------------------------------
-- Append-only trigger. Mirrors the GM-23/24/25/26 pattern.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_governance_execution_attempts_append_only() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'governance_execution_attempts is append-only; % is not permitted', TG_OP;
END $$;

DROP TRIGGER IF EXISTS governance_execution_attempts_append_only ON governance_execution_attempts;
CREATE TRIGGER governance_execution_attempts_append_only
  BEFORE UPDATE OR DELETE ON governance_execution_attempts
  FOR EACH ROW EXECUTE FUNCTION trg_governance_execution_attempts_append_only();

-- ---------------------------------------------------------------------
-- BEFORE-INSERT preconditions trigger.
--
-- Walks the 5-deep chain attempt → claim → authorization →
-- review_decision and enforces five invariants.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_governance_execution_attempts_preconditions() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  c_scope         TEXT;
  c_surface       TEXT;
  c_claimant      UUID;
  c_auth_id       UUID;
  d_outcome       TEXT;
BEGIN
  -- (a) Look up the referenced claim.
  SELECT authorization_scope, execution_surface, claimed_by_user_id, execution_authorization_id
    INTO c_scope, c_surface, c_claimant, c_auth_id
    FROM governance_execution_claims
   WHERE id = NEW.execution_claim_id
     AND pilot_instance_id = NEW.pilot_instance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'governance_execution_attempts: claim % not found in pilot %',
      NEW.execution_claim_id, NEW.pilot_instance_id;
  END IF;
  -- (b) authorization_scope equality with claim.
  IF c_scope <> NEW.authorization_scope THEN
    RAISE EXCEPTION
      'governance_execution_attempts: authorization_scope drift (attempt=% vs claim=%)',
      NEW.authorization_scope, c_scope;
  END IF;
  -- (c) execution_surface equality with claim.
  IF c_surface <> NEW.execution_surface THEN
    RAISE EXCEPTION
      'governance_execution_attempts: execution_surface drift (attempt=% vs claim=%)',
      NEW.execution_surface, c_surface;
  END IF;
  -- (d) Self-attempt prohibition.
  IF c_claimant = NEW.attempted_by_user_id THEN
    RAISE EXCEPTION
      'governance_execution_attempts: attempter % cannot be the claimant (self-attempt forbidden)',
      NEW.attempted_by_user_id;
  END IF;
  -- (e) Chain walk: claim → authorization → review_decision.
  -- The underlying review must still be 'approved'. Impossible-by-
  -- design today (review_decisions are append-only), but cheap
  -- to assert and defends against any future drift in the
  -- review-decision layer.
  SELECT d.review_outcome INTO d_outcome
    FROM governance_review_decisions d
    JOIN governance_execution_authorizations a
      ON a.review_decision_id = d.id
     AND a.pilot_instance_id  = d.pilot_instance_id
   WHERE a.id = c_auth_id
     AND a.pilot_instance_id = NEW.pilot_instance_id;
  IF d_outcome IS NULL THEN
    RAISE EXCEPTION
      'governance_execution_attempts: chain walk to review_decision broken for claim %',
      NEW.execution_claim_id;
  END IF;
  IF d_outcome <> 'approved' THEN
    RAISE EXCEPTION
      'governance_execution_attempts: underlying review is no longer approved (outcome=%)',
      d_outcome;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS governance_execution_attempts_preconditions ON governance_execution_attempts;
CREATE TRIGGER governance_execution_attempts_preconditions
  BEFORE INSERT ON governance_execution_attempts
  FOR EACH ROW EXECUTE FUNCTION trg_governance_execution_attempts_preconditions();

-- ---------------------------------------------------------------------
-- Table-level grants. lylo_app may SELECT and INSERT (the
-- execution-attempt ledger actor records attempts; admin
-- inspection reads through this role). lylo_admin may SELECT
-- (operator audit). No UPDATE / DELETE grants for any role.
-- lylo_runtime / lylo_setup have no access.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT ON governance_execution_attempts TO lylo_app;
GRANT SELECT          ON governance_execution_attempts TO lylo_admin;

-- ---------------------------------------------------------------------
-- Enable RLS. Default-deny + admin-only policies.
-- ---------------------------------------------------------------------

ALTER TABLE governance_execution_attempts ENABLE ROW LEVEL SECURITY;

-- INSERT: tenant + no impersonation + admin only.
DROP POLICY IF EXISTS attempt_insert_admin ON governance_execution_attempts;
CREATE POLICY attempt_insert_admin ON governance_execution_attempts FOR INSERT
  WITH CHECK (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND attempted_by_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND current_setting('app.user_role', true) = 'admin'
  );

-- SELECT: admin in the same pilot sees all attempts. No proposer
-- / reviewer / authorizer / claimant / attempter-as-non-admin /
-- family / caregiver visibility.
DROP POLICY IF EXISTS attempt_admin_select ON governance_execution_attempts;
CREATE POLICY attempt_admin_select ON governance_execution_attempts FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND current_setting('app.user_role', true) = 'admin'
  );

-- Rollback:
-- DROP POLICY IF EXISTS attempt_admin_select ON governance_execution_attempts;
-- DROP POLICY IF EXISTS attempt_insert_admin ON governance_execution_attempts;
-- ALTER TABLE governance_execution_attempts DISABLE ROW LEVEL SECURITY;
-- REVOKE SELECT         ON governance_execution_attempts FROM lylo_admin;
-- REVOKE SELECT, INSERT ON governance_execution_attempts FROM lylo_app;
-- DROP TRIGGER IF EXISTS governance_execution_attempts_preconditions ON governance_execution_attempts;
-- DROP FUNCTION IF EXISTS trg_governance_execution_attempts_preconditions();
-- DROP TRIGGER IF EXISTS governance_execution_attempts_append_only ON governance_execution_attempts;
-- DROP FUNCTION IF EXISTS trg_governance_execution_attempts_append_only();
-- DROP TABLE IF EXISTS governance_execution_attempts;
