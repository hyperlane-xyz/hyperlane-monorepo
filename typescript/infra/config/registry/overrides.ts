import { MergedRegistry, PartialRegistry } from '@hyperlane-xyz/registry';

import { metadataOverrides as mainnet3MetadataOverrides } from '../environments/mainnet3/metadataOverrides.js';

import { getRegistry } from './registry.js';

let registryWithOverrides: MergedRegistry;

export async function getRegistryWithOverrides(): Promise<MergedRegistry> {
  if (registryWithOverrides) {
    return registryWithOverrides;
  }

  const baseRegistry = getRegistry();

  const metadataOverrides = {
    ...mainnet3MetadataOverrides,
  };

  const overrideRegistry = new PartialRegistry({
    chainMetadata: metadataOverrides,
  });

  registryWithOverrides = new MergedRegistry({
    registries: [baseRegistry, overrideRegistry],
  });
  return registryWithOverrides;
}
