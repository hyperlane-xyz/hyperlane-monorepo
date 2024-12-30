import { IRegistry } from '@hyperlane-xyz/registry';
import { ChainName } from '@hyperlane-xyz/sdk';

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
} from './chains.js';
import { core } from './core.js';
import { keyFunderConfig } from './funding.js';
import { helloWorld } from './helloworld.js';
import { igp } from './igp.js';
import { infrastructure } from './infrastructure.js';
import { bridgeAdapterConfigs } from './liquidityLayer.js';
import { liquidityLayerRelayerConfig } from './middleware.js';
import { owners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';

const getRegistry = async (
  useSecrets = true,
  chains: ChainName[] = supportedChainNames,
): Promise<IRegistry> =>
  getRegistryForEnvironment(
    environmentName,
    chains,
    chainMetadataOverrides,
    useSecrets,
  );

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
  infra: infrastructure,
  helloWorld,
  owners,
  keyFunderConfig,
  liquidityLayerConfig: {
    bridgeAdapters: bridgeAdapterConfigs,
    relayer: liquidityLayerRelayerConfig,
  },
};
