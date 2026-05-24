-- Plan: GM-26 — the execution-claim substrate. The fourth
-- persistence expansion since the process lock, following GM-23's
-- review queue, GM-24's review-decision substrate, and GM-25's
-- execution-authorization substrate.
--
-- This migration creates governance_execution_claims, a durable,
-- append-only record that an admin (different from the one who
-- authorized) has explicitly claimed an authorization exactly
-- once for a specific future execution surface. The substrate is
-- intentionally inert:
--
--   - Append-only via BEFORE-UPDATE-OR-DELETE trigger.
--   - claimed_by_role locked to 'admin' via CHECK.
--   - authorization_scope locked to the 4-value GM-25 vocabulary.
--   - execution_surface locked to a NEW 4-value GM-26 vocabulary,
--     with mandatory `future_*` prefix on every value
--     (constitutional discipline: no consumer exists yet; the
--     prefix puts "future" into the data itself).
--   - UNIQUE(execution_authorization_id) — each authorization
--     consumed at most once. The replay-prevention mechanism.
--   - BEFORE-INSERT trigger walks the chain:
--       (a) authorization exists in same pilot
--       (b) authorization_scope on the claim must equal the
--           authorization's scope (drift detection)
--       (c) claimant ≠ authorizer (self-claim forbidden — extends
--           the adjacent-only separation-of-duties chain one
--           more stage)
--       (d) execution_surface must fit authorization_scope, per
--           a hardcoded 4-pair mapping
--       (e) the underlying review_decision must still be
--           'approved' (defense in depth — impossible-by-design
--           today since review_decisions are append-only, but the
--           cheap chain walk catches any future drift in the
--           review-decision layer)
--   - No UPDATE / DELETE grants for any role.
--   - SELECT visibility narrowed to admin (no proposer / reviewer
--     / authorizer-as-non-admin / claimant / family / caregiver /
--     runtime visibility).
--   - lylo_runtime / lylo_setup have NO access to this table.
--
-- Constitutional rule:
--   Claim is NOT execution.
--   Claim is NOT dispatch.
--   Claim is NOT completion.
--   Claim is NOT success.
--   Claim only means: this authorization has now been consumed
--   exactly once.
--
-- Authorization without single-consumption semantics is replayable
-- authority. GM-26 makes replay prevention structural BEFORE
-- execution exists.
--
-- See docs/governance/execution-claim-runtime-boundary.md.

-- ---------------------------------------------------------------------
-- governance_execution_claims — the new append-only artifact.
-- ---------------------------------------------------------------------

CREATE TABLE governance_execution_claims (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id           UUID NOT NULL REFERENCES pilot_instances(id),
  execution_authorization_id  UUID NOT NULL,
  authorization_scope         TEXT NOT NULL
    CHECK (authorization_scope IN (
      'memory_candidate_admission',
      'future_external_action',
      'future_visibility_change',
      'future_vault_action'
    )),
  execution_surface           TEXT NOT NULL
    CHECK (execution_surface IN (
      'future_memory_admission_consumer',
      'future_external_action_consumer',
      'future_visibility_change_consumer',
      'future_vault_action_consumer'
    )),
  claimed_by_user_id          UUID NOT NULL,
  claimed_by_role             TEXT NOT NULL
    CHECK (claimed_by_role = 'admin'),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Each authorization may be claimed at most once.
  UNIQUE (execution_authorization_id),
  -- Composite uniqueness so a future GM can compose-FK to
  -- (pilot_instance_id, id).
  UNIQUE (pilot_instance_id, id),
  -- Defense in depth: alongside RLS WITH CHECK, the composite FKs
  -- enforce same-pilot claimant AND same-pilot authorization.
  FOREIGN KEY (pilot_instance_id, claimed_by_user_id)
    REFERENCES users (pilot_instance_id, id),
  FOREIGN KEY (pilot_instance_id, execution_authorization_id)
    REFERENCES governance_execution_authorizations (pilot_instance_id, id)
);

-- ---------------------------------------------------------------------
-- Append-only trigger. Mirrors the GM-23/24/25 pattern.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_governance_execution_claims_append_only() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'governance_execution_claims is append-only; % is not permitted', TG_OP;
END $$;

DROP TRIGGER IF EXISTS governance_execution_claims_append_only ON governance_execution_claims;
CREATE TRIGGER governance_execution_claims_append_only
  BEFORE UPDATE OR DELETE ON governance_execution_claims
  FOR EACH ROW EXECUTE FUNCTION trg_governance_execution_claims_append_only();

-- ---------------------------------------------------------------------
-- BEFORE-INSERT preconditions trigger.
--
-- Walks the chain claim → authorization → review_decision and
-- enforces five invariants:
--   (a) authorization exists in same pilot
--   (b) authorization_scope equality
--   (c) claimant ≠ authorizer (self-claim forbidden)
--   (d) execution_surface fits authorization_scope
--   (e) underlying review_decision.review_outcome = 'approved'
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_governance_execution_claims_preconditions() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  auth_scope        TEXT;
  auth_authorizer   UUID;
  auth_review_id    UUID;
  d_outcome         TEXT;
  surface_ok        BOOLEAN;
