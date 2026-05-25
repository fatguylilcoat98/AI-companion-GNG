-- Fixtures for the synthetic RLS / privacy contract suite.
--
-- Two pilots so cross-pilot isolation can be verified. All identifiers
-- are obviously fictional. The fixtures must be seeded BEFORE RLS is
-- enabled (or under a BYPASSRLS role / the superuser); the runner
-- applies synthetic-schema.sql, then fixtures.sql, then policies.sql.

-- Pilot A
INSERT INTO pilot_instances (id, org_name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Pilot A Org');

INSERT INTO users (id, pilot_instance_id, username, role) VALUES
  ('aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'senior-A',     'senior'),
  ('aaaaaaaa-2222-1111-1111-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'family-A',     'family'),
  ('aaaaaaaa-3333-1111-1111-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'caregiver-A',  'caregiver'),
  ('aaaaaaaa-4444-1111-1111-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'admin-A',      'admin'),
  -- GM-25: second admin per pilot so authorization rows can be
  -- seeded with authorizer != reviewer (admin-A reviews; admin2-A
  -- authorizes). The CHECK on `users.role` accepts 'admin' for
  -- multiple users per pilot; only `senior` is one-per-pilot.
  ('aaaaaaaa-5555-1111-1111-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'admin2-A',     'admin'),
  -- GM-26: third admin per pilot so claim rows can be seeded
  -- with claimant != authorizer (admin2-A authorizes; admin3-A
  -- claims). Adjacent-only separation-of-duties chain extends
  -- one more stage.
  ('aaaaaaaa-6666-1111-1111-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'admin3-A',     'admin'),
  -- GM-27: fourth admin per pilot so attempt rows can be seeded
  -- with attempter != claimant (admin3-A claims; admin4-A
  -- attempts). Adjacent-only separation-of-duties chain extends
  -- one more stage.
  ('aaaaaaaa-7777-1111-1111-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'admin4-A',     'admin'),
  -- GM-28: fifth admin per pilot so outcome rows can be seeded
  -- with recorder != attempter (admin4-A attempts; admin5-A
  -- records the observed outcome). Adjacent-only separation-of-
  -- duties chain extends one more stage (now 5 deep:
  -- reviewer ≠ authorizer ≠ claimant ≠ attempter ≠ recorder).
  ('aaaaaaaa-8888-1111-1111-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'admin5-A',     'admin'),
  -- GM-29: sixth admin per pilot so verification rows can be
  -- seeded with verifier != outcome recorder (admin5-A records
  -- outcomes; admin6-A verifies them). Adjacent-only separation-
  -- of-duties chain extends one more stage (now 6 deep:
  -- reviewer ≠ authorizer ≠ claimant ≠ attempter ≠ recorder ≠
  -- verifier).
  ('aaaaaaaa-9999-1111-1111-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'admin6-A',     'admin');

INSERT INTO companion_profile (pilot_instance_id, companion_name, persona) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Aria', '{"tone":"warm"}'::jsonb);

INSERT INTO supported_person_profile (pilot_instance_id, user_id, display_name) VALUES
  ('11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'Person A');

INSERT INTO setup_state (pilot_instance_id, step_key, status, completed_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 'provisioning_complete', 'complete', now());

-- family-A: in circle with family_shared permission.
INSERT INTO circle_contacts (pilot_instance_id, senior_user_id, contact_user_id, permission_scope) VALUES
  ('11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'aaaaaaaa-2222-1111-1111-aaaaaaaaaaaa',
   '{"visibility_levels":["family_shared"]}'::jsonb);

-- caregiver-A: in circle but NO family_shared permission.
INSERT INTO circle_contacts (pilot_instance_id, senior_user_id, contact_user_id, permission_scope) VALUES
  ('11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'aaaaaaaa-3333-1111-1111-aaaaaaaaaaaa',
   '{"visibility_levels":[]}'::jsonb);

-- Senior A's vault + sessions.
INSERT INTO memory_vaults (id, pilot_instance_id, user_id, pin_hash, pin_salt) VALUES
  ('aaaaaaaa-aaaa-1111-1111-bbbbbbbbbbbb',
   '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'fake-hash', 'fake-salt');

-- Open session (unexpired, not revoked).
INSERT INTO memory_vault_sessions (id, pilot_instance_id, vault_id, user_id, expires_at) VALUES
  ('aaaaaaaa-bbbb-1111-1111-cccccccccccc',
   '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-1111-1111-bbbbbbbbbbbb',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   now() + interval '1 hour');

-- Revoked session — must not unlock anything.
INSERT INTO memory_vault_sessions (id, pilot_instance_id, vault_id, user_id, expires_at, revoked_at) VALUES
  ('aaaaaaaa-bbbb-2222-1111-cccccccccccc',
   '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-1111-1111-bbbbbbbbbbbb',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   now() + interval '1 hour',
   now());

-- Senior A's memories: one of each visibility level + one inadmissible.
INSERT INTO memory_store (id, pilot_instance_id, owning_user_id, content, provenance, visibility_level, admissibility_state, vault_id) VALUES
  ('aaaaaaaa-cccc-1111-1111-100000000001',
   '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'private content A',
   'USER_STATED',
   'private',
   'admissible',
   NULL),
  ('aaaaaaaa-cccc-1111-1111-100000000002',
   '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'family-shared content A',
   'USER_STATED',
   'family_shared',
   'admissible',
   NULL),
  ('aaaaaaaa-cccc-1111-1111-100000000003',
   '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'password-locked content A',
   'USER_STATED',
   'password_locked',
   'admissible',
   'aaaaaaaa-aaaa-1111-1111-bbbbbbbbbbbb'),
  ('aaaaaaaa-cccc-1111-1111-100000000004',
   '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'inadmissible family-shared content A',
   'AI_INFERRED',
   'family_shared',
   'inadmissible',
   NULL);

INSERT INTO governance_audit_log (pilot_instance_id, target_user_id, event_type, actor_user_id, actor_role, outcome) VALUES
  ('11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'memory.created',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'senior',
   'allowed');

-- Pilot B (separate tenant — for cross-pilot isolation tests).
INSERT INTO pilot_instances (id, org_name) VALUES
  ('22222222-2222-2222-2222-222222222222', 'Pilot B Org');

INSERT INTO users (id, pilot_instance_id, username, role) VALUES
  ('bbbbbbbb-1111-2222-2222-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'senior-B', 'senior'),
  ('bbbbbbbb-4444-2222-2222-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'admin-B',  'admin'),
  -- GM-25: second admin per pilot (see comment in Pilot A users
  -- block above).
  ('bbbbbbbb-5555-2222-2222-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'admin2-B', 'admin'),
  -- GM-26: third admin per pilot (see comment in Pilot A users
  -- block above).
  ('bbbbbbbb-6666-2222-2222-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'admin3-B', 'admin'),
  -- GM-27: fourth admin per pilot (see comment in Pilot A users
  -- block above).
  ('bbbbbbbb-7777-2222-2222-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'admin4-B', 'admin'),
  -- GM-28: fifth admin per pilot (see comment in Pilot A users
  -- block above).
  ('bbbbbbbb-8888-2222-2222-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'admin5-B', 'admin'),
  ('bbbbbbbb-9999-2222-2222-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'admin6-B', 'admin');

INSERT INTO companion_profile (pilot_instance_id, companion_name, persona) VALUES
  ('22222222-2222-2222-2222-222222222222', 'Bram', '{"tone":"steady"}'::jsonb);

INSERT INTO supported_person_profile (pilot_instance_id, user_id, display_name) VALUES
  ('22222222-2222-2222-2222-222222222222',
   'bbbbbbbb-1111-2222-2222-bbbbbbbbbbbb',
   'Person B');

INSERT INTO memory_store (id, pilot_instance_id, owning_user_id, content, provenance, visibility_level, admissibility_state) VALUES
  ('bbbbbbbb-cccc-2222-2222-200000000001',
   '22222222-2222-2222-2222-222222222222',
   'bbbbbbbb-1111-2222-2222-bbbbbbbbbbbb',
   'private content B',
   'USER_STATED',
   'private',
   'admissible');

INSERT INTO governance_audit_log (pilot_instance_id, target_user_id, event_type, actor_user_id, actor_role, outcome) VALUES
  ('22222222-2222-2222-2222-222222222222',
   'bbbbbbbb-1111-2222-2222-bbbbbbbbbbbb',
   'memory.created',
   'bbbbbbbb-1111-2222-2222-bbbbbbbbbbbb',
   'senior',
   'allowed');

-- GM-23: review-queue seed rows. One per pilot, each proposed by the
-- pilot's senior. The fixture seeds rows directly (the synthetic
-- runner connects as superuser and bypasses RLS for seeding); the
-- subsequent matrix exercises SELECT visibility per role.
INSERT INTO governance_review_queue
  (id, pilot_instance_id, decision_intent_type, decision_reason,
   decision_policy_ref, proposer_user_id, proposer_role,
   payload_summary, evidence_summary) VALUES
  ('aaaaaaaa-eeee-1111-1111-700000000001',
   '11111111-1111-1111-1111-111111111111',
   'memory.candidate.create',
   'ai_inferred_requires_review',
   'source-of-truth-memory-policy.md §3, §5',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'senior',
   '{"content": "synthetic-A candidate", "provenance": "AI_INFERRED"}'::jsonb,
   '{"source": "synthetic"}'::jsonb),
  ('bbbbbbbb-eeee-2222-2222-700000000001',
   '22222222-2222-2222-2222-222222222222',
   'memory.candidate.create',
   'user_stated_requires_review',
   'source-of-truth-memory-policy.md §4',
   'bbbbbbbb-1111-2222-2222-bbbbbbbbbbbb',
   'senior',
   '{"content": "synthetic-B candidate", "provenance": "USER_STATED"}'::jsonb,
   '{"source": "synthetic"}'::jsonb);

-- A second queue row per pilot — left unreviewed so the GM-24
-- listPending matrix has both a reviewed and a pending row to
-- distinguish. Same proposer as above so the proposer-SELECT
-- policy continues to work.
INSERT INTO governance_review_queue
  (id, pilot_instance_id, decision_intent_type, decision_reason,
   decision_policy_ref, proposer_user_id, proposer_role,
   payload_summary, evidence_summary) VALUES
  ('aaaaaaaa-eeee-1111-1111-700000000002',
   '11111111-1111-1111-1111-111111111111',
   'memory.candidate.create',
   'user_stated_requires_review',
   'source-of-truth-memory-policy.md §4',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'senior',
   '{"content": "synthetic-A pending", "provenance": "USER_STATED"}'::jsonb,
   '{"source": "synthetic"}'::jsonb),
  ('bbbbbbbb-eeee-2222-2222-700000000002',
   '22222222-2222-2222-2222-222222222222',
   'memory.candidate.create',
   'ai_inferred_requires_review',
   'source-of-truth-memory-policy.md §3, §5',
   'bbbbbbbb-1111-2222-2222-bbbbbbbbbbbb',
   'senior',
   '{"content": "synthetic-B pending", "provenance": "AI_INFERRED"}'::jsonb,
   '{"source": "synthetic"}'::jsonb);

-- GM-24: review-decision seed rows. admin-A approved REVIEW_A;
-- admin-B rejected REVIEW_B. Each pilot has exactly one reviewed
-- queue row (REVIEW_*_1) plus exactly one still-pending row
-- (REVIEW_*_2 inserted above). The matrix uses both states.
INSERT INTO governance_review_decisions
  (id, pilot_instance_id, review_queue_id, reviewer_user_id,
   reviewer_role, review_outcome, review_reason) VALUES
  ('aaaaaaaa-dddd-1111-1111-800000000001',
   '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-eeee-1111-1111-700000000001',
   'aaaaaaaa-4444-1111-1111-aaaaaaaaaaaa',
   'admin',
   'approved',
   'approved_admin_review'),
  ('bbbbbbbb-dddd-2222-2222-800000000001',
   '22222222-2222-2222-2222-222222222222',
   'bbbbbbbb-eeee-2222-2222-700000000001',
   'bbbbbbbb-4444-2222-2222-bbbbbbbbbbbb',
   'admin',
   'rejected',
   'rejected_insufficient_evidence');

-- GM-25: a third pair of queue rows (REVIEW_*_3) per pilot,
-- approved by the pilot's first admin, so the GM-25 authorization
-- seeds can target an approved review. Cross-admin invariant per
-- OQ-25.14 — admin1 reviews, admin2 authorizes.
INSERT INTO governance_review_queue
  (id, pilot_instance_id, decision_intent_type, decision_reason,
   decision_policy_ref, proposer_user_id, proposer_role,
   payload_summary, evidence_summary) VALUES
  ('aaaaaaaa-eeee-1111-1111-700000000003',
   '11111111-1111-1111-1111-111111111111',
   'memory.candidate.create',
   'ai_inferred_requires_review',
   'source-of-truth-memory-policy.md §3, §5',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'senior',
   '{"content": "synthetic-A authorized-path candidate", "provenance": "AI_INFERRED"}'::jsonb,
   '{"source": "synthetic"}'::jsonb),
  ('bbbbbbbb-eeee-2222-2222-700000000003',
   '22222222-2222-2222-2222-222222222222',
   'memory.candidate.create',
   'ai_inferred_requires_review',
   'source-of-truth-memory-policy.md §3, §5',
   'bbbbbbbb-1111-2222-2222-bbbbbbbbbbbb',
   'senior',
   '{"content": "synthetic-B authorized-path candidate", "provenance": "AI_INFERRED"}'::jsonb,
   '{"source": "synthetic"}'::jsonb);

INSERT INTO governance_review_decisions
  (id, pilot_instance_id, review_queue_id, reviewer_user_id,
   reviewer_role, review_outcome, review_reason) VALUES
  ('aaaaaaaa-dddd-1111-1111-800000000002',
   '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-eeee-1111-1111-700000000003',
   'aaaaaaaa-4444-1111-1111-aaaaaaaaaaaa',
   'admin',
   'approved',
   'approved_admin_review'),
  ('bbbbbbbb-dddd-2222-2222-800000000002',
   '22222222-2222-2222-2222-222222222222',
   'bbbbbbbb-eeee-2222-2222-700000000003',
   'bbbbbbbb-4444-2222-2222-bbbbbbbbbbbb',
   'admin',
   'approved',
   'approved_admin_review');

-- GM-25: authorization rows. authorizer (admin2) != reviewer
-- (admin1). authorization_scope must match the underlying intent
-- type — memory.candidate.create → memory_candidate_admission.
INSERT INTO governance_execution_authorizations
  (id, pilot_instance_id, review_decision_id, authorized_by_user_id,
   authorized_by_role, authorization_scope, authorization_reason) VALUES
  ('aaaaaaaa-cccc-1111-1111-900000000001',
   '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-dddd-1111-1111-800000000002',
   'aaaaaaaa-5555-1111-1111-aaaaaaaaaaaa',
   'admin',
   'memory_candidate_admission',
   'admin_explicit_authorization'),
  ('bbbbbbbb-cccc-2222-2222-900000000001',
   '22222222-2222-2222-2222-222222222222',
   'bbbbbbbb-dddd-2222-2222-800000000002',
   'bbbbbbbb-5555-2222-2222-bbbbbbbbbbbb',
   'admin',
   'memory_candidate_admission',
   'admin_explicit_authorization');

-- GM-26: claim rows. claimant (admin3) != authorizer (admin2).
-- execution_surface must fit authorization_scope —
-- memory_candidate_admission → future_memory_admission_consumer.
INSERT INTO governance_execution_claims
  (id, pilot_instance_id, execution_authorization_id,
   authorization_scope, execution_surface,
   claimed_by_user_id, claimed_by_role) VALUES
  ('aaaaaaaa-bbbb-1111-1111-a00000000001',
   '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-cccc-1111-1111-900000000001',
   'memory_candidate_admission',
   'future_memory_admission_consumer',
   'aaaaaaaa-6666-1111-1111-aaaaaaaaaaaa',
   'admin'),
  ('bbbbbbbb-bbbb-2222-2222-b00000000001',
   '22222222-2222-2222-2222-222222222222',
   'bbbbbbbb-cccc-2222-2222-900000000001',
   'memory_candidate_admission',
   'future_memory_admission_consumer',
   'bbbbbbbb-6666-2222-2222-bbbbbbbbbbbb',
   'admin');

-- GM-27: attempt rows. attempter (admin4) != claimant (admin3).
-- authorization_scope and execution_surface MUST equal the
-- claim's values (DB trigger asserts equality).
INSERT INTO governance_execution_attempts
  (id, pilot_instance_id, execution_claim_id,
   authorization_scope, execution_surface,
   attempted_by_user_id, attempted_by_role) VALUES
  ('aaaaaaaa-aaaa-1111-1111-c00000000001',
   '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-bbbb-1111-1111-a00000000001',
   'memory_candidate_admission',
   'future_memory_admission_consumer',
   'aaaaaaaa-7777-1111-1111-aaaaaaaaaaaa',
   'admin'),
  ('bbbbbbbb-aaaa-2222-2222-d00000000001',
   '22222222-2222-2222-2222-222222222222',
   'bbbbbbbb-bbbb-2222-2222-b00000000001',
   'memory_candidate_admission',
   'future_memory_admission_consumer',
   'bbbbbbbb-7777-2222-2222-bbbbbbbbbbbb',
   'admin');

-- GM-28: reported-outcome rows. recorder (admin5) != attempter
-- (admin4). authorization_scope and execution_surface MUST equal
-- the attempt's values (DB trigger asserts equality).
-- outcome_type uses the locked reported_* vocabulary —
-- observational, not evaluative.
INSERT INTO governance_execution_outcomes
  (id, pilot_instance_id, execution_attempt_id,
   authorization_scope, execution_surface, outcome_type,
   recorded_by_user_id, recorded_by_role) VALUES
  ('aaaaaaaa-9999-1111-1111-e00000000001',
   '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-1111-1111-c00000000001',
   'memory_candidate_admission',
   'future_memory_admission_consumer',
   'reported_completed',
   'aaaaaaaa-8888-1111-1111-aaaaaaaaaaaa',
   'admin'),
  ('bbbbbbbb-9999-2222-2222-f00000000001',
   '22222222-2222-2222-2222-222222222222',
   'bbbbbbbb-aaaa-2222-2222-d00000000001',
   'memory_candidate_admission',
   'future_memory_admission_consumer',
   'reported_unknown',
   'bbbbbbbb-8888-2222-2222-bbbbbbbbbbbb',
   'admin');

-- GM-29: execution-verification rows. verifier (admin6) !=
-- outcome recorder (admin5). One verification per outcome
-- (UNIQUE on execution_outcome_id). VERIFICATION_A uses
-- `verified_consistent` on OUTCOME_A (`reported_completed`);
-- VERIFICATION_B uses `verification_inconclusive` on OUTCOME_B
-- (`reported_unknown`) — a meaningful governance signal: two
-- humans + the verifier's evidence channel agreed there was
-- nothing to verify against. The `verified_*` vocabulary is
-- constitutionally isolated to this table; K37 snapshot test
-- enforces it does NOT leak into EXECUTION_OUTCOME_TYPES.
INSERT INTO governance_execution_verifications
  (id, pilot_instance_id, execution_outcome_id,
   verified_by_user_id, verified_by_role,
   verification_type, verification_result) VALUES
  ('aaaaaaaa-8888-1111-1111-100000000001',
   '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-9999-1111-1111-e00000000001',
   'aaaaaaaa-9999-1111-1111-aaaaaaaaaaaa',
   'admin',
   'database_state_check',
   'verified_consistent'),
  ('bbbbbbbb-8888-2222-2222-200000000001',
   '22222222-2222-2222-2222-222222222222',
   'bbbbbbbb-9999-2222-2222-f00000000001',
   'bbbbbbbb-9999-2222-2222-bbbbbbbbbbbb',
   'admin',
   'human_observation',
   'verification_inconclusive');
