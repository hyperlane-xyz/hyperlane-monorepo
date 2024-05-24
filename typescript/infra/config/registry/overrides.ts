import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

import { MergedRegistry, PartialRegistry } from '@hyperlane-xyz/registry';
import { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';
import { objMerge } from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../../src/config/environment.js';

import { getRegistry } from './registry.js';

let registryWithOverrides: MergedRegistry;

export function getRegistryWithOverrides(
  chainMetadataOverrides: ChainMap<Partial<ChainMetadata>>,
): MergedRegistry {
  if (registryWithOverrides) {
    return registryWithOverrides;
  }

  const baseRegistry = getRegistry();

  const overrideRegistry = new PartialRegistry({
    chainMetadata: chainMetadataOverrides,
  });

  registryWithOverrides = new MergedRegistry({
    registries: [baseRegistry, overrideRegistry],
  });
  return registryWithOverrides;
}
