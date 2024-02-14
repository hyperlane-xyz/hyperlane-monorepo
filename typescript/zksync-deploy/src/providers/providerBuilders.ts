import { Provider } from 'zksync-ethers';

import { ChainMetadata, RpcUrl } from '../metadata/chainMetadataTypes';
import { ProtocolType } from '../types';

import {
  ProviderType,
  TypedProvider,
  zksynceraEthersV5Provider,
} from './ProviderType';
import { HyperlaneSmartProvider } from './SmartProvider/SmartProvider';
import { ProviderRetryOptions } from './SmartProvider/types';

export type ProviderBuilderFn<P> = (
  rpcUrls: ChainMetadata['rpcUrls'],
  network: number | string,
  retryOverride?: ProviderRetryOptions,
) => P;
export type TypedProviderBuilderFn = ProviderBuilderFn<TypedProvider>;

const DEFAULT_RETRY_OPTIONS: ProviderRetryOptions = {
  maxRetries: 3,
  baseRetryDelayMs: 250,
};

export function zksynceraEthersV5ProviderBuilder(
  rpcUrls: RpcUrl[],
  network: number | string,
  retryOverride?: ProviderRetryOptions,
): zksynceraEthersV5Provider {
  const provider = new HyperlaneSmartProvider(
    network,
    rpcUrls,
    undefined,
    retryOverride || DEFAULT_RETRY_OPTIONS,
  );
  return { type: ProviderType.zksynceraEthersV5, provider };
}

// Kept for backwards compatibility
export function defaultProviderBuilder(
  rpcUrls: RpcUrl[],
  _network: number | string,
): Provider {
  return zksynceraEthersV5ProviderBuilder(rpcUrls, _network).provider;
}

export type ProviderBuilderMap = Record<
  ProviderType,
  ProviderBuilderFn<TypedProvider>
>;
export const defaultProviderBuilderMap: ProviderBuilderMap = {
  [ProviderType.zksynceraEthersV5]: zksynceraEthersV5ProviderBuilder,
};

export const protocolToDefaultProviderBuilder: Record<
  ProtocolType,
  ProviderBuilderFn<TypedProvider>
> = {
  [ProtocolType.Zksyncera]: zksynceraEthersV5ProviderBuilder,
};
