import type { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';

import {
  RadixHypCollateralAdapter,
  RadixHypSyntheticAdapter,
} from './RadixTokenAdapter.js';
import type { IHypTokenAdapter } from './ITokenAdapter.js';
import {
  type HypTokenAdapterInput,
  hasChainMetadata,
} from './hypTokenAdapterUtils.js';
import { TokenStandard } from '../TokenStandard.js';

export function createRadixHypAdapter(
  multiProvider: MultiProviderAdapter<{ mailbox?: string }>,
  token: HypTokenAdapterInput,
): IHypTokenAdapter<unknown> | undefined {
  const { standard, chainName, addressOrDenom } = token;

  if (!standard || !hasChainMetadata(multiProvider, chainName)) {
    return undefined;
  }

  switch (standard) {
    case TokenStandard.RadixHypCollateral:
      return new RadixHypCollateralAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case TokenStandard.RadixHypSynthetic:
      return new RadixHypSyntheticAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    default:
      return undefined;
  }
}
