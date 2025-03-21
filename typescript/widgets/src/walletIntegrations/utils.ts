import { SendTransactionParameters } from '@wagmi/core';
import {
  PopulatedTransaction as Ethers5Transaction,
  BigNumber as EthersBN,
} from 'ethers';

import { ChainMetadata, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

export function ethers5TxToWagmiTx(
  tx: Ethers5Transaction,
): SendTransactionParameters {
  if (!tx.to) throw new Error('No tx recipient address specified');
  return {
    to: tx.to as `0x${string}`,
    value: ethersBnToBigInt(tx.value || EthersBN.from('0')),
    data: tx.data as `0x{string}` | undefined,
    nonce: tx.nonce,
    chainId: tx.chainId,
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

function ethersBnToBigInt(bn: EthersBN): bigint {
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
