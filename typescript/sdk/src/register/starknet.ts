import { ProtocolType } from '@hyperlane-xyz/utils';

import { defaultStarknetJsProviderBuilder } from '../providers/builders/starknet.js';
import { ProviderType } from '../providers/ProviderType.js';
import { registerProviderBuilders } from '../providers/providerBuilderRegistry.js';
import { StarknetTokenAdapter } from '../token/adapters/StarknetTokenAdapter.js';
import { createStarknetHypAdapter } from '../token/adapters/starknetHyp.js';
import {
  registerCollateralTokenAdapterFactories,
  registerHypTokenAdapterFactories,
  registerTokenAdapterFactories,
} from '../token/adapters/registry.js';
import { TokenStandard } from '../token/TokenStandard.js';

export function registerStarknetRuntimeAdapters(): void {
  registerProviderBuilders({
    [ProviderType.Starknet]: defaultStarknetJsProviderBuilder,
  });

  registerTokenAdapterFactories(
    [TokenStandard.StarknetNative],
    ({ multiProvider, token }) =>
      new StarknetTokenAdapter(token.chainName, multiProvider, {
        tokenAddress: token.addressOrDenom,
      }),
  );

  registerHypTokenAdapterFactories(
    [
      TokenStandard.StarknetHypNative,
      TokenStandard.StarknetHypCollateral,
      TokenStandard.StarknetHypSynthetic,
    ],
    ({ multiProvider, token }) =>
      createStarknetHypAdapter(multiProvider, token),
  );

  registerCollateralTokenAdapterFactories(
    [ProtocolType.Starknet],
    ({ chainName, multiProvider, tokenAddress }) =>
      new StarknetTokenAdapter(chainName, multiProvider, {
        tokenAddress,
      }),
  );
}
