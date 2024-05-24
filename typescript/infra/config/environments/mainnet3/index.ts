import { IRegistry } from '@hyperlane-xyz/registry';
import { ChainMetadata, RpcConsensusType } from '@hyperlane-xyz/sdk';
import { ProtocolType, objFilter, objMerge } from '@hyperlane-xyz/utils';

import {
  getKeysForRole,
  getMultiProviderForRole,
  getMultiProviderForRoleNew,
} from '../../../scripts/agent-utils.js';
import { getSecretMetadataOverrides } from '../../../src/config/chain.js';
import { EnvironmentConfig } from '../../../src/config/environment.js';
import { Role } from '../../../src/roles.js';
import { Contexts } from '../../contexts.js';
import { getRegistryWithOverrides } from '../../registry/overrides.js';

import { agents } from './agent.js';
import {
  chainMetadataOverrides,
  environment as environmentName,
  mainnetConfigs,
} from './chains.js';
import { core } from './core.js';
import { keyFunderConfig } from './funding.js';
import { helloWorld } from './helloworld.js';
import { igp } from './igp.js';
import { infrastructure } from './infrastructure.js';
import { bridgeAdapterConfigs, relayerConfig } from './liquidityLayer.js';
import { owners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';

export async function getRegistry(
  useSecrets: boolean = true,
): Promise<IRegistry> {
  let overrides = chainMetadataOverrides;
  if (useSecrets) {
    overrides = objMerge(
      overrides,
      await getSecretMetadataOverrides(environmentName, supportedChainNames),
    );
  }
  const registry = getRegistryWithOverrides(overrides);
  return registry;
}

export const environment: EnvironmentConfig = {
  environment: environmentName,
  supportedChainNames,
  getRegistry,
  getMultiProvider: async (
    context: Contexts = Contexts.Hyperlane,
    role: Role = Role.Deployer,
    connectionType?: RpcConsensusType,
  ) =>
    getMultiProviderForRoleNew(
      environmentName,
      await getRegistry(),
      context,
      role,
      undefined,
      connectionType,
    ),
  getKeys: (
    context: Contexts = Contexts.Hyperlane,
    role: Role = Role.Deployer,
  ) => getKeysForRole(mainnetConfigs, environmentName, context, role),
  agents,
  core,
  igp,
  owners,
  infra: infrastructure,
  helloWorld,
  keyFunderConfig,
  liquidityLayerConfig: {
    bridgeAdapters: bridgeAdapterConfigs,
    relayer: relayerConfig,
  },
};
