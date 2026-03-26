import type { IHypTokenAdapter } from './ITokenAdapter.js';
import type { HypTokenAdapterInput } from './hypTokenAdapterUtils.js';
import { createEvmLikeHypAdapter } from './evmLikeHyp.js';
import type { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';
import { TokenStandard } from '../TokenStandard.js';

export function createTronHypAdapter(
  multiProvider: MultiProviderAdapter<{ mailbox?: string }>,
  token: HypTokenAdapterInput,
): IHypTokenAdapter<unknown> | undefined {
  return createEvmLikeHypAdapter(multiProvider, token, {
    native: TokenStandard.TronNative,
    hypNative: TokenStandard.TronHypNative,
    hypCollateral: [
      TokenStandard.TronHypCollateral,
      TokenStandard.TronHypOwnerCollateral,
    ],
    hypCrossCollateralRouter: TokenStandard.TronHypCrossCollateralRouter,
    hypRebaseCollateral: TokenStandard.TronHypRebaseCollateral,
    hypCollateralFiat: TokenStandard.TronHypCollateralFiat,
    hypSynthetic: TokenStandard.TronHypSynthetic,
    hypSyntheticRebase: TokenStandard.TronHypSyntheticRebase,
    hypXerc20: [TokenStandard.TronHypXERC20, TokenStandard.TronHypVSXERC20],
    hypXerc20Lockbox: [
      TokenStandard.TronHypXERC20Lockbox,
      TokenStandard.TronHypVSXERC20Lockbox,
    ],
  });
}
