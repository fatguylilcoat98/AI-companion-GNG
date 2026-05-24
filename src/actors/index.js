'use strict';
/*
 * Actors public API — GM-22.
 *
 * Decision-gated executors. An actor's contract:
 *   1. Accept a Decision (instanceof + WeakSet-blessed + frozen +
 *      intent-type-correct + structural-vocabulary-valid).
 *   2. On admissible → execute the corresponding action.
 *   3. On requires_review → return abstained outcome (no execution).
 *   4. On inadmissible → return rejected outcome (no execution).
 *   5. On forged/tampered/mismatched Decision → throw (programmer
 *      error — the caller built the wrong thing).
 *
 * GM-22 ships ONE actor (OQ-22.2): the response-delivery actor.
 * Future GMs add more actors, each with its own boundary guard
 * and its own intent-type contract.
 *
 * The conversation runtime is still independently callable in
 * GM-22 (OQ-22.8 — no API break). The actor is the
 * recommended-but-not-mandatory path. A future GM may close that
 * direct-caller seam.
 */

const { createResponseDeliveryActor, OUTCOMES } = require('./response-delivery-actor');

module.exports = {
  createResponseDeliveryActor,
  OUTCOMES,
};
