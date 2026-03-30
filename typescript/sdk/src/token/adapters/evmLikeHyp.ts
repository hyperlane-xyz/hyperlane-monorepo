import {
  EvmHypCollateralFiatAdapter,
  EvmHypNativeAdapter,
  EvmHypRebaseCollateralAdapter,
  EvmHypSyntheticAdapter,
  EvmHypSyntheticRebaseAdapter,
  EvmHypXERC20Adapter,
  EvmHypXERC20LockboxAdapter,
  EvmMovableCollateralAdapter,
} from './EvmTokenAdapter.js';
import { EvmHypCrossCollateralAdapter } from './EvmCrossCollateralAdapter.js';
import type { IHypTokenAdapter } from './ITokenAdapter.js';
import {
  hasChainMetadata,
  hasOnlyHyperlaneConnections,
  type HypTokenAdapterInput,
} from './hypTokenAdapterUtils.js';
import type { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';
import type { TokenStandard } from '../TokenStandard.js';

interface EvmLikeHypAdapterStandards {
  native: TokenStandard;
  hypNative: TokenStandard;
  hypCollateral: readonly TokenStandard[];
  hypCrossCollateralRouter: TokenStandard;
  hypRebaseCollateral: TokenStandard;
  hypCollateralFiat: TokenStandard;
  hypSynthetic: TokenStandard;
  hypSyntheticRebase: TokenStandard;
  hypXerc20: readonly TokenStandard[];
  hypXerc20Lockbox: readonly TokenStandard[];
}

export function createEvmLikeHypAdapter(
  multiProvider: MultiProviderAdapter<{ mailbox?: string }>,
  token: HypTokenAdapterInput,
  standards: EvmLikeHypAdapterStandards,
): IHypTokenAdapter<unknown> | undefined {
  const { standard, chainName, addressOrDenom } = token;

  if (!standard || !hasChainMetadata(multiProvider, chainName)) {
    return undefined;
  }

  if (standard === standards.native && hasOnlyHyperlaneConnections(token)) {
    return new EvmHypNativeAdapter(chainName, multiProvider, {
      token: addressOrDenom,
    });
  }

  switch (standard) {
    case standards.hypNative:
      return new EvmHypNativeAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case standards.hypCollateral[0]:
    case standards.hypCollateral[1]:
      return new EvmMovableCollateralAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case standards.hypCrossCollateralRouter:
      return new EvmHypCrossCollateralAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case standards.hypRebaseCollateral:
      return new EvmHypRebaseCollateralAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case standards.hypCollateralFiat:
      return new EvmHypCollateralFiatAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case standards.hypSynthetic:
      return new EvmHypSyntheticAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case standards.hypSyntheticRebase:
      return new EvmHypSyntheticRebaseAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case standards.hypXerc20[0]:
    case standards.hypXerc20[1]:
      return new EvmHypXERC20Adapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    case standards.hypXerc20Lockbox[0]:
    case standards.hypXerc20Lockbox[1]:
      return new EvmHypXERC20LockboxAdapter(chainName, multiProvider, {
        token: addressOrDenom,
      });
    default:
      return undefined;
  }
}
