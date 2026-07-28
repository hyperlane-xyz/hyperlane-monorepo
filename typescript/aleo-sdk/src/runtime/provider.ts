import { assert } from '@hyperlane-xyz/utils';

import { AleoProvider as RuntimeAleoProvider } from '../clients/provider.js';
import type { AleoSdk } from '../utils/provable.js';
import {
  AleoNetworkId,
  type AleoNetworkId as AleoNetworkIdValue,
  toAleoNetworkId,
} from '../utils/types.js';

export interface AleoProviderConstructor {
  new (rpcUrls: string[], chainId: string | number): RuntimeAleoProvider;
  connect(
    rpcUrls: string[],
    chainId: string | number,
  ): Promise<RuntimeAleoProvider>;
}

export function createAleoProviderClass(
  sdk: AleoSdk,
  expectedNetwork: AleoNetworkIdValue,
): AleoProviderConstructor {
  const runtimeName =
    expectedNetwork === AleoNetworkId.MAINNET ? 'Mainnet' : 'Testnet';

  return class AleoProvider extends RuntimeAleoProvider {
    static async connect(rpcUrls: string[], chainId: string | number) {
      return new AleoProvider(rpcUrls, chainId);
    }

    constructor(rpcUrls: string[], chainId: string | number) {
      const networkId = toAleoNetworkId(+chainId);
      assert(
        networkId === expectedNetwork,
        `${runtimeName} runtime cannot serve Aleo chain id ${chainId}`,
      );
      super(rpcUrls, chainId, sdk);
    }
  };
}
