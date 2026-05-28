import type { GovernanceDecoder } from '../types.js';

export function createProxyAdminDecoder(): GovernanceDecoder {
  return {
    id: 'proxy-admin',
    priority: 130,
    match: async ({ runtime, chain, tx }) =>
      (await runtime.isProxyAdminTransaction(chain, tx)) ? true : undefined,
    decode: ({ runtime, chain, tx }) =>
      runtime.readProxyAdminTransaction(chain, tx),
  };
}
