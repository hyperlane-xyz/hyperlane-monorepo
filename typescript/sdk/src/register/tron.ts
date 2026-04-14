import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import {
  defaultTronEthersProviderBuilder,
  defaultTronProviderBuilder,
} from '../providers/builders/tron.js';
import { ProviderType } from '../providers/ProviderType.js';
import {
  registerProtocolProviderBuilders,
  registerProviderBuilders,
} from '../providers/providerBuilderRegistry.js';
import {
  EvmNativeTokenAdapter,
  EvmTokenAdapter,
} from '../token/adapters/EvmTokenAdapter.js';
import { M0PortalLiteTokenAdapter } from '../token/adapters/M0PortalLiteTokenAdapter.js';
import { createTronHypAdapter } from '../token/adapters/tronHyp.js';
import {
  registerCollateralTokenAdapterFactories,
  registerHypTokenAdapterFactories,
  registerTokenAdapterFactories,
} from '../token/adapters/registry.js';
import { TokenStandard } from '../token/TokenStandard.js';

export function registerTronRuntimeAdapters(): void {
  registerProviderBuilders({
    [ProviderType.Tron]: defaultTronProviderBuilder,
  });

  registerProtocolProviderBuilders(ProtocolType.Tron, {
    [ProviderType.EthersV5]: (urls, chainId) => ({
      type: ProviderType.EthersV5,
      provider: defaultTronEthersProviderBuilder(urls, chainId),
    }),
  });

  registerTokenAdapterFactories(
    [TokenStandard.TRC20],
    ({ multiProvider, token }) =>
      new EvmTokenAdapter(token.chainName, multiProvider, {
        token: token.addressOrDenom,
      }),
  );

  registerTokenAdapterFactories(
    [TokenStandard.TronNative],
    ({ multiProvider, token }) =>
      new EvmNativeTokenAdapter(token.chainName, multiProvider, {}),
  );

  registerHypTokenAdapterFactories(
    [
      TokenStandard.TronNative,
      TokenStandard.TronHypNative,
      TokenStandard.TronHypCollateral,
      TokenStandard.TronHypOwnerCollateral,
      TokenStandard.TronHypRebaseCollateral,
      TokenStandard.TronHypCollateralFiat,
      TokenStandard.TronHypSynthetic,
      TokenStandard.TronHypSyntheticRebase,
      TokenStandard.TronHypXERC20,
      TokenStandard.TronHypXERC20Lockbox,
      TokenStandard.TronHypVSXERC20,
      TokenStandard.TronHypVSXERC20Lockbox,
      TokenStandard.TronHypCrossCollateralRouter,
    ],
    ({ multiProvider, token }) => createTronHypAdapter(multiProvider, token),
  );

  registerHypTokenAdapterFactories(
    [TokenStandard.TronM0PortalLite],
    ({ multiProvider, token }) => {
      assert(
        token.collateralAddressOrDenom,
        'collateralAddressOrDenom (mToken address) required for M0PortalLite',
      );
      return new M0PortalLiteTokenAdapter(
        multiProvider,
        token.chainName,
        token.addressOrDenom,
        token.collateralAddressOrDenom,
      );
    },
  );

  registerCollateralTokenAdapterFactories(
    [ProtocolType.Tron],
    ({ chainName, multiProvider, tokenAddress }) =>
      new EvmTokenAdapter(chainName, multiProvider, { token: tokenAddress }),
  );
}
