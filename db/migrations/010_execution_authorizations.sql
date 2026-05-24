-- Plan: GM-25 — the execution-authorization substrate. The third
-- persistence expansion since the process lock, following GM-23's
-- review queue and GM-24's review-decision substrate.
--
-- This migration creates governance_execution_authorizations, a
-- durable, append-only record that an admin (different from the
-- one who reviewed the item) has explicitly authorized an approved
-- review_decision for eventual execution. The substrate is
-- intentionally inert:
--
--   - Append-only via a BEFORE-UPDATE-OR-DELETE trigger.
--   - authorized_by_role locked to 'admin' via CHECK.
--   - authorization_scope locked to a 4-value vocabulary.
--   - authorization_reason locked to a 1-value vocabulary
--     (admin_explicit_authorization).
--   - UNIQUE(review_decision_id) — each review_decision may be
--     authorized at most once. Replay prevention.
--   - BEFORE-INSERT trigger walks the chain:
--       (a) referenced review_decision exists in same pilot
--       (b) review_outcome must = 'approved'
--           (cannot authorize a rejected review)
--       (c) authorizer ≠ reviewer (self-authorization forbidden)
--       (d) authorization_scope must match the underlying queue
--           item's decision_intent_type, per a hardcoded mapping
--   - No UPDATE / DELETE grants for any role.
--   - SELECT visibility narrowed to admin (no proposer / reviewer
--     / authorizer / family / caregiver / runtime visibility).
--   - lylo_runtime / lylo_setup have NO access to this table.
--
-- Constitutional rule (added in GM-24, enforced again here):
--   Approval is NOT authorization. Authorization is NOT execution.
--   An authorization row is NOT an execution signal.
-- No production code in GM-25 consumes governance_execution_authorizations
-- operationally. A future execution capability requires its own
-- decision gate, its own boundary guard, and its own adversarial
-- review.
--
-- See docs/governance/execution-authorization-runtime-boundary.md.
--
-- Idempotency: the trigger functions use CREATE OR REPLACE; the
-- triggers and policies use DROP IF EXISTS + CREATE; the table
-- is created without IF NOT EXISTS because re-apply against an
-- existing public schema is not supported (matches the project-
-- wide DROP SCHEMA public CASCADE pattern used by the integration
-- and rls-contract suites).

-- ---------------------------------------------------------------------
-- governance_execution_authorizations — the new append-only artifact.
-- ---------------------------------------------------------------------

CREATE TABLE governance_execution_authorizations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id        UUID NOT NULL REFERENCES pilot_instances(id),
  review_decision_id       UUID NOT NULL,
  authorized_by_user_id    UUID NOT NULL,
  authorized_by_role       TEXT NOT NULL
    CHECK (authorized_by_role = 'admin'),
  authorization_scope      TEXT NOT NULL
    CHECK (authorization_scope IN (
      'memory_candidate_admission',
      'future_external_action',
      'future_visibility_change',
      'future_vault_action'
    )),
  authorization_reason     TEXT NOT NULL
    CHECK (authorization_reason IN (
      'admin_explicit_authorization'
    )),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Each review_decision authorized at most once.
  UNIQUE (review_decision_id),
  -- Composite uniqueness so a future GM can compose-FK to
  -- (pilot_instance_id, id) — same pattern as users / queue /
  -- review_decisions above.
  UNIQUE (pilot_instance_id, id),
  -- Defense in depth: alongside RLS WITH CHECK, the composite FKs
  -- enforce same-pilot authorizer AND same-pilot review_decision.
  FOREIGN KEY (pilot_instance_id, authorized_by_user_id)
    REFERENCES users (pilot_instance_id, id),
  FOREIGN KEY (pilot_instance_id, review_decision_id)
    REFERENCES governance_review_decisions (pilot_instance_id, id)
);

-- ---------------------------------------------------------------------
-- Append-only trigger. Mirrors the GM-23 / GM-24 pattern.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_governance_execution_authorizations_append_only() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'governance_execution_authorizations is append-only; % is not permitted', TG_OP;
END $$;

DROP TRIGGER IF EXISTS governance_execution_authorizations_append_only ON governance_execution_authorizations;
CREATE TRIGGER governance_execution_authorizations_append_only
  BEFORE UPDATE OR DELETE ON governance_execution_authorizations
  FOR EACH ROW EXECUTE FUNCTION trg_governance_execution_authorizations_append_only();

-- ---------------------------------------------------------------------
-- BEFORE-INSERT preconditions trigger.
--
-- Walks the chain authorization → review_decision → review_queue
-- and enforces four invariants:
--   (a) review_decision exists in same pilot
--   (b) review_outcome must be 'approved' (no authorizing rejected items)
--   (c) authorizer != reviewer (self-authorization forbidden)
--   (d) authorization_scope must map to the underlying intent type
-- The actor performs the same checks (where it can) for early
-- failure; this trigger is the unforgeable wall.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_governance_execution_authorizations_preconditions() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  d_outcome   TEXT;
  d_reviewer  UUID;
  d_queue_id  UUID;
  q_intent    TEXT;
  scope_ok    BOOLEAN;
