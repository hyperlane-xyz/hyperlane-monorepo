import { assert } from '@hyperlane-xyz/utils';

import {
  defaultCosmJsNativeProviderBuilder,
  defaultCosmJsProviderBuilder,
  defaultCosmJsWasmProviderBuilder,
} from '../providers/builders/cosmos.js';
import { ProviderType } from '../providers/ProviderType.js';
import { registerProviderBuilders } from '../providers/providerBuilderRegistry.js';
import {
  CwNativeTokenAdapter,
  CwTokenAdapter,
} from '../token/adapters/CosmWasmTokenAdapter.js';
import { CosmNativeTokenAdapter } from '../token/adapters/CosmosTokenAdapter.js';
import { createCosmosHypAdapter } from '../token/adapters/cosmosHyp.js';
import {
  createDefaultIbcTokenAdapter,
  createIbcHypAdapter,
} from '../token/adapters/ibc.js';
import {
  registerHypTokenAdapterFactories,
  registerTokenAdapterFactories,
} from '../token/adapters/registry.js';
import { TokenStandard } from '../token/TokenStandard.js';

export function registerCosmosRuntimeAdapters(): void {
  registerProviderBuilders({
    [ProviderType.CosmJs]: defaultCosmJsProviderBuilder,
    [ProviderType.CosmJsWasm]: defaultCosmJsWasmProviderBuilder,
    [ProviderType.CosmJsNative]: defaultCosmJsNativeProviderBuilder,
  });

  registerTokenAdapterFactories(
    [TokenStandard.CosmosNative],
    ({ multiProvider, token }) =>
      new CosmNativeTokenAdapter(
        token.chainName,
        multiProvider,
        {},
        { ibcDenom: token.addressOrDenom },
      ),
  );

  registerTokenAdapterFactories(
    [TokenStandard.CW20],
    ({ multiProvider, token }) =>
      new CwTokenAdapter(token.chainName, multiProvider, {
        token: token.addressOrDenom,
      }),
  );

  registerTokenAdapterFactories(
    [TokenStandard.CWNative],
    ({ multiProvider, token }) =>
      new CwNativeTokenAdapter(
        token.chainName,
        multiProvider,
        {},
        token.addressOrDenom,
      ),
  );

  registerTokenAdapterFactories(
    [TokenStandard.CosmosIbc],
    ({ multiProvider, token }) =>
      createDefaultIbcTokenAdapter(token, multiProvider),
  );

  registerHypTokenAdapterFactories(
    [
      TokenStandard.CwHypNative,
      TokenStandard.CwHypCollateral,
      TokenStandard.CwHypSynthetic,
      TokenStandard.CosmNativeHypCollateral,
      TokenStandard.CosmNativeHypSynthetic,
    ],
    ({ multiProvider, token }) => createCosmosHypAdapter(multiProvider, token),
  );

  registerHypTokenAdapterFactories(
    [TokenStandard.CosmosIbc],
    ({ destination, multiProvider, token }) => {
      assert(destination, 'destination required for IBC token adapters');
      return createIbcHypAdapter(token, multiProvider, destination);
    },
  );
}
