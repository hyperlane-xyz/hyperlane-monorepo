import type { DiagnosticError } from '@hyperlane-xyz/utils';

export enum CctpErrorCode {
  Pending = 'cctp_attestation_pending',
  PendingConfirmations = 'cctp_pending_confirmations',
  InsufficientFee = 'cctp_insufficient_fee',
  AmountAboveMax = 'cctp_amount_above_max',
  InsufficientAllowance = 'cctp_insufficient_allowance_available',
  NotFound = 'cctp_attestation_not_found',
  MatchPending = 'cctp_message_match_pending',
  HttpError = 'cctp_upstream_http_error',
  RequestFailed = 'cctp_upstream_request_failed',
  InvalidResponse = 'cctp_upstream_invalid_response',
  UnsupportedVersion = 'cctp_unsupported_version',
  OriginTransactionMissing = 'cctp_origin_transaction_missing',
  OriginReceiptMissing = 'cctp_origin_receipt_missing',
  OriginReceiptLookupFailed = 'cctp_origin_receipt_lookup_failed',
  MessageEventMissing = 'cctp_message_event_missing',
  MessageMatchFailed = 'cctp_message_match_failed',
}

const cctpMessages: Record<CctpErrorCode, string> = {
  [CctpErrorCode.Pending]: 'CCTP attestation is pending',
  [CctpErrorCode.PendingConfirmations]:
    'Circle is awaiting origin confirmations',
  [CctpErrorCode.InsufficientFee]:
    'Circle attestation is delayed by an insufficient fee',
  [CctpErrorCode.AmountAboveMax]:
    'Circle transfer amount exceeds the allowed maximum',
  [CctpErrorCode.InsufficientAllowance]:
    'Circle attestation is delayed by insufficient available allowance',
  [CctpErrorCode.NotFound]: 'Circle has not found the attestation yet',
  [CctpErrorCode.MatchPending]:
    'Circle response does not yet contain a matching message',
  [CctpErrorCode.HttpError]: 'Circle attestation API returned an HTTP error',
  [CctpErrorCode.RequestFailed]: 'Circle attestation API request failed',
  [CctpErrorCode.InvalidResponse]:
    'Circle attestation API returned an invalid response',
  [CctpErrorCode.UnsupportedVersion]: 'CCTP message version is unsupported',
  [CctpErrorCode.OriginTransactionMissing]:
    'CCTP origin transaction was not found',
  [CctpErrorCode.OriginReceiptMissing]:
    'CCTP origin transaction receipt was not found',
  [CctpErrorCode.OriginReceiptLookupFailed]:
    'CCTP origin transaction receipt lookup failed',
  [CctpErrorCode.MessageEventMissing]:
    'CCTP MessageSent event was not found in the origin receipt',
  [CctpErrorCode.MessageMatchFailed]:
    'No CCTP MessageSent event matched the Hyperlane message',
};

const gatewayCodes = new Set<CctpErrorCode>([
  CctpErrorCode.OriginTransactionMissing,
  CctpErrorCode.OriginReceiptMissing,
  CctpErrorCode.OriginReceiptLookupFailed,
  CctpErrorCode.MessageEventMissing,
  CctpErrorCode.MessageMatchFailed,
]);

export class CctpAttestationError extends Error {
  readonly diagnostic: DiagnosticError;

  constructor(code: CctpErrorCode, details: Record<string, unknown> = {}) {
    super(cctpMessages[code]);
    const source = gatewayCodes.has(code) ? 'cctp_gateway' : 'circle_api';
    this.diagnostic = {
      code,
      message: this.message,
      source,
      details,
    };
  }
}

/** Circle has not produced an attestation yet; callers should retry. */
export class AttestationPendingError extends CctpAttestationError {
  constructor(code = CctpErrorCode.Pending) {
    super(code);
    // Preserve the legacy pending signal for older relayers/gateways.
    this.message = 'CCTP attestation is pending';
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
