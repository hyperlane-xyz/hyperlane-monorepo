export const INTERNAL_SERVER_ERROR = 'Internal server error' as const;

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

/** The caller may not read this commitment, or the reveal does not belong to it. */
export class CommitmentAccessDeniedError extends Error {
  constructor(message = 'Signer not authorized for this commitment') {
    super(message);
    this.name = 'CommitmentAccessDeniedError';
  }
}
