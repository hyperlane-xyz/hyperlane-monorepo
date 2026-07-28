import * as mainnetSdk from '@provablehq/sdk/mainnet.js';
import * as testnetSdk from '@provablehq/sdk/testnet.js';

import type { AleoSdk } from '../utils/provable.js';
import { AleoNetworkId, toAleoNetworkId } from '../utils/types.js';

import { AleoProvider as RuntimeAleoProvider } from './provider.js';

export class AleoProvider extends RuntimeAleoProvider {
  static async connect(
    rpcUrls: string[],
    chainId: string | number,
  ): Promise<AleoProvider> {
    return new AleoProvider(rpcUrls, chainId);
  }

  constructor(rpcUrls: string[], chainId: string | number) {
    const networkId = toAleoNetworkId(+chainId);
    // CAST: Both Provable network modules expose the same API, but private WASM
    // fields make their otherwise-compatible class types nominal.
    const sdk = (networkId === AleoNetworkId.MAINNET
      ? mainnetSdk
      : testnetSdk) as unknown as AleoSdk;
    super(rpcUrls, chainId, sdk);
  }
}
