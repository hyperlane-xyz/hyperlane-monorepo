import type { ConfiguredMultiProtocolProvider as MultiProtocolProvider } from '../../providers/ConfiguredMultiProtocolProvider.js';

import {
  AleoHypCollateralAdapter,
  AleoHypNativeAdapter,
  AleoHypSyntheticAdapter,
} from './AleoTokenAdapter.js';
import type { IHypTokenAdapter } from './ITokenAdapter.js';
import {
  type HypTokenAdapterInput,
  hasChainMetadata,
} from './hypTokenAdapterUtils.js';
import { TokenStandard } from '../TokenStandard.js';

export function createAleoHypAdapter(
  multiProvider: MultiProtocolProvider<{ mailbox?: string }>,
  token: HypTokenAdapterInput,
): IHypTokenAdapter<unknown> | undefined {
  const { standard, chainName, addressOrDenom } = token;

  if (!standard || !hasChainMetadata(multiProvider, chainName)) {
    return undefined;
  }

  switch (standard) {
    case TokenStandard.AleoHypNative:
      return new AleoHypNativeAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case TokenStandard.AleoHypCollateral:
      return new AleoHypCollateralAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case TokenStandard.AleoHypSynthetic:
      return new AleoHypSyntheticAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    default:
      return undefined;
  }
}
