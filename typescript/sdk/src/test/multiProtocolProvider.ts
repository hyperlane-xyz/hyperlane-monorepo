import { ProtocolType } from '@hyperlane-xyz/utils';

import { multiProtocolTestChainMetadata } from '../consts/testChains.js';
import type { ChainMetadata } from '../metadata/chainMetadataTypes.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import type { TypedProvider } from '../providers/ProviderType.js';
import type { ChainMap } from '../types.js';

export function createTestMultiProtocolProvider(
  metadata?: typeof multiProtocolTestChainMetadata,
  providers?: Partial<Record<ProtocolType, TypedProvider>>,
): MultiProtocolProvider;
export function createTestMultiProtocolProvider<MetaExt>(
  metadata: ChainMap<ChainMetadata<MetaExt>>,
  providers?: Partial<Record<ProtocolType, TypedProvider>>,
): MultiProtocolProvider<MetaExt>;
export function createTestMultiProtocolProvider<MetaExt = {}>(
  metadata:
    | typeof multiProtocolTestChainMetadata
    | ChainMap<ChainMetadata<MetaExt>> = multiProtocolTestChainMetadata,
  providers: Partial<Record<ProtocolType, TypedProvider>> = {},
): MultiProtocolProvider | MultiProtocolProvider<MetaExt> {
  // CAST: the generic overload now requires callers to supply matching
  // metadata. The shared implementation still handles the non-generic
  // default-fixture overload through the same code path.
  const mp = new MultiProtocolProvider<MetaExt>(
    metadata as ChainMap<ChainMetadata<MetaExt>>,
  );
  const providerMap: ChainMap<TypedProvider> = {};
  for (const [protocol, provider] of Object.entries(providers)) {
    if (!provider) continue;
    const chains = Object.values(metadata).filter(
      (chainMetadata) => chainMetadata.protocol === protocol,
    );
    chains.forEach((chainMetadata) => {
      providerMap[chainMetadata.name] = provider;
    });
  }
  mp.setProviders(providerMap);
  return mp;
}
