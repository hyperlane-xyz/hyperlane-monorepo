/** Circle has not produced an attestation yet; callers should retry. */
export class AttestationPendingError extends Error {
  constructor() {
    super('CCTP attestation is pending');
    this.name = 'AttestationPendingError';
  }
}
