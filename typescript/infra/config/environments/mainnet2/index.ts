import { AgentConnectionType } from '@hyperlane-xyz/sdk';

import { getMultiProviderForRole } from '../../../scripts/utils';
import { KeyRole } from '../../../src/agents/roles';
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
    role: KeyRole = KeyRole.Deployer,
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
    bridgeAdapters: bridgeAdapterConfigs,
    relayer: relayerConfig,
  },
};
