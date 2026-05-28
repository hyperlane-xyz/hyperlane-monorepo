import type { GovernanceDecoder } from '../types.js';

export function createIcaDecoder(): GovernanceDecoder {
  return {
    id: 'ica',
    priority: 30,
    match: ({ runtime, chain, tx }) =>
      runtime.isIcaTransaction(chain, tx) ? true : undefined,
    decode: ({ runtime, chain, tx }) => runtime.readIcaTransaction(chain, tx),
  };
}
