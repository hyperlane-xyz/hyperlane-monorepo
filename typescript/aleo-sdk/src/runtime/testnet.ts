import * as testnetSdk from '@provablehq/sdk/testnet.js';

import { assert } from '@hyperlane-xyz/utils';

import { AleoProvider as RuntimeAleoProvider } from '../clients/provider.js';
import type { AleoSdk } from '../utils/provable.js';
import { AleoNetworkId, toAleoNetworkId } from '../utils/types.js';

// CAST: Both Provable network modules expose the same API, but private WASM
// fields make their otherwise-compatible class types nominal.
const sdk = testnetSdk as unknown as AleoSdk;

export class AleoProvider extends RuntimeAleoProvider {
  static async connect(
    rpcUrls: string[],
    chainId: string | number,
  ): Promise<AleoProvider> {
    return new AleoProvider(rpcUrls, chainId);
  }

  constructor(rpcUrls: string[], chainId: string | number) {
    const networkId = toAleoNetworkId(+chainId);
    assert(
      networkId === AleoNetworkId.TESTNET,
      `Testnet runtime cannot serve Aleo chain id ${chainId}`,
    );
    super(rpcUrls, chainId, sdk);
  }
}
