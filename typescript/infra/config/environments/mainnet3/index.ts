import { ChainName } from '@hyperlane-xyz/sdk';

import {
  getKeysForRole,
  getMultiProtocolProvider,
  getMultiProviderForRole,
} from '../../../scripts/agent-utils.js';
import { EnvironmentConfig } from '../../../src/config/environment.js';
import { Role } from '../../../src/roles.js';
import { Contexts } from '../../contexts.js';

import { agents } from './agent.js';
import { environment as environmentName, getRegistry } from './chains.js';
import { core } from './core.js';
import { keyFunderConfig } from './funding.js';
import { helloWorld } from './helloworld.js';
import { igp } from './igp.js';
import { infrastructure } from './infrastructure.js';
import { bridgeAdapterConfigs, relayerConfig } from './liquidityLayer.js';
import { chainOwners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';
import { checkWarpDeployConfig } from './warp/checkWarpDeploy.js';

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
    chains?: ChainName[],
  ) => {
    const providerChains =
      chains && chains.length > 0 ? chains : supportedChainNames;
    return getMultiProviderForRole(
      environmentName,
      providerChains,
      await getRegistry(useSecrets, providerChains),
      context,
      role,
      undefined,
    );
  },
  getKeys: (
    context: Contexts = Contexts.Hyperlane,
    role: Role = Role.Deployer,
  ) => getKeysForRole(environmentName, supportedChainNames, context, role),
  agents,
  core,
  igp,
  owners: chainOwners,
  infra: infrastructure,
  helloWorld,
  keyFunderConfig,
  checkWarpDeployConfig,
  liquidityLayerConfig: {
    bridgeAdapters: bridgeAdapterConfigs,
    relayer: relayerConfig,
  },
};
