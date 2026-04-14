import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import {
  defaultEthersV5ProviderBuilder,
  defaultGnosisTxBuilderProviderBuilder,
} from '../providers/builders/ethersV5.js';
import { defaultViemProviderBuilder } from '../providers/builders/viem.js';
import { defaultZKSyncProviderBuilder } from '../providers/builders/zksync.js';
import { ProviderType } from '../providers/ProviderType.js';
import { registerProviderBuilders } from '../providers/providerBuilderRegistry.js';
import {
  EvmNativeTokenAdapter,
  EvmTokenAdapter,
} from '../token/adapters/EvmTokenAdapter.js';
import { M0PortalLiteTokenAdapter } from '../token/adapters/M0PortalLiteTokenAdapter.js';
import { M0PortalTokenAdapter } from '../token/adapters/M0PortalTokenAdapter.js';
import { createEvmHypAdapter } from '../token/adapters/evmHyp.js';
import {
  registerCollateralTokenAdapterFactories,
  registerHypTokenAdapterFactories,
  registerTokenAdapterFactories,
} from '../token/adapters/registry.js';
import { TokenStandard } from '../token/TokenStandard.js';

export function registerEvmRuntimeAdapters(): void {
  registerProviderBuilders({
    [ProviderType.EthersV5]: defaultEthersV5ProviderBuilder,
    [ProviderType.GnosisTxBuilder]: defaultGnosisTxBuilderProviderBuilder,
    [ProviderType.Viem]: defaultViemProviderBuilder,
    [ProviderType.ZkSync]: defaultZKSyncProviderBuilder,
  });

  registerTokenAdapterFactories(
    [TokenStandard.ERC20],
    ({ multiProvider, token }) =>
      new EvmTokenAdapter(token.chainName, multiProvider, {
        token: token.addressOrDenom,
      }),
  );

  registerTokenAdapterFactories(
    [TokenStandard.EvmNative],
    ({ multiProvider, token }) =>
      new EvmNativeTokenAdapter(token.chainName, multiProvider, {}),
  );

  registerHypTokenAdapterFactories(
    [
      TokenStandard.EvmNative,
      TokenStandard.EvmHypNative,
      TokenStandard.EvmHypCollateral,
      TokenStandard.EvmHypOwnerCollateral,
      TokenStandard.EvmHypRebaseCollateral,
      TokenStandard.EvmHypCollateralFiat,
      TokenStandard.EvmHypSynthetic,
      TokenStandard.EvmHypSyntheticRebase,
      TokenStandard.EvmHypXERC20,
      TokenStandard.EvmHypXERC20Lockbox,
      TokenStandard.EvmHypVSXERC20,
      TokenStandard.EvmHypVSXERC20Lockbox,
      TokenStandard.EvmHypCrossCollateralRouter,
    ],
    ({ multiProvider, token }) => createEvmHypAdapter(multiProvider, token),
  );

  registerHypTokenAdapterFactories(
    [TokenStandard.EvmM0PortalLite],
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

  registerHypTokenAdapterFactories(
    [TokenStandard.EvmM0Portal],
    ({ multiProvider, token }) => {
      assert(
        token.collateralAddressOrDenom,
        'collateralAddressOrDenom (mToken address) required for M0Portal',
      );
      return new M0PortalTokenAdapter(
        multiProvider,
        token.chainName,
        token.addressOrDenom,
        token.collateralAddressOrDenom,
      );
    },
  );

  registerCollateralTokenAdapterFactories(
    [ProtocolType.Ethereum],
    ({ chainName, multiProvider, tokenAddress }) =>
      new EvmTokenAdapter(chainName, multiProvider, { token: tokenAddress }),
  );
}
