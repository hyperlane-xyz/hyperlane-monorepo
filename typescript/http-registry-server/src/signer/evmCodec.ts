import { ethers } from 'ethers';

import { ChainMetadata, ChainTechnicalStack } from '@hyperlane-xyz/sdk';
import {
  deepEquals,
  eqAddressEvm,
  isZeroish,
  normalizeAddressEvm,
} from '@hyperlane-xyz/utils';

import type { SignerAccount, TransactionCodec } from './types.js';

type ParsedTransaction = ReturnType<typeof ethers.utils.parseTransaction>;

function transactionType(transaction: ParsedTransaction): number {
  return transaction.type ?? 0;
}

function assertSupportedMetadata(metadata: ChainMetadata): void {
  if (metadata.technicalStack === ChainTechnicalStack.ZkSync) {
    throw new Error('zkSync transactions are not supported by HTTP signer');
  }
}

function parse(bytes: Uint8Array): ParsedTransaction {
  const transaction = ethers.utils.parseTransaction(bytes);
  if (![0, 1, 2].includes(transactionType(transaction))) {
    throw new Error(`Unsupported EVM transaction type ${transaction.type}`);
  }
  return transaction;
}

function normalizeAccessList(transaction: ParsedTransaction) {
  return (transaction.accessList ?? []).map((entry) => ({
    address: normalizeAddressEvm(entry.address),
    storageKeys: entry.storageKeys.map((key) => key.toLowerCase()),
  }));
}

function comparable(transaction: ParsedTransaction): Record<string, unknown> {
  return {
    type: transactionType(transaction),
    chainId: transaction.chainId,
    nonce: transaction.nonce,
    gasPrice: transaction.gasPrice?.toHexString(),
    maxFeePerGas: transaction.maxFeePerGas?.toHexString(),
    maxPriorityFeePerGas: transaction.maxPriorityFeePerGas?.toHexString(),
    gasLimit: transaction.gasLimit.toHexString(),
    to: transaction.to ? normalizeAddressEvm(transaction.to) : undefined,
    value: transaction.value.toHexString(),
    data: transaction.data.toLowerCase(),
    accessList: normalizeAccessList(transaction),
  };
}

function assertChainId(
  transaction: ParsedTransaction,
  metadata: ChainMetadata,
): void {
  const expected = Number(metadata.chainId);
  if (!Number.isSafeInteger(expected) || transaction.chainId !== expected) {
    throw new Error(
      `Transaction chain ID ${transaction.chainId} does not match ${metadata.name} (${metadata.chainId})`,
    );
  }
}

export class EvmTransactionCodec implements TransactionCodec {
  validateUnsigned(
    bytes: Uint8Array,
    metadata: ChainMetadata,
    account: SignerAccount,
  ): void {
    assertSupportedMetadata(metadata);
    if (account.curve !== 'secp256k1') {
      throw new Error('Ethereum signer must use secp256k1');
    }
    const transaction = parse(bytes);
    assertChainId(transaction, metadata);
    if (
      transaction.from ||
      (transaction.r && !isZeroish(transaction.r)) ||
      (transaction.s && !isZeroish(transaction.s))
    ) {
      throw new Error('Expected an unsigned EVM transaction');
    }
  }

  validateSigned(
    unsignedBytes: Uint8Array,
    signedBytes: Uint8Array,
    metadata: ChainMetadata,
    account: SignerAccount,
  ): Record<string, string | number | undefined> {
    const unsigned = parse(unsignedBytes);
    const signed = parse(signedBytes);
    assertChainId(signed, metadata);

    if (!signed.from)
      throw new Error('Backend returned an unsigned transaction');
    if (!eqAddressEvm(signed.from, account.address)) {
      throw new Error('Backend signed with an unexpected account');
    }
    if (!deepEquals(comparable(unsigned), comparable(signed))) {
      throw new Error('Backend changed transaction fields while signing');
    }

    return {
      chainId: signed.chainId,
      signer: signed.from,
      to: signed.to ?? undefined,
      value: signed.value.toString(),
      type: transactionType(signed),
      selector: signed.data.length >= 10 ? signed.data.slice(0, 10) : undefined,
    };
  }
}
