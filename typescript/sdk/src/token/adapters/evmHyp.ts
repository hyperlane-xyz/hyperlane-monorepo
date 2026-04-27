import type { IHypTokenAdapter } from './ITokenAdapter.js';
import type { HypTokenAdapterInput } from './hypTokenAdapterUtils.js';
import { createEvmLikeHypAdapter } from './evmLikeHyp.js';
import type { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';
import { TokenStandard } from '../TokenStandard.js';

export function createEvmHypAdapter(
  multiProvider: MultiProviderAdapter<{ mailbox?: string }>,
  token: HypTokenAdapterInput,
): IHypTokenAdapter<unknown> | undefined {
  return createEvmLikeHypAdapter(multiProvider, token, {
    native: TokenStandard.EvmNative,
    hypNative: TokenStandard.EvmHypNative,
    hypCollateral: [
      TokenStandard.EvmHypCollateral,
      TokenStandard.EvmHypOwnerCollateral,
    ],
    hypCrossCollateralRouter: TokenStandard.EvmHypCrossCollateralRouter,
    hypRebaseCollateral: TokenStandard.EvmHypRebaseCollateral,
    hypCollateralFiat: TokenStandard.EvmHypCollateralFiat,
    hypSynthetic: TokenStandard.EvmHypSynthetic,
    hypSyntheticRebase: TokenStandard.EvmHypSyntheticRebase,
    hypXerc20: [TokenStandard.EvmHypXERC20, TokenStandard.EvmHypVSXERC20],
    hypXerc20Lockbox: [
      TokenStandard.EvmHypXERC20Lockbox,
      TokenStandard.EvmHypVSXERC20Lockbox,
    ],
  });
}
