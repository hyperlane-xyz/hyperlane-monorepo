import type { GovernanceDecoder } from '../types.js';

export function createSafeDecoder(): GovernanceDecoder {
  return {
    id: 'safe',
    priority: 20,
    match: ({ runtime, chain, tx }) =>
      runtime.isSafeTransaction(chain, tx) ? true : undefined,
    decode: ({ runtime, chain, tx }) => runtime.readSafeTransaction(chain, tx),
  };
}
