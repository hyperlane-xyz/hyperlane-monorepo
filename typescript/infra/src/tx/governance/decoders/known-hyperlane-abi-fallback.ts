import type { GovernTransaction, GovernanceDecoder } from '../types.js';

export function createKnownHyperlaneAbiFallbackDecoder(): GovernanceDecoder<GovernTransaction> {
  return {
    id: 'known-hyperlane-abi-fallback',
    priority: 120,
    match: ({ runtime, chain, tx }) =>
      runtime.tryReadByKnownContractInterface(chain, tx),
    decode: async ({ match }) => match,
  };
}
