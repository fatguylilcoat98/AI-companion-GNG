'use strict';
/*
 * Shared OUTCOMES vocabulary for every actor.
 *
 * Locked enum. Adding a new outcome requires paired updates to
 * docs/governance/actor-runtime-boundary.md and the relevant
 * adversarial test snapshots.
 *
 *   EXECUTED  — admissible Decision was acted on (response-delivery
 *               actor: the conversation runtime was called and a
 *               response was produced).
 *   ABSTAINED — requires_review Decision was NOT acted on. The
 *               response-delivery actor returns this when handed a
 *               requires_review Decision (defense in depth — the
 *               GM-21 classifier doesn't actually return
 *               requires_review for response.deliver, but the
 *               outcome shape is well-defined).
 *   REJECTED  — inadmissible Decision was NOT acted on, OR a
 *               verification check failed before routing.
 *   STAGED    — GM-23: requires_review Decision was durably
 *               staged into governance_review_queue for later
 *               human review. The review-queue actor returns
 *               this outcome on the happy path.
 *   RECORDED  — GM-24: a human admin's review outcome was
 *               durably recorded into governance_review_decisions.
 *               The review-decision actor returns this outcome
 *               on the happy path. This is the act of *recording*
 *               a review outcome — it is NOT authorization, NOT
 *               execution, and NOT a signal to act. Future
 *               execution gates must be separately approved.
 *   AUTHORIZED_RECORDED — GM-25: an admin's explicit execution
 *               authorization (against an approved review_decision
 *               in the same pilot, with scope matching the
 *               original intent type, by a human different from
 *               the reviewer) was durably recorded into
 *               governance_execution_authorizations. The
 *               execution-authorization actor returns this
 *               outcome on the happy path. The verbose form
 *               preserves the semantic boundary: this is a
 *               *recording* of authorization, not authorization
 *               to act. No production code consumes the
 *               authorization row in GM-25; execution remains a
 *               separately-gated decision.
 *   CLAIM_RECORDED — GM-26: an admin's explicit claim of an
 *               authorization (against an authorization in the
 *               same pilot, with surface fitting the scope, by a
 *               human different from the authorizer, against a
 *               still-approved underlying review) was durably
 *               recorded into governance_execution_claims. The
 *               execution-claim-ledger actor returns this outcome
 *               on the happy path. Constitutional rule: claim is
 *               NOT execution, NOT dispatch, NOT completion, NOT
 *               success — it ONLY means "this authorization has
 *               now been consumed exactly once." No production
 *               code consumes claim rows in GM-26.
 *   ATTEMPT_RECORDED — GM-27: an admin (different from the
 *               claimant) began an execution attempt against a
 *               claim. The first artifact in the chain that
 *               names "execution" — and deliberately stops short
 *               of saying whether anything actually happened.
 *               The execution-attempt-ledger actor returns this
 *               outcome on the happy path. Constitutional rule
 *               (the strictest one yet): ATTEMPT IS NOT OUTCOME.
 *               An attempt row records ONLY the beginning of an
 *               attempt — never success, failure, completion,
 *               interruption, delivery, dispatch, finalization,
 *               or commit state. No production code consumes
 *               attempt rows in GM-27.
 */

const OUTCOMES = Object.freeze({
  EXECUTED:            'executed',
  ABSTAINED:           'abstained',
  REJECTED:            'rejected',
  STAGED:              'staged',
  RECORDED:            'recorded',
  AUTHORIZED_RECORDED: 'authorized_recorded',
  CLAIM_RECORDED:      'claim_recorded',
  ATTEMPT_RECORDED:    'attempt_recorded',
});

module.exports = { OUTCOMES };
