import { RpcConsensusType } from '@hyperlane-xyz/sdk';

import {
  getKeysForRole,
  getMultiProviderForRole,
} from '../../../scripts/utils';
import { EnvironmentConfig } from '../../../src/config';
import { Role } from '../../../src/roles';
import { Contexts } from '../../contexts';

import { agents } from './agent';
import { environment as environmentName, mainnetConfigs } from './chains';
import { core } from './core';
import { keyFunderConfig } from './funding';
import { helloWorld } from './helloworld';
import { infrastructure } from './infrastructure';
import { bridgeAdapterConfigs, relayerConfig } from './liquidityLayer';
import { owners } from './owners';

export const environment: EnvironmentConfig = {
  environment: environmentName,
  chainMetadataConfigs: mainnetConfigs,
  getMultiProvider: (
    context: Contexts = Contexts.Hyperlane,
    role: Role = Role.Deployer,
    connectionType?: RpcConsensusType,
  ) =>
    getMultiProviderForRole(
      mainnetConfigs,
      environmentName,
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
  owners,
  infra: infrastructure,
  helloWorld,
  keyFunderConfig,
  liquidityLayerConfig: {
    bridgeAdapters: bridgeAdapterConfigs,
    relayer: relayerConfig,
  },
};
