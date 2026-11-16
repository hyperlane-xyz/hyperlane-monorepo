/** Circle has not produced an attestation yet; callers should retry. */
export class AttestationPendingError extends Error {
  constructor() {
    super('CCTP attestation is pending');
    this.name = 'AttestationPendingError';
  }
}

/** A valid service identity is not authorized to read this commitment. */
export class CommitmentAccessDeniedError extends Error {
  constructor() {
    super('Signer not authorized for this commitment');
    this.name = 'CommitmentAccessDeniedError';
  }
}

/** An EVM origin supplied an origin_tx_hash that is not a valid 32-byte hash. */
export class InvalidOriginTxHashError extends Error {
  constructor() {
    super('Invalid origin_tx_hash');
    this.name = 'InvalidOriginTxHashError';
  }
}
