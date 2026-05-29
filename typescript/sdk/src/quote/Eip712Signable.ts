import { assert } from '@hyperlane-xyz/utils';

/**
 * Cross-VM `SignableInput` shape for EVM EIP-712 typed-data signing.
 *
 * The EVM quote writer composes this from a `CreateWarpQuoteRequest` plus
 * the on-chain `OffchainQuotedLinearFee.SIGNED_QUOTE_TYPEHASH` layout. The
 * shape here is generic EIP-712 — any TypedDataField tree works.
 */

export interface Eip712TypedDataDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

export interface Eip712TypedDataField {
  name: string;
  type: string;
}

export type Eip712Signable = {
  domain: Eip712TypedDataDomain;
  types: Record<string, Eip712TypedDataField[]>;
  message: Record<string, unknown>;
};

function isEip712TypedDataDomain(x: unknown): x is Eip712TypedDataDomain {
  if (typeof x !== 'object' || x === null) return false;
  const d = x as Record<string, unknown>;
  return (
    typeof d.name === 'string' &&
    typeof d.version === 'string' &&
    typeof d.chainId === 'number' &&
    typeof d.verifyingContract === 'string'
  );
}

export function isEip712Signable(input: unknown): input is Eip712Signable {
  if (typeof input !== 'object' || input === null) return false;
  const o = input as Record<string, unknown>;
  if (typeof o.types !== 'object' || o.types === null) return false;
  if (typeof o.message !== 'object' || o.message === null) return false;
  if (!isEip712TypedDataDomain(o.domain)) return false;
  return true;
}

export function parseEip712Signable(input: unknown): Eip712Signable {
  assert(
    isEip712Signable(input),
    'Expected EIP-712 signable envelope: { domain, types, message }.',
  );
  return input;
}
