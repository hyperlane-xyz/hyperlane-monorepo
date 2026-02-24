import { SendTransactionParameters } from '@wagmi/core';
import { BigNumberish, TransactionRequest } from 'ethers';

import { ChainMetadata, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

export function ethers5TxToWagmiTx(
  tx: TransactionRequest,
): SendTransactionParameters {
  if (!tx.to) throw new Error('No tx recipient address specified');
  return {
    to: String(tx.to) as `0x${string}`,
    value: ethersBnToBigInt(tx.value ?? 0n),
    data: tx.data as `0x${string}` | undefined,
    nonce: tx.nonce ?? undefined,
    chainId: tx.chainId != null ? Number(tx.chainId) : undefined,
    gas: tx.gasLimit ? ethersBnToBigInt(tx.gasLimit) : undefined,
    gasPrice: tx.gasPrice ? ethersBnToBigInt(tx.gasPrice) : undefined,
    maxFeePerGas: tx.maxFeePerGas
      ? ethersBnToBigInt(tx.maxFeePerGas)
      : undefined,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas
      ? ethersBnToBigInt(tx.maxPriorityFeePerGas)
      : undefined,
  };
}

function ethersBnToBigInt(bn: BigNumberish): bigint {
  return BigInt(bn.toString());
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
