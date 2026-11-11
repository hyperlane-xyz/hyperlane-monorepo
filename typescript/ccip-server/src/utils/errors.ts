/** Circle has not produced an attestation yet; callers should retry. */
export class AttestationPendingError extends Error {
  constructor() {
    super('CCTP attestation is pending');
    this.name = 'AttestationPendingError';
  }
}

/** The caller may not read this commitment, or the reveal does not belong to it. */
export class CommitmentAccessDeniedError extends Error {
  constructor(message = 'Signer not authorized for this commitment') {
    super(message);
    this.name = 'CommitmentAccessDeniedError';
  }
}
