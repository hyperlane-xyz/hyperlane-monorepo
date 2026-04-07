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

  if (standard === standards.hypNative) {
    return new EvmHypNativeAdapter(chainName, multiProvider, {
      token: addressOrDenom,
    });
  }

  if (standards.hypCollateral.some((candidate) => candidate === standard)) {
    return new EvmMovableCollateralAdapter(chainName, multiProvider, {
      token: addressOrDenom,
    });
  }

  if (standard === standards.hypCrossCollateralRouter) {
    return new EvmHypCrossCollateralAdapter(chainName, multiProvider, {
      token: addressOrDenom,
    });
  }

  if (standard === standards.hypRebaseCollateral) {
    return new EvmHypRebaseCollateralAdapter(chainName, multiProvider, {
      token: addressOrDenom,
    });
  }

  if (standard === standards.hypCollateralFiat) {
    return new EvmHypCollateralFiatAdapter(chainName, multiProvider, {
      token: addressOrDenom,
    });
  }

  if (standard === standards.hypSynthetic) {
    return new EvmHypSyntheticAdapter(chainName, multiProvider, {
      token: addressOrDenom,
    });
  }

  if (standard === standards.hypSyntheticRebase) {
    return new EvmHypSyntheticRebaseAdapter(chainName, multiProvider, {
      token: addressOrDenom,
    });
  }

  if (standards.hypXerc20.some((candidate) => candidate === standard)) {
    return new EvmHypXERC20Adapter(chainName, multiProvider, {
      token: addressOrDenom,
    });
  }

  if (standards.hypXerc20Lockbox.some((candidate) => candidate === standard)) {
    return new EvmHypXERC20LockboxAdapter(chainName, multiProvider, {
      token: addressOrDenom,
    });
  }

  return undefined;
}
