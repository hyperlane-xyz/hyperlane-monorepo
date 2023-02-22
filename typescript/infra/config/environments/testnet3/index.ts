import { getMultiProviderForRole } from '../../../scripts/utils';
import { KEY_ROLE_ENUM } from '../../../src/agents/roles';
import { CoreEnvironmentConfig } from '../../../src/config';
import { ConnectionType } from '../../../src/config/agent';
import { Contexts } from '../../contexts';

import { agents } from './agent';
import { environment as environmentName, testnetConfigs } from './chains';
import { core } from './core';
import { keyFunderConfig } from './funding';
import { helloWorld } from './helloworld';
import { infrastructure } from './infrastructure';
import { liquidityLayerRelayerConfig } from './middleware';

export const environment: CoreEnvironmentConfig = {
  environment: environmentName,
  chainMetadataConfigs: testnetConfigs,
  getMultiProvider: (
    context: Contexts = Contexts.Hyperlane,
    role: KEY_ROLE_ENUM = KEY_ROLE_ENUM.Deployer,
    connectionType?: ConnectionType,
  ) =>
    getMultiProviderForRole(
      testnetConfigs,
      environmentName,
      context,
      role,
      undefined,
      connectionType,
    ),
  agents,
  core,
  infra: infrastructure,
  helloWorld,
  keyFunderConfig,
  liquidityLayerRelayerConfig,
};
