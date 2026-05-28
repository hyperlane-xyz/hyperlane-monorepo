import type { GovernanceDecoder } from '../types.js';

export function createMultisendDecoder(): GovernanceDecoder {
  return {
    id: 'multisend',
    priority: 60,
    match: async ({ runtime, tx }) =>
      (await runtime.isMultisendTransaction(tx)) ? true : undefined,
    decode: ({ runtime, chain, tx }) =>
      runtime.readMultisendTransaction(chain, tx),
  };
}