BEGIN
  -- (a) Look up the referenced authorization.
  SELECT authorization_scope, authorized_by_user_id, review_decision_id
    INTO auth_scope, auth_authorizer, auth_review_id
    FROM governance_execution_authorizations
   WHERE id = NEW.execution_authorization_id
     AND pilot_instance_id = NEW.pilot_instance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'governance_execution_claims: authorization % not found in pilot %',
      NEW.execution_authorization_id, NEW.pilot_instance_id;
  END IF;
  -- (b) authorization_scope must equal the authorization's scope.
  IF auth_scope <> NEW.authorization_scope THEN
    RAISE EXCEPTION
      'governance_execution_claims: authorization_scope drift (claim=% vs authorization=%)',
      NEW.authorization_scope, auth_scope;
  END IF;
  -- (c) Self-claim prohibition.
  IF auth_authorizer = NEW.claimed_by_user_id THEN
    RAISE EXCEPTION
      'governance_execution_claims: claimant % cannot be the authorizer (self-claim forbidden)',
      NEW.claimed_by_user_id;
  END IF;
  -- (d) execution_surface must fit authorization_scope. The
  -- mapping is 1:1 — each scope has exactly one valid surface.
  surface_ok := CASE
    WHEN NEW.authorization_scope = 'memory_candidate_admission'
         AND NEW.execution_surface = 'future_memory_admission_consumer'   THEN TRUE
    WHEN NEW.authorization_scope = 'future_external_action'
         AND NEW.execution_surface = 'future_external_action_consumer'    THEN TRUE
    WHEN NEW.authorization_scope = 'future_visibility_change'
         AND NEW.execution_surface = 'future_visibility_change_consumer'  THEN TRUE
    WHEN NEW.authorization_scope = 'future_vault_action'
         AND NEW.execution_surface = 'future_vault_action_consumer'       THEN TRUE
    ELSE FALSE
  END;
  IF NOT surface_ok THEN
    RAISE EXCEPTION
      'governance_execution_claims: execution_surface % does not fit authorization_scope %',
      NEW.execution_surface, NEW.authorization_scope;
  END IF;
  -- (e) Defense in depth: walk to the review_decision and confirm
  -- the underlying review is still 'approved'. Impossible-by-
  -- design today (review_decisions are append-only), but cheap
  -- to assert.
  SELECT review_outcome INTO d_outcome
    FROM governance_review_decisions
   WHERE id = auth_review_id
     AND pilot_instance_id = NEW.pilot_instance_id;
  IF d_outcome IS NULL THEN
    RAISE EXCEPTION
      'governance_execution_claims: review_decision for authorization % not found',
      NEW.execution_authorization_id;
  END IF;
  IF d_outcome <> 'approved' THEN
    RAISE EXCEPTION
      'governance_execution_claims: underlying review is no longer approved (outcome=%)',
      d_outcome;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS governance_execution_claims_preconditions ON governance_execution_claims;
CREATE TRIGGER governance_execution_claims_preconditions
  BEFORE INSERT ON governance_execution_claims
  FOR EACH ROW EXECUTE FUNCTION trg_governance_execution_claims_preconditions();

-- ---------------------------------------------------------------------
-- Table-level grants. lylo_app may SELECT and INSERT (the
-- execution-claim ledger actor records claims; admin inspection
-- reads through this role). lylo_admin may SELECT (operator
-- audit). No UPDATE / DELETE grants for any role. lylo_runtime /
-- lylo_setup have no access.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT ON governance_execution_claims TO lylo_app;
GRANT SELECT          ON governance_execution_claims TO lylo_admin;

-- ---------------------------------------------------------------------
-- Enable RLS. Default-deny + admin-only policies.
-- ---------------------------------------------------------------------

ALTER TABLE governance_execution_claims ENABLE ROW LEVEL SECURITY;

-- INSERT: tenant + no impersonation + admin only.
DROP POLICY IF EXISTS claim_insert_admin ON governance_execution_claims;
CREATE POLICY claim_insert_admin ON governance_execution_claims FOR INSERT
  WITH CHECK (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND claimed_by_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND current_setting('app.user_role', true) = 'admin'
  );

-- SELECT: admin in the same pilot sees all claims. No proposer /
-- reviewer / authorizer-as-non-admin / claimant / family /
-- caregiver visibility. Claims are admin-only governance
-- metadata.
DROP POLICY IF EXISTS claim_admin_select ON governance_execution_claims;
CREATE POLICY claim_admin_select ON governance_execution_claims FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND current_setting('app.user_role', true) = 'admin'
  );

-- Rollback:
-- DROP POLICY IF EXISTS claim_admin_select ON governance_execution_claims;
-- DROP POLICY IF EXISTS claim_insert_admin ON governance_execution_claims;
-- ALTER TABLE governance_execution_claims DISABLE ROW LEVEL SECURITY;
-- REVOKE SELECT         ON governance_execution_claims FROM lylo_admin;
-- REVOKE SELECT, INSERT ON governance_execution_claims FROM lylo_app;
-- DROP TRIGGER IF EXISTS governance_execution_claims_preconditions ON governance_execution_claims;
-- DROP FUNCTION IF EXISTS trg_governance_execution_claims_preconditions();
-- DROP TRIGGER IF EXISTS governance_execution_claims_append_only ON governance_execution_claims;
-- DROP FUNCTION IF EXISTS trg_governance_execution_claims_append_only();
-- DROP TABLE IF EXISTS governance_execution_claims;