BEGIN
  -- (a) Look up the referenced review_decision.
  SELECT review_outcome, reviewer_user_id, review_queue_id
    INTO d_outcome, d_reviewer, d_queue_id
    FROM governance_review_decisions
   WHERE id = NEW.review_decision_id
     AND pilot_instance_id = NEW.pilot_instance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'governance_execution_authorizations: review_decision % not found in pilot %',
      NEW.review_decision_id, NEW.pilot_instance_id;
  END IF;
  -- (b) Cannot authorize a non-approved review.
  IF d_outcome <> 'approved' THEN
    RAISE EXCEPTION
      'governance_execution_authorizations: cannot authorize a non-approved review (outcome was %)',
      d_outcome;
  END IF;
  -- (c) Self-authorization prohibition.
  IF d_reviewer = NEW.authorized_by_user_id THEN
    RAISE EXCEPTION
      'governance_execution_authorizations: authorizer % cannot be the reviewer (self-authorization forbidden)',
      NEW.authorized_by_user_id;
  END IF;
  -- (d) Walk to the queue to get the intent_type, then verify
  -- the scope ↔ intent mapping.
  SELECT decision_intent_type INTO q_intent
    FROM governance_review_queue
   WHERE id = d_queue_id
     AND pilot_instance_id = NEW.pilot_instance_id;
  IF NOT FOUND THEN
    -- The composite FK from review_decisions → review_queue makes
    -- this branch unreachable in practice, but defensive code is
    -- cheap and a clearer message is helpful.
    RAISE EXCEPTION
      'governance_execution_authorizations: queue row for review_decision % not found',
      NEW.review_decision_id;
  END IF;
  scope_ok := CASE
    WHEN q_intent = 'memory.candidate.create'
         AND NEW.authorization_scope = 'memory_candidate_admission'   THEN TRUE
    WHEN q_intent = 'memory.visibility.promote'
         AND NEW.authorization_scope = 'future_visibility_change'     THEN TRUE
    WHEN q_intent IN ('vault.session.open', 'vault.session.revoke')
         AND NEW.authorization_scope = 'future_vault_action'          THEN TRUE
    WHEN q_intent = 'external.side_effect'
         AND NEW.authorization_scope = 'future_external_action'       THEN TRUE
    ELSE FALSE
  END;
  IF NOT scope_ok THEN
    RAISE EXCEPTION
      'governance_execution_authorizations: authorization_scope % does not match intent type %',
      NEW.authorization_scope, q_intent;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS governance_execution_authorizations_preconditions ON governance_execution_authorizations;
CREATE TRIGGER governance_execution_authorizations_preconditions
  BEFORE INSERT ON governance_execution_authorizations
  FOR EACH ROW EXECUTE FUNCTION trg_governance_execution_authorizations_preconditions();

-- ---------------------------------------------------------------------
-- Table-level grants. lylo_app may SELECT and INSERT (the
-- execution-authorization actor records authorizations; admin
-- inspection reads through this role). lylo_admin may SELECT
-- (operator audit). No UPDATE / DELETE grants for any role.
-- lylo_runtime / lylo_setup have no access.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT ON governance_execution_authorizations TO lylo_app;
GRANT SELECT          ON governance_execution_authorizations TO lylo_admin;

-- ---------------------------------------------------------------------
-- Enable RLS. Without an explicit policy, a granted role sees
-- zero rows (default-deny) and INSERT is rejected (no WITH CHECK
-- passes).
-- ---------------------------------------------------------------------

ALTER TABLE governance_execution_authorizations ENABLE ROW LEVEL SECURITY;

-- INSERT: tenant + no impersonation + admin only.
DROP POLICY IF EXISTS auth_insert_admin ON governance_execution_authorizations;
CREATE POLICY auth_insert_admin ON governance_execution_authorizations FOR INSERT
  WITH CHECK (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND authorized_by_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND current_setting('app.user_role', true) = 'admin'
  );

-- SELECT: admin in the same pilot sees all authorizations.
-- No proposer / reviewer / authorizer / family / caregiver SELECT
-- policy. Authorizations are admin-to-admin governance metadata.
DROP POLICY IF EXISTS auth_admin_select ON governance_execution_authorizations;
CREATE POLICY auth_admin_select ON governance_execution_authorizations FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND current_setting('app.user_role', true) = 'admin'
  );

-- Rollback:
-- DROP POLICY IF EXISTS auth_admin_select  ON governance_execution_authorizations;
-- DROP POLICY IF EXISTS auth_insert_admin  ON governance_execution_authorizations;
-- ALTER TABLE governance_execution_authorizations DISABLE ROW LEVEL SECURITY;
-- REVOKE SELECT         ON governance_execution_authorizations FROM lylo_admin;
-- REVOKE SELECT, INSERT ON governance_execution_authorizations FROM lylo_app;
-- DROP TRIGGER IF EXISTS governance_execution_authorizations_preconditions ON governance_execution_authorizations;
-- DROP FUNCTION IF EXISTS trg_governance_execution_authorizations_preconditions();
-- DROP TRIGGER IF EXISTS governance_execution_authorizations_append_only ON governance_execution_authorizations;
-- DROP FUNCTION IF EXISTS trg_governance_execution_authorizations_append_only();
-- DROP TABLE IF EXISTS governance_execution_authorizations;
