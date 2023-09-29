import { RpcConsensusType } from '@hyperlane-xyz/sdk';

import {
  getKeysForRole,
  getMultiProviderForRole,
} from '../../../scripts/utils';
import { EnvironmentConfig } from '../../../src/config';
import { Role } from '../../../src/roles';
import { Contexts } from '../../contexts';

import { agents } from './agent';
import { environment as environmentName, testnetConfigs } from './chains';
import { core } from './core';
import { keyFunderConfig } from './funding';
import { storageGasOracleConfig } from './gas-oracle';
import { helloWorld } from './helloworld';
import { igp } from './igp';
import { infrastructure } from './infrastructure';
import { bridgeAdapterConfigs } from './liquidityLayer';
import { liquidityLayerRelayerConfig } from './middleware';
import { owners } from './owners';

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
  storageGasOracleConfig,
};
