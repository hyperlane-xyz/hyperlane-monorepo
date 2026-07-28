import { assert } from '@hyperlane-xyz/utils';
import type { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';

import { AleoProvider as RuntimeAleoProvider } from '../clients/provider.js';
import type { AleoSdk } from '../utils/provable.js';
import {
  AleoNetworkId,
  type AleoNetworkId as AleoNetworkIdValue,
  toAleoNetworkId,
} from '../utils/types.js';

export interface AleoProviderConstructor {
  new (
    rpcUrls: string[],
    chainId: string | number,
    chainMetadata: ChainMetadataForAltVM,
  ): RuntimeAleoProvider;
  connect(metadata: ChainMetadataForAltVM): Promise<RuntimeAleoProvider>;
}

export function createAleoProviderClass(
  sdk: AleoSdk,
  expectedNetwork: AleoNetworkIdValue,
): AleoProviderConstructor {
  const runtimeName =
    expectedNetwork === AleoNetworkId.MAINNET ? 'Mainnet' : 'Testnet';

  return class AleoProvider extends RuntimeAleoProvider {
    static async connect(metadata: ChainMetadataForAltVM) {
      const rpcUrls = (metadata.rpcUrls ?? []).map((rpc) => rpc.http);
      return new AleoProvider(rpcUrls, metadata.chainId, metadata);
    }

    constructor(
      rpcUrls: string[],
      chainId: string | number,
      chainMetadata: ChainMetadataForAltVM,
    ) {
      const networkId = toAleoNetworkId(+chainId);
      assert(
        networkId === expectedNetwork,
        `${runtimeName} runtime cannot serve Aleo chain id ${chainId}`,
      );
      super(rpcUrls, chainId, chainMetadata, sdk);
    }
  };
}
