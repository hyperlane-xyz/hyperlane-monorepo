import { RpcConsensusType } from '@hyperlane-xyz/sdk';

import {
  getKeysForRole,
  getMultiProviderForRole,
} from '../../../scripts/agent-utils.js';
import { EnvironmentConfig } from '../../../src/config/environment.js';
import { Role } from '../../../src/roles.js';
import { Contexts } from '../../contexts.js';

import { agents } from './agent.js';
import { environment as environmentName, testnetConfigs } from './chains.js';
import { core } from './core.js';
import { keyFunderConfig } from './funding.js';
import { helloWorld } from './helloworld.js';
import { igp } from './igp.js';
import { infrastructure } from './infrastructure.js';
import { bridgeAdapterConfigs } from './liquidityLayer.js';
import { liquidityLayerRelayerConfig } from './middleware.js';
import { owners } from './owners.js';

export const environment: EnvironmentConfig = {
  environment: environmentName,
  chainMetadataConfigs: testnetConfigs,
  getMultiProvider: (
    context: Contexts = Contexts.Hyperlane,
    role: Role = Role.Deployer,
    connectionType?: RpcConsensusType,
  ) =>
    getMultiProviderForRole(
      testnetConfigs,
      environmentName,
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
