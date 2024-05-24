import { IRegistry } from '@hyperlane-xyz/registry';
import { RpcConsensusType } from '@hyperlane-xyz/sdk';
import { objMerge } from '@hyperlane-xyz/utils';

import {
  getKeysForRole,
  getMultiProviderForRole,
} from '../../../scripts/agent-utils.js';
import {
  getRegistryForEnvironment,
  getSecretMetadataOverrides,
} from '../../../src/config/chain.js';
import { EnvironmentConfig } from '../../../src/config/environment.js';
import { Role } from '../../../src/roles.js';
import { Contexts } from '../../contexts.js';
import { getRegistryWithOverrides } from '../../registry/overrides.js';

import { agents } from './agent.js';
import {
  chainMetadataOverrides,
  environment as environmentName,
  testnetConfigs,
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

const getRegistry = async (useSecrets = true): Promise<IRegistry> =>
  getRegistryForEnvironment(
    environmentName,
    supportedChainNames,
    chainMetadataOverrides,
    useSecrets,
  );

export const environment: EnvironmentConfig = {
  environment: environmentName,
  supportedChainNames,
  getRegistry,
  // chainMetadataConfigs: testnetConfigs,
  getMultiProvider: async (
    context: Contexts = Contexts.Hyperlane,
    role: Role = Role.Deployer,
    connectionType?: RpcConsensusType,
  ) =>
    getMultiProviderForRole(
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
  ) => getKeysForRole(testnetConfigs, environmentName, context, role),
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
