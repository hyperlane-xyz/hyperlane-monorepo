import {
  EvmHypCollateralFiatAdapter,
  EvmHypRebaseCollateralAdapter,
  EvmHypSyntheticAdapter,
  EvmHypSyntheticRebaseAdapter,
  EvmHypXERC20Adapter,
  EvmHypXERC20LockboxAdapter,
  EvmMovableCollateralAdapter,
  EvmHypNativeAdapter,
} from './EvmTokenAdapter.js';
import { EvmHypCrossCollateralAdapter } from './EvmCrossCollateralAdapter.js';
import type { IHypTokenAdapter } from './ITokenAdapter.js';
import {
  hasChainMetadata,
  hasOnlyHyperlaneConnections,
  type HypTokenAdapterInput,
} from './hypTokenAdapterUtils.js';
import type { ConfiguredMultiProtocolProvider as MultiProtocolProvider } from '../../providers/ConfiguredMultiProtocolProvider.js';
import { TokenStandard } from '../TokenStandard.js';

export function createEvmHypAdapter(
  multiProvider: MultiProtocolProvider<{ mailbox?: string }>,
  token: HypTokenAdapterInput,
): IHypTokenAdapter<unknown> | undefined {
  const { standard, chainName, addressOrDenom } = token;

  if (!standard || !hasChainMetadata(multiProvider, chainName)) {
    return undefined;
  }

  if (
    standard === TokenStandard.EvmNative &&
    hasOnlyHyperlaneConnections(token)
  ) {
    return new EvmHypNativeAdapter(chainName, multiProvider, {
      token: addressOrDenom,
    });
  }

  switch (standard) {
    case TokenStandard.EvmHypNative:
      return new EvmHypNativeAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case TokenStandard.EvmHypCollateral:
    case TokenStandard.EvmHypOwnerCollateral:
      return new EvmMovableCollateralAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case TokenStandard.EvmHypCrossCollateralRouter:
      return new EvmHypCrossCollateralAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case TokenStandard.EvmHypRebaseCollateral:
      return new EvmHypRebaseCollateralAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case TokenStandard.EvmHypCollateralFiat:
      return new EvmHypCollateralFiatAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case TokenStandard.EvmHypSynthetic:
      return new EvmHypSyntheticAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case TokenStandard.EvmHypSyntheticRebase:
      return new EvmHypSyntheticRebaseAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case TokenStandard.EvmHypXERC20:
    case TokenStandard.EvmHypVSXERC20:
      return new EvmHypXERC20Adapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case TokenStandard.EvmHypXERC20Lockbox:
    case TokenStandard.EvmHypVSXERC20Lockbox:
      return new EvmHypXERC20LockboxAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    default:
      return undefined;
  }
}
