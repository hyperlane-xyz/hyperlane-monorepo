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

/**
 * The reveal's origin domain resolved to a protocol we don't know how to
 * handle (an unknown domain missing from registry metadata, or a protocol not
 * on the hint-handling allowlist). Fail closed rather than serve unbound.
 */
export class UnknownOriginProtocolError extends Error {
  constructor(origin: number, protocol: string | null | undefined) {
    super(
      `Unsupported origin protocol for reveal (origin ${origin}, protocol ${
        protocol ?? 'unknown'
      })`,
    );
    this.name = 'UnknownOriginProtocolError';
  }
}
