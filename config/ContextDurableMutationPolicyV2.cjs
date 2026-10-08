'use strict';
// Restricted production scope until writer-level fencing is established.
// This is a source-level restriction, not an environment/config opt-in.
const DURABLE_MUTATION_DISABLED_CODE = 'ccv2-durable-mutation-disabled';
function durableMutationEnabledV2() { return false; }
function assertDurableMutationAllowedV2() {
  const error = new Error(DURABLE_MUTATION_DISABLED_CODE + ': active durable CCv2 is unavailable until mutation-time fencing is verified');
  error.code = DURABLE_MUTATION_DISABLED_CODE;
  throw error;
}
module.exports = Object.freeze({ DURABLE_MUTATION_DISABLED_CODE, durableMutationEnabledV2, assertDurableMutationAllowedV2 });
