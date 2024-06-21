import { IRegistry } from '@hyperlane-xyz/registry';

import {
  getKeysForRole,
  getMultiProtocolProvider,
  getMultiProviderForRole,
} from '../../../scripts/agent-utils.js';
import { getRegistryForEnvironment } from '../../../src/config/chain.js';
import { EnvironmentConfig } from '../../../src/config/environment.js';
import { Role } from '../../../src/roles.js';
import { Contexts } from '../../contexts.js';

import { agents } from './agent.js';
import {
  chainMetadataOverrides,
  environment as environmentName,
  getRegistry,
} from './chains.js';
import { core } from './core.js';
import { keyFunderConfig } from './funding.js';
import { helloWorld } from './helloworld.js';
import { igp } from './igp.js';
import { infrastructure } from './infrastructure.js';
import { bridgeAdapterConfigs, relayerConfig } from './liquidityLayer.js';
import { owners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';

export const environment: EnvironmentConfig = {
  environment: environmentName,
  supportedChainNames,
  getRegistry,
  getMultiProtocolProvider: async () =>
    getMultiProtocolProvider(await getRegistry()),
  getMultiProvider: async (
    context: Contexts = Contexts.Hyperlane,
    role: Role = Role.Deployer,
    useSecrets?: boolean,
  ) =>
    getMultiProviderForRole(
      environmentName,
      await getRegistry(useSecrets),
      context,
      role,
      undefined,
    ),
  getKeys: (
    context: Contexts = Contexts.Hyperlane,
    role: Role = Role.Deployer,
  ) => getKeysForRole(environmentName, supportedChainNames, context, role),
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
