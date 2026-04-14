import { ProtocolType } from '@hyperlane-xyz/utils';

import { defaultRadixProviderBuilder } from '../providers/builders/radix.js';
import { ProviderType } from '../providers/ProviderType.js';
import { registerProviderBuilders } from '../providers/providerBuilderRegistry.js';
import {
  RadixNativeTokenAdapter,
  RadixTokenAdapter,
} from '../token/adapters/RadixTokenAdapter.js';
import { createRadixHypAdapter } from '../token/adapters/radixHyp.js';
import {
  registerCollateralTokenAdapterFactories,
  registerHypTokenAdapterFactories,
  registerTokenAdapterFactories,
} from '../token/adapters/registry.js';
import { TokenStandard } from '../token/TokenStandard.js';

export function registerRadixRuntimeAdapters(): void {
  registerProviderBuilders({
    [ProviderType.Radix]: defaultRadixProviderBuilder,
  });

  registerTokenAdapterFactories(
    [TokenStandard.RadixNative],
    ({ multiProvider, token }) =>
      new RadixNativeTokenAdapter(token.chainName, multiProvider, {
        token: token.addressOrDenom,
      }),
  );

  registerHypTokenAdapterFactories(
    [TokenStandard.RadixHypCollateral, TokenStandard.RadixHypSynthetic],
    ({ multiProvider, token }) => createRadixHypAdapter(multiProvider, token),
  );

  registerCollateralTokenAdapterFactories(
    [ProtocolType.Radix],
    ({ chainName, multiProvider, tokenAddress }) =>
      new RadixTokenAdapter(chainName, multiProvider, { token: tokenAddress }),
  );
}
