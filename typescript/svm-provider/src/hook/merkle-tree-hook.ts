// Merkle tree hook uses the mailbox outbox merkle tree account.
// This package currently exposes low-level instruction/account codecs only.

export const MERKLE_TREE_HOOK_NOTES = {
  accountSource: 'mailbox outbox account',
  readerStatus: 'pending hand-crafted reader',
} as const;
