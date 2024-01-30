import { ChainMetadata, RpcConsensusType } from '@hyperlane-xyz/sdk';
import { ProtocolType, objFilter } from '@hyperlane-xyz/utils';

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
    role: Role = Role.Deployer,
    connectionType?: RpcConsensusType,
  ) => {
    const config = objFilter(
      mainnetConfigs,
      (_, chainMetadata): chainMetadata is ChainMetadata =>
        chainMetadata.protocol === ProtocolType.Ethereum,
    );

    return getMultiProviderForRole(
      config,
      environmentName,
      context,
      role,
      undefined,
      connectionType,
    );
  },
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
  storageGasOracleConfig,
  liquidityLayerConfig: {
    bridgeAdapters: bridgeAdapterConfigs,
    relayer: relayerConfig,
  },
};
