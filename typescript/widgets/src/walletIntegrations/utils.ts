import { SendTransactionParameters } from '@wagmi/core';
import {
  PopulatedTransaction as Ethers5Transaction,
  BigNumber as EthersBN,
} from 'ethers';

import type { ChainMetadata } from '@hyperlane-xyz/sdk/metadata/chainMetadataTypes';
import type { ChainMetadataManager } from '@hyperlane-xyz/sdk/metadata/ChainMetadataManager';
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
  chainMetadata: ChainMetadataManager,
  protocol: ProtocolType,
): ChainMetadata[] {
  return Object.values(chainMetadata.metadata).filter(
    (c) => c.protocol === protocol,
  );
}

export function findChainByRpcUrl(
  chainMetadata: ChainMetadataManager,
  url?: string,
) {
  if (!url) return undefined;
  const allMetadata = Object.values(chainMetadata.metadata);
  const searchUrl = url.toLowerCase();
  return allMetadata.find(
    (m) =>
      !!m.rpcUrls.find((rpc) => rpc.http.toLowerCase().includes(searchUrl)),
  );
}
