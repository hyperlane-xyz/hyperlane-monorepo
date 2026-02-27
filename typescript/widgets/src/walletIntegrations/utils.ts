import { SendTransactionParameters } from '@wagmi/core';

import { ChainMetadata, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, toBigInt } from '@hyperlane-xyz/utils';

type EvmBigNumberish = string | number | bigint | { toString(): string };

type EvmTransactionLike = {
  to?: string | null;
  value?: unknown;
  data?: `0x${string}` | string;
  nonce?: EvmBigNumberish;
  chainId?: EvmBigNumberish;
  gas?: unknown;
  gasLimit?: unknown;
  gasPrice?: unknown;
  maxFeePerGas?: unknown;
  maxPriorityFeePerGas?: unknown;
};

function toSafeInteger(
  value: EvmBigNumberish | undefined,
  fieldName: string,
): number | undefined {
  if (value === undefined) return undefined;
  const numericValue = Number(toBigInt(value));
  assert(Number.isSafeInteger(numericValue), `Invalid ${fieldName}: ${value}`);
  return numericValue;
}

export function ethers5TxToWagmiTx(
  tx: EvmTransactionLike,
): SendTransactionParameters {
  if (!tx.to) throw new Error('No tx recipient address specified');
  return {
    to: tx.to as `0x${string}`,
    value: toBigInt(tx.value ?? 0n),
    data: tx.data as `0x${string}` | undefined,
    nonce: toSafeInteger(tx.nonce, 'nonce'),
    chainId: toSafeInteger(tx.chainId, 'chainId'),
    gas: tx.gasLimit
      ? toBigInt(tx.gasLimit)
      : tx.gas
        ? toBigInt(tx.gas)
        : undefined,
    gasPrice: tx.gasPrice ? toBigInt(tx.gasPrice) : undefined,
    maxFeePerGas: tx.maxFeePerGas ? toBigInt(tx.maxFeePerGas) : undefined,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas
      ? toBigInt(tx.maxPriorityFeePerGas)
      : undefined,
  };
}

export function getChainsForProtocol(
  multiProvider: MultiProtocolProvider,
  protocol: ProtocolType,
): ChainMetadata[] {
  return Object.values(multiProvider.metadata).filter(
    (c) => c.protocol === protocol,
  );
}

export function findChainByRpcUrl(
  multiProvider: MultiProtocolProvider,
  url?: string,
) {
  if (!url) return undefined;
  const allMetadata = Object.values(multiProvider.metadata);
  const searchUrl = url.toLowerCase();
  return allMetadata.find(
    (m) =>
      !!m.rpcUrls.find((rpc) => rpc.http.toLowerCase().includes(searchUrl)),
  );
}
