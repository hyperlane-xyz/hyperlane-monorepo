import type { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';
import { isStarknetFeeToken } from '../../utils/starknet.js';

import {
  StarknetHypCollateralAdapter,
  StarknetHypFeeAdapter,
  StarknetHypNativeAdapter,
  StarknetHypSyntheticAdapter,
} from './StarknetTokenAdapter.js';
import type { IHypTokenAdapter } from './ITokenAdapter.js';
import {
  type HypTokenAdapterInput,
  hasChainMetadata,
} from './hypTokenAdapterUtils.js';
import { TokenStandard } from '../TokenStandard.js';

export function createStarknetHypAdapter(
  multiProvider: MultiProviderAdapter<{ mailbox?: string }>,
  token: HypTokenAdapterInput,
): IHypTokenAdapter<unknown> | undefined {
  const { standard, chainName, addressOrDenom } = token;

  if (!standard || !hasChainMetadata(multiProvider, chainName)) {
    return undefined;
  }

  if (
    isStarknetFeeToken(chainName, addressOrDenom) &&
    (standard === TokenStandard.StarknetHypNative ||
      standard === TokenStandard.StarknetHypSynthetic ||
      standard === TokenStandard.StarknetHypCollateral)
  ) {
    return new StarknetHypFeeAdapter(chainName, multiProvider, {
      warpRouter: addressOrDenom,
    });
  }

  switch (standard) {
    case TokenStandard.StarknetHypNative:
      return new StarknetHypNativeAdapter(chainName, multiProvider, {
        warpRouter: addressOrDenom,
      });
    case TokenStandard.StarknetHypSynthetic:
      return new StarknetHypSyntheticAdapter(chainName, multiProvider, {
        warpRouter: addressOrDenom,
      });
    case TokenStandard.StarknetHypCollateral:
      return new StarknetHypCollateralAdapter(chainName, multiProvider, {
        warpRouter: addressOrDenom,
      });
    default:
      return undefined;
  }
}
