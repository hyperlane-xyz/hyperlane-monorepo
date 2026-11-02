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
