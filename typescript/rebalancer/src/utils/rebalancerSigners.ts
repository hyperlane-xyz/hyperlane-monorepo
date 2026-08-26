import { Wallet } from 'ethers';

import { type MultiProvider } from '@hyperlane-xyz/sdk';
import { TronWallet } from '@hyperlane-xyz/tron-sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

export interface RebalancerSignerSetup {
  address: string;
  tronChains: string[];
}

/**
 * Configure the shared rebalancer key with the protocol-specific signer needed
 * by each strategy chain. Tron cannot broadcast through eth_sendRawTransaction,
 * so it must use TronWallet instead of a connected ethers Wallet.
 */
export function configureRebalancerSigners(
  multiProvider: MultiProvider,
  chains: string[],
  privateKey: string,
): RebalancerSignerSetup {
  const evmSigner = new Wallet(privateKey);
  const tronChains: string[] = [];

  for (const chain of new Set(chains)) {
    const metadata = multiProvider.getChainMetadata(chain);

    if (metadata.protocol === ProtocolType.Tron) {
      assert(metadata.rpcUrls.length, `No RPC URLs configured for ${chain}`);
      multiProvider.setSigner(
        chain,
        new TronWallet(privateKey, metadata.rpcUrls[0].http),
      );
      tronChains.push(chain);
    } else {
      multiProvider.setSigner(chain, evmSigner);
    }
  }

  return { address: evmSigner.address, tronChains };
}
