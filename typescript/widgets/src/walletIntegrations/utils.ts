import { SendTransactionParameters } from '@wagmi/core';

import { ChainMetadata, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

type EvmTransactionLike = {
  to?: string | null;
  value?: bigint | string | number;
  data?: `0x${string}` | string;
  nonce?: number;
  chainId?: number;
  gas?: bigint | string | number;
  gasLimit?: bigint | string | number;
  gasPrice?: bigint | string | number;
  maxFeePerGas?: bigint | string | number;
  maxPriorityFeePerGas?: bigint | string | number;
};

export function ethers5TxToWagmiTx(
  tx: EvmTransactionLike,
): SendTransactionParameters {
  if (!tx.to) throw new Error('No tx recipient address specified');
  return {
    to: tx.to as `0x${string}`,
    value: toBigInt(tx.value ?? 0n),
    data: tx.data as `0x{string}` | undefined,
    nonce: tx.nonce,
    chainId: tx.chainId,
    gas: tx.gasLimit ? toBigInt(tx.gasLimit) : tx.gas ? toBigInt(tx.gas) : undefined,
    gasPrice: tx.gasPrice ? toBigInt(tx.gasPrice) : undefined,
    maxFeePerGas: tx.maxFeePerGas ? toBigInt(tx.maxFeePerGas) : undefined,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas
      ? toBigInt(tx.maxPriorityFeePerGas)
      : undefined,
  };
}

function toBigInt(value: bigint | string | number): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
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
