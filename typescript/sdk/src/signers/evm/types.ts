import {
  Address,
  Hex,
  SignableMessage,
  TransactionSerializable,
  isAddress,
} from 'viem';

import { assert } from '@hyperlane-xyz/utils';
export {
  TypedDataDomainLike,
  TypedDataFieldLike,
  TypedDataTypesLike,
  TypedDataValueLike,
  getTypedDataPrimaryType,
} from '../../utils/typedData.js';

export type ViemTransactionRequestLike = {
  chainId?: number;
  data?: Hex;
  from?: Address | string;
  gas?: unknown;
  gasLimit?: unknown;
  gasPrice?: unknown;
  maxFeePerGas?: unknown;
  maxPriorityFeePerGas?: unknown;
  nonce?: number;
  to?: Address | string;
  type?: number | string;
  value?: unknown;
};

type SupportedTransactionType = 'legacy' | 'eip2930' | 'eip1559' | undefined;

export const toBigIntValue = (value: unknown): bigint | undefined =>
  value === null || value === undefined ? undefined : BigInt(value.toString());

export function toViemAddress(
  value: string | Address | undefined,
): Address | undefined {
  if (!value) return undefined;
  assert(isAddress(value), `Invalid EVM address: ${value}`);
  return value;
}

export function toSignableMessage(
  message: string | Uint8Array,
): SignableMessage {
  return typeof message === 'string' ? message : { raw: message };
}

function normalizeTransactionType(
  type: ViemTransactionRequestLike['type'],
  maxFeePerGas?: unknown,
  maxPriorityFeePerGas?: unknown,
): SupportedTransactionType {
  if (type === undefined) {
    return maxFeePerGas || maxPriorityFeePerGas ? 'eip1559' : undefined;
  }
  if (type === 'legacy' || type === 0) return 'legacy';
  if (type === 'eip2930' || type === 1) return 'eip2930';
  if (type === 'eip1559' || type === 2) return 'eip1559';
  throw new Error(`Unsupported transaction type: ${String(type)}`);
}

export function toSerializableViemTransaction(
  request: ViemTransactionRequestLike,
): TransactionSerializable {
  const type = normalizeTransactionType(
    request.type,
    request.maxFeePerGas,
    request.maxPriorityFeePerGas,
  );
  const to = toViemAddress(request.to);
  const chainId = request.chainId;
  const nonce = request.nonce;
  const data = request.data;
  const gas = toBigIntValue(request.gas ?? request.gasLimit);
  const value = toBigIntValue(request.value);

  if (type === 'eip1559') {
    assert(chainId !== undefined, 'chainId required for eip1559 transactions');
    return {
      type,
      chainId,
      nonce,
      to,
      data,
      gas,
      value,
      maxFeePerGas: toBigIntValue(request.maxFeePerGas),
      maxPriorityFeePerGas: toBigIntValue(request.maxPriorityFeePerGas),
    };
  }

  if (type === 'eip2930') {
    assert(chainId !== undefined, 'chainId required for eip2930 transactions');
    return {
      type,
      chainId,
      nonce,
      to,
      data,
      gas,
      value,
      gasPrice: toBigIntValue(request.gasPrice),
    };
  }

  return {
    type,
    chainId,
    nonce,
    to,
    data,
    gas,
    value,
    gasPrice: toBigIntValue(request.gasPrice),
  };
}

export type ViemProviderLike = {
  estimateGas(transaction: ViemTransactionRequestLike): Promise<unknown>;
  getFeeData(): Promise<{
    gasPrice?: unknown;
    maxFeePerGas?: unknown;
    maxPriorityFeePerGas?: unknown;
  }>;
  getNetwork(): Promise<{ chainId: number }>;
  getTransactionCount(
    address: Address | string,
    blockTag?: string,
  ): Promise<number>;
  send?(method: string, params: unknown[]): Promise<unknown>;
  sendTransaction(signedTransaction: Hex | string): Promise<{
    hash: string;
    wait(confirmations?: number): Promise<unknown>;
  }>;
};
