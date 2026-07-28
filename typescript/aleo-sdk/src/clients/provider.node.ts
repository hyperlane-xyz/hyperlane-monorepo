import * as mainnetSdk from '@provablehq/sdk/mainnet.js';
import * as testnetSdk from '@provablehq/sdk/testnet.js';

import type { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';

import type { AleoSdk } from '../utils/provable.js';
import { AleoNetworkId, toAleoNetworkId } from '../utils/types.js';

import { AleoProvider as RuntimeAleoProvider } from './provider.js';

export class AleoProvider extends RuntimeAleoProvider {
  static async connect(metadata: ChainMetadataForAltVM): Promise<AleoProvider> {
    const rpcUrls = (metadata.rpcUrls ?? []).map((rpc) => rpc.http);
    return new AleoProvider(rpcUrls, metadata.chainId, metadata);
  }

  constructor(
    rpcUrls: string[],
    chainId: string | number,
    chainMetadata: ChainMetadataForAltVM,
  ) {
    const networkId = toAleoNetworkId(+chainId);
    // CAST: Both Provable network modules expose the same API, but private WASM
    // fields make their otherwise-compatible class types nominal.
    const sdk = (networkId === AleoNetworkId.MAINNET
      ? mainnetSdk
      : testnetSdk) as unknown as AleoSdk;
    super(rpcUrls, chainId, chainMetadata, sdk);
  }
}
