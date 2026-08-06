import { utils as ethersUtils } from 'ethers';

import {
  type CreateWarpQuoteRequest,
  WarpQuoteAmountKind,
} from '@hyperlane-xyz/provider-sdk/quote';

import {
  type Eip712Signable,
  type Eip712TypedDataField,
} from './Eip712Signable.js';

/**
 * Maps `CreateWarpQuoteRequest` onto the `OffchainQuotedLinearFee.SignedQuote`
 * EIP-712 typed-data layout. The tuple shape mirrors the on-chain struct used
 * by `submitQuote(...)`; the signable wraps the same tuple in the EIP-712
 * envelope so the signer + the broadcast tx use bit-identical fields.
 */

export const OFFCHAIN_QUOTER_DOMAIN_NAME = 'OffchainQuoter';
export const OFFCHAIN_QUOTER_DOMAIN_VERSION = '1';

/** EVM `WILDCARD_AMOUNT = type(uint256).max` — required for standing quotes. */
const EVM_WILDCARD_AMOUNT = (1n << 256n) - 1n;

export const SIGNED_QUOTE_TYPES: Record<string, Eip712TypedDataField[]> = {
  SignedQuote: [
    { name: 'context', type: 'bytes' },
    { name: 'data', type: 'bytes' },
    { name: 'issuedAt', type: 'uint48' },
    { name: 'expiry', type: 'uint48' },
    { name: 'salt', type: 'bytes32' },
    { name: 'submitter', type: 'address' },
  ],
};

export interface EvmSignedQuoteTuple {
  context: string;
  data: string;
  issuedAt: number;
  expiry: number;
  salt: string;
  submitter: string;
}

export function buildEvmSignedQuoteTuple(
  req: CreateWarpQuoteRequest,
  salt: string,
  submitter: string,
): EvmSignedQuoteTuple {
  const amount =
    req.scope.amount.kind === WarpQuoteAmountKind.wildcard
      ? EVM_WILDCARD_AMOUNT
      : req.scope.amount.value;
  return {
    context: ethersUtils.solidityPack(
      ['uint32', 'bytes32', 'uint256'],
      [req.scope.destination, req.scope.recipient, amount],
    ),
    data: ethersUtils.solidityPack(
      ['uint256', 'uint256'],
      [req.params.maxFee, req.params.halfAmount],
    ),
    issuedAt: req.issuedAt,
    expiry: req.expiry,
    salt,
    submitter,
  };
}

export function buildEvmSignedQuoteSignable(
  sq: EvmSignedQuoteTuple,
  chainId: number,
  verifyingContract: string,
): Eip712Signable {
  return {
    domain: {
      name: OFFCHAIN_QUOTER_DOMAIN_NAME,
      version: OFFCHAIN_QUOTER_DOMAIN_VERSION,
      chainId,
      verifyingContract,
    },
    types: SIGNED_QUOTE_TYPES,
    message: { ...sq },
  };
}
