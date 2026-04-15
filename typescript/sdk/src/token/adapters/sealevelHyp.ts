import { assert } from '@hyperlane-xyz/utils';

import type { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';

import {
  SealevelHypCollateralAdapter,
  SealevelHypNativeAdapter,
  SealevelHypSyntheticAdapter,
} from './SealevelTokenAdapter.js';
import type { IHypTokenAdapter } from './ITokenAdapter.js';
import {
  type HypTokenAdapterInput,
  hasChainMetadata,
} from './hypTokenAdapterUtils.js';
import { TokenStandard } from '../TokenStandard.js';
import { SealevelHypCrossCollateralAdapter } from './SealevelCrossCollateralAdapter.js';

export function createSealevelHypAdapter(
  multiProvider: MultiProviderAdapter<{ mailbox?: string }>,
  token: HypTokenAdapterInput,
): IHypTokenAdapter<unknown> | undefined {
  const { standard, chainName, addressOrDenom, collateralAddressOrDenom } =
    token;

  if (!standard || !hasChainMetadata(multiProvider, chainName)) {
    return undefined;
  }

  const mailbox = multiProvider.getChainMetadata(chainName).mailbox;

  switch (standard) {
    case TokenStandard.SealevelHypNative:
      assert(mailbox, 'Mailbox required for Sealevel hyp tokens');
      return new SealevelHypNativeAdapter(chainName, multiProvider, {
        warpRouter: addressOrDenom,
        mailbox,
      });
    case TokenStandard.SealevelHypCollateral:
      assert(mailbox, 'Mailbox required for Sealevel hyp tokens');
      assert(
        collateralAddressOrDenom,
        'collateralAddressOrDenom required for Sealevel hyp collateral tokens',
      );
      return new SealevelHypCollateralAdapter(chainName, multiProvider, {
        warpRouter: addressOrDenom,
        token: collateralAddressOrDenom,
        mailbox,
      });
    case TokenStandard.SealevelHypSynthetic:
      assert(mailbox, 'Mailbox required for Sealevel hyp tokens');
      assert(
        collateralAddressOrDenom,
        'collateralAddressOrDenom required for Sealevel hyp synthetic tokens',
      );
      return new SealevelHypSyntheticAdapter(chainName, multiProvider, {
        warpRouter: addressOrDenom,
        token: collateralAddressOrDenom,
        mailbox,
      });
    case TokenStandard.SealevelHypCrossCollateral:
      assert(mailbox, 'Mailbox required for Sealevel hyp tokens');
      assert(
        collateralAddressOrDenom,
        'collateralAddressOrDenom required for Sealevel hyp synthetic tokens',
      );
      return new SealevelHypCrossCollateralAdapter(chainName, multiProvider, {
        warpRouter: addressOrDenom,
        token: collateralAddressOrDenom,
        mailbox,
      });
    default:
      return undefined;
  }
}
