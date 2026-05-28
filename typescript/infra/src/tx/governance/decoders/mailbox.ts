import type { GovernanceDecoder } from '../types.js';

export function createMailboxDecoder(): GovernanceDecoder {
  return {
    id: 'mailbox',
    priority: 40,
    match: ({ runtime, chain, tx }) =>
      runtime.isMailboxTransaction(chain, tx) ? true : undefined,
    decode: ({ runtime, chain, tx }) =>
      runtime.readMailboxTransaction(chain, tx),
  };
}
