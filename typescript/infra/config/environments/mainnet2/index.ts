import { AgentConnectionType } from '@hyperlane-xyz/sdk';

import { getMultiProviderForRole } from '../../../scripts/utils';
import { KEY_ROLE_ENUM } from '../../../src/agents/roles';
import { EnvironmentConfig } from '../../../src/config';
import { Contexts } from '../../contexts';

import { agents } from './agent';
import { environment as environmentName, mainnetConfigs } from './chains';
import { core } from './core';
import { keyFunderConfig } from './funding';
import { storageGasOracleConfig } from './gas-oracle';
import { helloWorld } from './helloworld';
import { igp } from './igp';
import { infrastructure } from './infrastructure';
import { bridgeAdapterConfigs, relayerConfig } from './liquidityLayer';
import { owners } from './owners';

export const environment: EnvironmentConfig = {
  environment: environmentName,
  chainMetadataConfigs: mainnetConfigs,
  getMultiProvider: (
    context: Contexts = Contexts.Hyperlane,
    role: KEY_ROLE_ENUM = KEY_ROLE_ENUM.Deployer,
    connectionType?: AgentConnectionType,
  ) =>
    getMultiProviderForRole(
      mainnetConfigs,
      environmentName,
      context,
      role,
      undefined,
      connectionType,
    ),
  agents,
  core,
  igp,
  owners,
  infra: infrastructure,
  helloWorld,
  keyFunderConfig,
  storageGasOracleConfig,
  liquidityLayerConfig: {
    bridgeAdapter: bridgeAdapterConfigs,
    relayer: relayerConfig,
  },
};
