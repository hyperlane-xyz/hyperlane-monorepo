import { defaultAleoProviderBuilder } from '../providers/builders/aleo.js';
import { ProviderType } from '../providers/ProviderType.js';
import { registerProviderBuilders } from '../providers/providerBuilderRegistry.js';
import { AleoNativeTokenAdapter } from '../token/adapters/AleoTokenAdapter.js';
import { createAleoHypAdapter } from '../token/adapters/aleoHyp.js';
import {
  registerHypTokenAdapterFactories,
  registerTokenAdapterFactories,
} from '../token/adapters/registry.js';
import { TokenStandard } from '../token/TokenStandard.js';

export function registerAleoRuntimeAdapters(): void {
  registerProviderBuilders({
    [ProviderType.Aleo]: defaultAleoProviderBuilder,
  });

  registerTokenAdapterFactories(
    [TokenStandard.AleoNative],
    ({ multiProvider, token }) =>
      new AleoNativeTokenAdapter(token.chainName, multiProvider, {
        token: token.addressOrDenom,
      }),
  );

  registerHypTokenAdapterFactories(
    [
      TokenStandard.AleoHypNative,
      TokenStandard.AleoHypCollateral,
      TokenStandard.AleoHypSynthetic,
    ],
    ({ multiProvider, token }) => createAleoHypAdapter(multiProvider, token),
  );
}
