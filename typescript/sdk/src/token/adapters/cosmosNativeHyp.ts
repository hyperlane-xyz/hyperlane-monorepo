import type { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';

import { TokenStandard } from '../TokenStandard.js';

import {
  CosmNativeHypCollateralAdapter,
  CosmNativeHypSyntheticAdapter,
} from './CosmosModuleTokenAdapter.js';
import type { IHypTokenAdapter } from './ITokenAdapter.js';
import {
  type HypTokenAdapterInput,
  hasChainMetadata,
} from './hypTokenAdapterUtils.js';

export function createCosmosNativeHypAdapter(
  multiProvider: MultiProviderAdapter<{ mailbox?: string }>,
  token: HypTokenAdapterInput,
): IHypTokenAdapter<unknown> | undefined {
  const { standard, chainName, addressOrDenom } = token;

  if (!standard || !hasChainMetadata(multiProvider, chainName)) {
    return undefined;
  }

  switch (standard) {
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
