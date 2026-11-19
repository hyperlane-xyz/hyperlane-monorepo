export const INTERNAL_SERVER_ERROR = 'Internal server error';

/**
 * The lookup has no answer yet and the caller should retry. The message is
 * built by the server and is returned to the caller as is.
 */
export class LookupPendingError extends Error {}

/** Circle has not produced an attestation yet; callers should retry. */
export class AttestationPendingError extends LookupPendingError {
  constructor() {
    super('CCTP attestation is pending');
    this.name = 'AttestationPendingError';
  }
}

/** Reveal lookup states that resolve shortly; the relayer should retry. */
export const RevealPending = {
  Commitment: 'Commitment upload is pending',
  OriginReceipt: 'Origin transaction receipt is pending',
  ChainRead: 'Chain read is pending',
} as const;
export type RevealPending = (typeof RevealPending)[keyof typeof RevealPending];

export class RevealPendingError extends LookupPendingError {
  constructor(readonly reason: RevealPending) {
    super(reason);
    this.name = 'RevealPendingError';
  }
}

/** The caller may not read this commitment, or the reveal does not belong to it. */
export class CommitmentAccessDeniedError extends Error {
  constructor(message = 'Signer not authorized for this commitment') {
    super(message);
    this.name = 'CommitmentAccessDeniedError';
  }
}

export class InvalidOriginTxHashError extends Error {
  constructor() {
    super('Invalid origin_tx_hash');
    this.name = 'InvalidOriginTxHashError';
  }
}
