import { assert } from '@hyperlane-xyz/utils';

import type { ConfiguredMultiProtocolProvider as MultiProtocolProvider } from '../../providers/ConfiguredMultiProtocolProvider.js';

import {
  CwHypCollateralAdapter,
  CwHypNativeAdapter,
  CwHypSyntheticAdapter,
} from './CosmWasmTokenAdapter.js';
import {
  CosmNativeHypCollateralAdapter,
  CosmNativeHypSyntheticAdapter,
} from './CosmosModuleTokenAdapter.js';
import type { IHypTokenAdapter } from './ITokenAdapter.js';
import {
  type HypTokenAdapterInput,
  hasChainMetadata,
} from './hypTokenAdapterUtils.js';
import { TokenStandard } from '../TokenStandard.js';

export function createCosmosHypAdapter(
  multiProvider: MultiProtocolProvider<{ mailbox?: string }>,
  token: HypTokenAdapterInput,
): IHypTokenAdapter<unknown> | undefined {
  const { standard, chainName, addressOrDenom, collateralAddressOrDenom } =
    token;

  if (!standard || !hasChainMetadata(multiProvider, chainName)) {
    return undefined;
  }

  switch (standard) {
    case TokenStandard.CwHypNative:
      return new CwHypNativeAdapter(chainName, multiProvider, {
        warpRouter: addressOrDenom,
      });
    case TokenStandard.CwHypCollateral:
      assert(
        collateralAddressOrDenom,
        'collateralAddressOrDenom required for CwHypCollateral',
      );
      return new CwHypCollateralAdapter(chainName, multiProvider, {
        warpRouter: addressOrDenom,
        token: collateralAddressOrDenom,
      });
    case TokenStandard.CwHypSynthetic:
      assert(
        collateralAddressOrDenom,
        'collateralAddressOrDenom required for CwHypSynthetic',
      );
      return new CwHypSyntheticAdapter(chainName, multiProvider, {
        warpRouter: addressOrDenom,
        token: collateralAddressOrDenom,
      });
    case TokenStandard.CosmNativeHypCollateral:
      return new CosmNativeHypCollateralAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case TokenStandard.CosmNativeHypSynthetic:
      return new CosmNativeHypSyntheticAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    default:
      return undefined;
  }
}
