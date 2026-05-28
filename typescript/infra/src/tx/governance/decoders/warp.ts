import type { GovernanceDecoder } from '../types.js';

export function createWarpModuleDecoder(): GovernanceDecoder {
  return {
    id: 'warp-module',
    priority: 80,
    match: ({ runtime, chain, tx }) =>
      runtime.isWarpModuleTransaction(chain, tx) ? true : undefined,
    decode: ({ runtime, chain, tx }) =>
      runtime.readWarpModuleTransaction(chain, tx),
  };
}
