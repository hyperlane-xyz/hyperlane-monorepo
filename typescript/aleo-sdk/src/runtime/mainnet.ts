import * as sdk from '@provablehq/sdk/mainnet.js';

import { assert } from '@hyperlane-xyz/utils';

import { AleoProvider as RuntimeAleoProvider } from '../clients/provider.js';
import { AleoNetworkId, toAleoNetworkId } from '../utils/types.js';

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
      networkId === AleoNetworkId.MAINNET,
      `Mainnet runtime cannot serve Aleo chain id ${chainId}`,
    );
    super(rpcUrls, chainId, sdk);
  }
}
