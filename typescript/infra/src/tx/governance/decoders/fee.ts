import type { GovernanceDecoder } from '../types.js';

export function createFeeContractDecoder(): GovernanceDecoder {
  return {
    id: 'fee-contract',
    priority: 110,
    match: async ({ runtime, chain, tx }) =>
      (await runtime.isFeeTransaction(chain, tx)) ? true : undefined,
    decode: ({ runtime, chain, tx }) => runtime.readFeeTransaction(chain, tx),
  };
}
