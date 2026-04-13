import { ProtocolType } from '@hyperlane-xyz/utils';

import { defaultSolProviderBuilder } from '../providers/builders/solana.js';
import { ProviderType } from '../providers/ProviderType.js';
import { registerProviderBuilders } from '../providers/providerBuilderRegistry.js';
import {
  SealevelNativeTokenAdapter,
  SealevelTokenAdapter,
} from '../token/adapters/SealevelTokenAdapter.js';
import { createSealevelHypAdapter } from '../token/adapters/sealevelHyp.js';
import {
  registerCollateralTokenAdapterFactories,
  registerHypTokenAdapterFactories,
  registerTokenAdapterFactories,
} from '../token/adapters/registry.js';
import { TokenStandard } from '../token/TokenStandard.js';

export function registerSealevelRuntimeAdapters(): void {
  registerProviderBuilders({
    [ProviderType.SolanaWeb3]: defaultSolProviderBuilder,
  });

  registerTokenAdapterFactories(
    [TokenStandard.SealevelSpl, TokenStandard.SealevelSpl2022],
    ({ multiProvider, token }) =>
      new SealevelTokenAdapter(token.chainName, multiProvider, {
        token: token.addressOrDenom,
      }),
  );

  registerTokenAdapterFactories(
    [TokenStandard.SealevelNative],
    ({ multiProvider, token }) =>
      new SealevelNativeTokenAdapter(token.chainName, multiProvider, {}),
  );

  registerHypTokenAdapterFactories(
    [
      TokenStandard.SealevelHypNative,
      TokenStandard.SealevelHypCollateral,
      TokenStandard.SealevelHypSynthetic,
      TokenStandard.SealevelHypCrossCollateral,
    ],
    ({ multiProvider, token }) =>
      createSealevelHypAdapter(multiProvider, token),
  );

  registerCollateralTokenAdapterFactories(
    [ProtocolType.Sealevel],
    ({ chainName, multiProvider, tokenAddress }) =>
      new SealevelTokenAdapter(chainName, multiProvider, {
        token: tokenAddress,
      }),
  );
}
